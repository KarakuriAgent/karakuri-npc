# karakuri-npc システム設計書

karakuri-world に接続する LLM 駆動 NPC の管理・実行システム。
1 プロセスで複数の NPC を稼働させ、WebUI から作成・編集・監視を行う。

- 対象 world: `karakuri-world`（`agent_kind: 'npc'`、webhook 通知、`/api/npc/*` API）
- 本書は初期実装（v1）のスコープを定義する。

---

## 1. 概要と責務分担

```
┌────────────────────────┐          ┌─────────────────────────────┐
│      karakuri-world     │          │        karakuri-npc          │
│  (ワールドサーバー)       │          │      (本プロジェクト)          │
│                        │  webhook  │                             │
│  通知発火 ──────────────┼──────────▶ POST /webhook (署名検証・即200)│
│                        │          │   │                          │
│  GET /api/npc/         │◀─────────┼── 通知詳細フェッチ              │
│    notifications/:id   │          │   │                          │
│                        │          │   ▼                          │
│  POST /api/npc/command │◀─────────┼── NPCランタイム                │
│  POST /api/npc/login   │          │   (移動プランナ / 会話エンジン /  │
│  POST /api/npc/logout  │          │    transferポリシー / 記憶)     │
│                        │          │   │            ▲             │
│  NPC作成・APIキー発行     │          │   ▼            │             │
│  (world側WebUI/admin)   │          │  SQLite      LLM API         │
└────────────────────────┘          │                │             │
                                    │  WebUI (React) ─┘             │
                                    └─────────────────────────────┘
```

| 責務 | 担当 |
|---|---|
| NPC エージェントの world への登録・API キー / webhook secret 発行 | **karakuri-world**（admin が world 側 WebUI / Discord コマンドで実施） |
| NPC の人格・移動・会話・記憶・アイテム判断 | **karakuri-npc** |
| 状態遷移・タイマー・会話ターン管理・エスクロー | **karakuri-world** |
| NPC の稼働管理（ログイン維持）・監視 WebUI | **karakuri-npc** |

## 2. 前提: karakuri-world 側インターフェース（調査済み事実）

- **NPC 専用 API**（Bearer 認証 = NPC ごとの `api_key`）
  - `POST /api/npc/login` — 任意ボディ `{ node_id?, world_id? }`。位置指定ログインは 10 分クールダウン（429 `rate_limited`、`details.retry_after_seconds`）。不正ノードは 400（`out_of_bounds` / `impassable_node`）でフォールバックなし
  - `POST /api/npc/logout`
  - `GET /api/npc/notifications/:notification_id` — 保存済み通知 JSON（retry-safe / idempotent、TTL 30 分）
  - `POST /api/npc/command` — `{ notification_id, command, params }`。**1 通知につき最大 1 コマンド**
- **通知 webhook**: world → `webhook_url` へ POST。ボディ `{ notification_id, agent_id, kind, triggered_at }`。
  ヘッダー `Authorization: Bearer {webhook_secret}` / `X-Karakuri-Npc-Signature: sha256={HMAC-SHA256(body)}` / `X-Karakuri-Npc-Delivery-Id`。
  **タイムアウト 5 秒・最大 2 回試行・以降の再送なし**。`webhook_url` は https 必須・localhost / プライベート IP 不可
- **通知 JSON**（`AgentNotificationV1`）: `{ schema_version: 1, kind, summary, choices[], payload?, perception? }`。
  `choices[]` = `{ command, label, params?, required_params?, param_schema? }`。perception に現在地・周辺エージェント/NPC/建物・時刻・天気・所持金等
- **NPC が使えるコマンド**（`NPC_ALLOWED_COMMANDS`）: `move` / `wait` / `transfer` / `transfer_accept` / `transfer_reject` / `conversation_accept` / `_join` / `_stay` / `_leave` / `_reject` / `_speak` / `_end` / `get_status` / `get_perception` / `get_map` / `get_nearby_agents` / `get_active_conversations`。
  **`conversation_start` / `action` / `use_item` / `travel` は不可**（NPC からは話しかけられない）
- **会話**: 招待制グループ会話（最大 5 人）、次話者指名制、`max_turns: 20`、ターン応答期限 10 分、`inactive_check` あり。会話中のアイテム授受は `conversation_speak` の `transfer` 添付 / `transfer_response: accept|reject`
- **単独 transfer**: `transfer {target_agent_id, item|money}`（隣接必須・エスクロー・応答期限 10 分）
- **info コマンドの制約**: idle かつ pending なしのときだけ受理。受理後は実行系コマンドが通るまで choices から消える
- **idle_reminder**: idle が続くと 10 分間隔（world 設定）で通知が来る。行動ループの保険になる
- **NPC は所属ワールド固定**（travel 不可、world 側 NPC 設定の `world_id`）

## 3. 技術スタック

karakuri-world と揃え、運用知識を共有する。

| 層 | 技術 |
|---|---|
| ランタイム | Node.js 20+ / TypeScript / ESM |
| サーバー | Hono（webhook 受信 + WebUI 向け API + 静的配信） |
| DB | SQLite（better-sqlite3、`${DATA_DIR}/npc.sqlite`） |
| フロント | React + Vite + Tailwind CSS（状態管理は React ローカル state で足りる規模） |
| LLM | プロバイダ抽象。**OpenAI 互換 API をデフォルト**（LiteLLM proxy / Ollama 等に接続可）、Anthropic ネイティブも実装 |
| バリデーション | Zod |
| テスト | Vitest |

monorepo（npm workspaces）:

```
karakuri-npc/
├── apps/
│   ├── server/          # @karakuri-npc/server  本体（webhook / ランタイム / API）
│   └── web/             # @karakuri-npc/web     WebUI（ビルド成果物を server が配信）
├── docs/design/
└── package.json
```

## 4. データモデル（SQLite）

```sql
-- NPC 定義（WebUI で作成・編集）
CREATE TABLE npcs (
  npc_id            TEXT PRIMARY KEY,          -- 内部ID (uuid)
  name              TEXT NOT NULL,             -- 表示名（world側 agent_name と一致させる運用）
  enabled           INTEGER NOT NULL DEFAULT 0,-- 稼働フラグ（ON でログイン維持対象）
  -- world 接続情報（world 側で発行された値を貼り付け。ベース URL は .env の WORLD_BASE_URL で全 NPC 共通）
  agent_id          TEXT NOT NULL UNIQUE,      -- world 側 npc-{uuid}
  api_key           TEXT NOT NULL,
  webhook_secret    TEXT NOT NULL,
  -- 行動設定
  persona           TEXT NOT NULL DEFAULT '',  -- 役割・口調などの system prompt 素材
  rules             TEXT NOT NULL DEFAULT '',  -- 必ず守るルール（system prompt で最優先扱い）
  home_node_id      TEXT,                      -- 開始位置（ログイン時に node_id 指定）
  movement_json     TEXT NOT NULL DEFAULT '{}',-- MovementConfig（下記）
  conversation_json TEXT NOT NULL DEFAULT '{}',-- ConversationPolicy（下記）
  transfer_json     TEXT NOT NULL DEFAULT '{}',-- TransferPolicy（下記）
  llm_json          TEXT NOT NULL DEFAULT '{}',-- LlmConfig（モデル・温度等の上書き）
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- ランタイム状態ミラー（world をポーリングできないため通知/レスポンスから更新）
CREATE TABLE npc_runtime (
  npc_id            TEXT PRIMARY KEY REFERENCES npcs(npc_id),
  logged_in         INTEGER NOT NULL DEFAULT 0,
  world_id          TEXT,
  node_id           TEXT,
  agent_state       TEXT,                      -- idle/moving/in_conversation/in_transfer (推定値)
  money             INTEGER,
  items_json        TEXT,
  last_notification_at INTEGER,
  last_command_at   INTEGER,
  last_error        TEXT,
  status_synced_at  INTEGER                    -- get_status で最後に正確に同期した時刻
);

-- webhook 受信ログ（冪等性 + 再処理 + ダッシュボード）
CREATE TABLE deliveries (
  delivery_id       TEXT PRIMARY KEY,          -- X-Karakuri-Npc-Delivery-Id
  npc_id            TEXT NOT NULL,
  notification_id   TEXT NOT NULL,
  kind              TEXT NOT NULL,
  received_at       INTEGER NOT NULL,
  status            TEXT NOT NULL,             -- received / processing / done / failed / skipped
  error             TEXT,
  notification_json TEXT                       -- フェッチした通知全文（デバッグ用）
);

-- 実行したコマンドのログ
CREATE TABLE command_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  npc_id            TEXT NOT NULL,
  notification_id   TEXT,
  command           TEXT NOT NULL,
  params_json       TEXT NOT NULL,
  accepted          INTEGER NOT NULL,
  result_json       TEXT,
  error             TEXT,
  executed_at       INTEGER NOT NULL
);

-- 会話（world の conversation_id 単位）
CREATE TABLE conversations (
  conversation_id   TEXT NOT NULL,
  npc_id            TEXT NOT NULL,
  participants_json TEXT NOT NULL,             -- [{agent_id, agent_name}]
  status            TEXT NOT NULL,             -- active / ended
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  end_reason        TEXT,
  summarized        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, npc_id)
);

CREATE TABLE conversation_messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id   TEXT NOT NULL,
  npc_id            TEXT NOT NULL,
  turn              INTEGER,
  -- 通知 payload は名前ベースで agent_id を特定できないことがあるため NULL 許容
  speaker_agent_id  TEXT,
  speaker_name      TEXT,
  is_self           INTEGER NOT NULL DEFAULT 0, -- 自 NPC の発言か（プロンプトの role 振り分け用）
  message           TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);

-- 簡易記憶: NPC × 相手エージェント単位の要約
CREATE TABLE memories (
  npc_id            TEXT NOT NULL,
  counterpart_agent_id TEXT NOT NULL,
  counterpart_name  TEXT,
  summary           TEXT NOT NULL,             -- LLM が更新する累積要約（上限 ~1000字）
  conversation_count INTEGER NOT NULL DEFAULT 0,
  last_talked_at    INTEGER,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (npc_id, counterpart_agent_id)
);

CREATE TABLE settings (                        -- グローバル設定 (LLM 資格情報等)
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
```

### 4.1 設定 JSON の型

```ts
interface MovementConfig {
  mode: 'random' | 'stationary';
  // random 時の移動範囲 = 「次の移動先を選ぶ範囲」。アンカー中心の矩形
  anchor_node_id?: string;      // 省略時は home_node_id、それも無ければ現在地
  range: { rows: number; cols: number }; // アンカー±range の矩形
  move_probability: number;     // idle 契機ごとに移動する確率 0..1（既定 0.5）
  rest_duration: number;        // 移動しなかったときの wait 単位（10分単位、既定 1）
}

interface ConversationPolicy {
  accept: 'always' | 'llm' | 'never';   // 着信時の受諾判断（既定 always）
  inactive_check: 'stay' | 'leave' | 'llm'; // 既定 stay
  max_history_pairs: number;            // LLM に渡す直近往復数（既定 15）
}

interface TransferPolicy {
  receive: 'always_accept' | 'always_reject' | 'llm'; // 既定 always_accept
  give_enabled: boolean;                // 会話中に LLM 判断でアイテム/お金を渡せるか（既定 true）
}

interface LlmConfig {
  provider?: 'openai_compatible' | 'anthropic'; // 省略時グローバル設定
  model?: string;
  temperature?: number;
  system_prompt_extra?: string;
}
```

## 5. サーバー構成（apps/server）

```
src/
├── index.ts                 # 起動: config → storage → runtime → Hono
├── config.ts                # env 読み込み (Zod)
├── webhook/
│   └── receiver.ts          # POST /webhook 署名検証・dedupe・キュー投入・即200
├── world/
│   ├── client.ts            # /api/npc/* の薄い SDK（fetch, エラー正規化）
│   └── types.ts             # 通知 / choices / コマンドの型（world の型と同形）
├── runtime/
│   ├── manager.ts           # NpcManager: NPC ごとの NpcRuntime 生成・稼働管理・自動再ログイン
│   ├── npc-runtime.ts       # 1 NPC = 1 アクター。通知を直列処理する per-NPC キュー
│   ├── handlers/            # kind 別ハンドラ（下記 §6）
│   │   ├── lifecycle.ts     # agent_logged_in/out, idle_reminder
│   │   ├── movement.ts      # movement_completed, wait_completed
│   │   ├── conversation.ts  # conversation_*
│   │   └── transfer.ts      # transfer_*
│   ├── movement-planner.ts  # ランダム移動先の決定
│   ├── conversation-engine.ts # LLM 応答生成・次話者選択・終了判断
│   ├── memory.ts            # 記憶の読み書き・会話終了時の要約ジョブ
│   └── state-mirror.ts      # npc_runtime テーブル更新（通知/レスポンス起点）
├── llm/
│   ├── provider.ts          # generate(messages, {json_schema?}) 抽象
│   ├── openai-compatible.ts
│   └── anthropic.ts
├── api/                     # WebUI 向け REST（§8）
└── storage/                 # SQLite ラッパ・マイグレーション
```

### 5.1 webhook 受信フロー

1. `POST /webhook` 受信（パスは 1 本。NPC の振り分けはボディの `agent_id`）
2. `agent_id` → npcs 行を引き、`webhook_secret` で HMAC を **timing-safe** に検証（`Authorization` ヘッダーも一致確認）。不一致は 401
3. `delivery_id` で dedupe（既知なら 200 を返して終了）
4. `deliveries` に `received` で INSERT → **即 200 を返す**（world 側タイムアウトは 5 秒。LLM 処理は絶対に同期でやらない）
5. per-NPC キューへ投入

### 5.2 通知処理（NpcRuntime、NPC ごとに直列）

1. `GET /api/npc/notifications/:id` で通知詳細を取得（`deliveries.notification_json` に保存）
2. `kind` に応じたハンドラへルーティング
3. ハンドラは「choices から 1 つ選ぶ」を原則とし、`POST /api/npc/command` を最大 1 回実行
4. 結果を `command_log` と `state-mirror` に反映

エラー処理:

- `notification_stale`: `details.latest_notification_id` / `latest_notification` を使って最新通知で再決定（1 回だけ。無ければ破棄）
- `state_conflict` / `info_already_consumed`: ログして破棄（次の通知で立て直す）
- `not_logged_in`: ランタイムを logged_out に落とし、自動再ログインへ
- LLM エラー: リトライ（指数バックオフ 3 回）。会話ターンの期限は 10 分あるので十分間に合う。最終失敗時は安全側の定型文で `conversation_speak`（会話を殺さない）
- 再起動リカバリ: 起動時に `deliveries.status IN ('received','processing')` かつ 30 分以内（通知 TTL）のものを再キューイング

## 6. 行動設計（kind 別ハンドラ）

### 6.1 稼働・移動ループ

自発的にコマンドは撃てない（1 通知 1 コマンド）ため、**行動の契機は通知**。移動系の契機（idle 契機）は
`agent_logged_in`（初回通知）/ `movement_completed` / `wait_completed` / `idle_reminder` / `info_choices`（info 実行後の行動選択肢）に加え、
**choices に `move` / `wait` を含む通知全般**（transfer 完了系など）を汎用的に移動プランナへ回す。

```
idle 契機の通知を受信
  ├─ status_synced_at が古い(>30分) → choices に get_status/get_perception があれば同期に消費
  ├─ mode = stationary → wait(rest_duration) ※choices に wait があるときのみ
  └─ mode = random
       ├─ rand() >= move_probability → wait(rest_duration)
       └─ 移動: アンカー±range の矩形から通行可能そうなノードをランダム選択して move
            ・失敗 (invalid_move_target 等) したら別ノードで最大 5 回リトライ
            ・全滅なら wait(1) で見送り
```

- 移動間隔の粒度は world 仕様上 **10 分単位**（wait の最小単位・idle_reminder 間隔）。「数秒ごとにうろうろ」はできない、と WebUI にも明記する
- `move` は BFS 自動経路なので範囲内なら距離があってもよい。範囲 = 「次の移動先を選ぶ範囲」であり行動圏の保証ではない（経路は範囲外を通り得る）

### 6.2 ログイン・開始位置

- `enabled` な NPC は NpcManager が常時ログイン状態を維持（起動時 + 5 分間隔のヘルスループ + `not_logged_in` 検知時）
- ログインは `home_node_id` があれば `{ node_id: home_node_id }` 付きで実行。**429（クールダウン）/ 400 のときは位置指定なしで再ログイン**（前回位置に復帰）
- WebUI から「ホームに戻す」操作 = logout → 位置指定 login（クールダウン中はその旨を表示）

### 6.3 会話（LLM）

| kind | 処理 |
|---|---|
| `conversation_request` | policy.accept に従う。`llm` の場合はペルソナ+記憶で受諾判断。受諾は LLM が挨拶を生成して `conversation_accept {message}`、拒否は `conversation_reject`。payload に initiator と初回メッセージ |
| `conversation_reply`（相手の発言 + 自分が次話者に指名された） | payload の `{conversation_id, turn, speaker_name, message, participants}` を履歴に記録 → LLM 呼び出し → `conversation_speak {message, next_speaker_agent_id}`。LLM が「切り上げるべき」と判断したら `conversation_end {message, next_speaker_agent_id}` |
| `conversation_turn`（発言なしのターン再開通知。inactive_check 解消後など） | 記録済み履歴から LLM 呼び出し → `conversation_speak` / `conversation_end` |
| `conversation_fyi`（他者の発言。自分は次話者でない） | payload を `conversation_messages` に記録のみ |
| `conversation_inactive_check` | policy に従い `conversation_stay` / `conversation_leave` |
| `conversation_closing`（終了あいさつの自分の番） | LLM で短い別れの言葉 → `conversation_speak` |
| `conversation_ended` / `conversation_forced_ended` | conversations を ended に更新 → **記憶要約ジョブ**投入 |
| `conversation_rejected` / `conversation_pending_join_cancelled` | 記録のみ（NPC は start / join を自発実行しないため通常来ない） |
| `server_announcement` | v1 は記録のみ（通知文自体に「無視してよい」と明記されている。会話中に行動を切り替えると会話が closing になるため触らない） |

LLM への入力（プロンプト構成）:

```
system:
  あなたは「{name}」…（共通の world 前提説明）
  # 役割設定
  {persona}
  # 現在の状況
  現在地: {location_label} / 時刻: {world_time} / 天気: {weather}
  # 相手についての記憶
  {participants ごとの memories.summary（無ければ「初対面」）}
  # 出力仕様（JSON schema での構造化出力）
user/assistant 交互:
  同一相手（グループの場合は同一 conversation）の過去会話から直近 max_history_pairs(15) 往復
  + 現在の会話の全メッセージ（max_turns=20 なので上限内）
```

構造化出力（JSON）:

```ts
{
  message: string;                    // 発言（1〜3文程度を促す）
  next_speaker_agent_id: string;      // 参加者から選択（enum で強制）
  end_conversation: boolean;          // 会話を切り上げるか
  give?: { type: 'item'|'money', item_name?: string, amount?: number } // TransferPolicy.give_enabled 時のみ
}
```

- `give` が返り、所持品/所持金と整合すれば `conversation_speak` に `transfer` を添付する
- 会話相手からの会話中譲渡は `transfer_response: 'accept'|'reject'` を LLM 出力に含めて処理（受信 policy が `always_*` なら LLM に聞かず固定）
- **「15 往復保持」の解釈**: 1 会話は world 側 max 20 ターンで終わるため、「同一相手との会話をまたいだ直近 15 往復」を LLM コンテキストとして維持する（`conversation_messages` から組み立て）。セッションオブジェクト自体は保持せず、毎回 DB から再構築する（プロセス再起動に強い）

### 6.4 記憶（簡易記憶システム）

- 会話終了時にジョブ実行: 会話ログ + 既存 summary を LLM に渡し、**相手ごとの累積要約**（人物像・約束・重要な出来事、~1000 字上限）を更新
- グループ会話は参加者それぞれの memories を更新
- 次回会話時に system prompt へ注入
- WebUI から閲覧・編集・削除可能（NPC の記憶を運用者が直せる）

### 6.5 アイテム授受

| kind | 処理 |
|---|---|
| `transfer_request`（単独譲渡の着信） | policy.receive に従い `transfer_accept` / `transfer_reject`（`llm` はペルソナ+記憶で判断）。インベントリ上限（world 側 10 スロット）超過見込みなら reject |
| `transfer_accepted` | 既知の相手（記憶あり）なら記憶に「◯◯を受け取った/渡した」を機械的に一行追記（payload が名前ベースのため未知の相手はスキップ）。次の行動 choices は idle 契機として委譲 |
| `transfer_sent` / `_rejected` / `_timeout` / `_cancelled` / `_escrow_lost` | ログのみ（money/items は perception / get_status 同期で反映）。次の行動 choices は idle 契機として委譲 |

NPC から渡す方は §6.3 の会話中 `give`（v1 はこれのみ。単独 `transfer` コマンドの自発実行は idle 契機に choices へ出た場合のみ将来対応）。

## 7. LLM 統合

- `LlmProvider.generate(messages, { jsonSchema?, temperature?, maxTokens? })` の 1 インターフェース
- `openai_compatible`: `OPENAI_BASE_URL` + `OPENAI_API_KEY` + model。`response_format: json_schema` 非対応サーバー向けに「JSON をプロンプトで指示 + パース失敗時 1 回修復リトライ」のフォールバック
- `anthropic`: tool_use による構造化出力
- グローバル既定（settings テーブル）+ NPC ごとの `llm_json` 上書き
- 同時実行制御: プロセス全体で同時 LLM 呼び出し数を制限（既定 4、env で変更）。NPC 内は元々直列

## 8. WebUI（apps/web）

認証: `WEB_PASSWORD` 設定時のみパスワードログイン（セッション cookie）。未設定なら認証なし（localhost 運用想定）。

### 画面

1. **ダッシュボード** (`/`)
   - NPC カード一覧: 稼働状態（ログイン中/停止/エラー）、現在地（world_id + node + location_label）、状態、所持金、最終活動時刻
   - 直近のイベントフィード（deliveries + command_log を時系列表示、SSE でライブ更新）
2. **NPC 作成・編集** (`/npcs/new`, `/npcs/:id/edit`)
   - 接続: agent_id / api_key / webhook_secret（world 側で発行した値を貼り付け。ベース URL は .env の WORLD_BASE_URL）+「接続テスト」ボタン（存在しない通知 ID の取得を試み 401 なら認証 NG と判定。login/logout は行わないため位置指定ログインのクールダウンを消費しない）
   - 人格: name / persona / rules（テキストエリア。rules は会話の流れより常に優先される絶対ルール）
   - 移動: mode、home_node_id、anchor + range（数値入力。v1 はマップピッカーなし）、move_probability、rest_duration
   - 会話: accept / inactive_check / max_history_pairs
   - アイテム: receive / give_enabled
   - LLM: provider / model / temperature の上書き
3. **NPC 詳細** (`/npcs/:id`)
   - 稼働トグル（enabled ON/OFF = ログイン/ログアウト）、「ホームへ戻す」
   - 会話履歴ビューア（conversations → メッセージ）
   - 記憶ビューア（相手ごとの summary、編集・削除）
   - 通知・コマンドログ（失敗の原因調査用）
4. **設定** (`/settings`)
   - LLM グローバル設定（provider / base_url / api_key / model）
   - webhook 公開 URL の表示（world 側 NPC 登録に貼る値: `{WEBHOOK_PUBLIC_BASE_URL}/webhook`）

### WebUI 向け API（server 内 `/api/*`、webhook とは別系統）

```
GET    /api/npcs                     一覧（runtime 状態込み）
POST   /api/npcs                     作成
GET    /api/npcs/:id                 詳細
PATCH  /api/npcs/:id                 更新（persona 等は次の会話から反映）
DELETE /api/npcs/:id                 削除（ログアウトしてから削除）
POST   /api/npcs/:id/enable|disable  稼働 ON/OFF
POST   /api/npcs/:id/return-home     ホームへ戻す
POST   /api/npcs/:id/test-connection 接続テスト
GET    /api/npcs/:id/conversations, /conversations/:cid/messages
GET|PUT|DELETE /api/npcs/:id/memories/:agentId
GET    /api/npcs/:id/logs            deliveries + command_log
GET    /api/events                   SSE（3秒ごとに全NPCのランタイム状態サマリをpush）
GET|PUT /api/settings
GET    /api/meta                     webhook公開URL等
POST   /api/auth/login, GET /api/auth/status
```

## 9. 設定（環境変数）

```
PORT=8300
DATA_DIR=./data                     # npc.sqlite
WORLD_BASE_URL=                     # 必須。karakuri-world のベース URL（全 NPC 共通）
WEBHOOK_PUBLIC_BASE_URL=            # 必須。world に登録する公開 https URL
WEB_PASSWORD=                       # 任意。WebUI 認証
OPENAI_BASE_URL= / OPENAI_API_KEY=  # 既定 LLM（OpenAI 互換）
ANTHROPIC_API_KEY=                  # anthropic 使用時
LLM_MAX_CONCURRENCY=4
```

ログは stdout / stderr に出力する（ファイルログは持たない。永続化は systemd / docker 側で行う）。

ローカル開発: world の SSRF ガードにより webhook は https + 公開ホスト必須。
`cloudflared tunnel --url http://localhost:8300` 等で公開 URL を作って `WEBHOOK_PUBLIC_BASE_URL` に設定する手順を README に書く。

## 10. セキュリティ

- webhook: HMAC 検証（timing-safe）+ delivery_id dedupe。検証失敗は 401 で本文非開示
- api_key / webhook_secret は SQLite に平文保存（ローカル運用ツールの割り切り。WebUI 上ではマスク表示）
- WebUI API と webhook はミドルウェアを分離（webhook に WebUI 認証を掛けない・逆も同様）

## 11. 実装フェーズ

| Phase | 内容 | 完了条件 |
|---|---|---|
| 1 | 土台: monorepo 雛形 / config / SQLite / world クライアント / webhook 受信（署名検証・dedupe・即200） | 手動登録した 1 NPC がログインし、通知を受けて `wait` を返せる |
| 2 | 移動: movement-planner / idle 契機ハンドラ / 位置指定ログイン + 429 フォールバック / state-mirror | random / stationary の両モードが動き、home 開始が効く |
| 3 | 会話: conversation-engine / LLM プロバイダ / 履歴 15 往復 / 記憶要約 | 話しかけると人格どおり返答し、2 回目の会話で記憶が反映される |
| 4 | アイテム: transfer 受信 policy / 会話中 give / state 反映 | 授受の両方向が通る |
| 5 | WebUI: 全画面 + SSE + 接続テスト | WebUI だけで NPC の作成〜稼働〜監視が完結する |
| 6 | 運用仕上げ: 再起動リカバリ / エラー通知の見える化 / README（トンネル手順含む） | プロセス再起動・world 再起動をまたいで自走する |

## 12. v1 スコープ外（将来検討）

- NPC からの自発的な `transfer`（単独コマンド）・会話への `conversation_join`（自発参加）
- マップビジュアルでの範囲/ホーム指定（world の snapshot JSON を読めば実装可能）
- world 側 NPC 登録の自動化（world が admin セッション必須のため v1 は手動貼り付け）
- 感情パラメータ・長期記憶の高度化（ベクトル検索等）
- 複数 world サーバーの横断ダッシュボード最適化
