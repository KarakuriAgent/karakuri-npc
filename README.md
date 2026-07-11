# Karakuri NPC

karakuri-world に接続する **LLM 駆動 NPC の管理・実行サーバー**。

1 プロセスで複数の NPC を稼働させ、WebUI から作成・編集・監視ができる。
NPC は world 上で指定位置に出現し、設定した範囲をランダムに移動（または定住）し、
話しかけられるとペルソナと記憶に基づいて LLM で応答し、アイテムやお金の授受も行う。

## 全体像

```
karakuri-world ──(webhook 通知)──▶ karakuri-npc ──(REST /api/npc/*)──▶ karakuri-world
                                      │
                                      ├─ NPC ランタイム（移動プランナ / 会話エンジン / 記憶）
                                      ├─ SQLite（NPC 設定・会話履歴・記憶・ログ）
                                      ├─ LLM（OpenAI 互換 API / Anthropic）
                                      └─ WebUI（React。作成・編集・ダッシュボード）
```

- world との通信はすべて **通知駆動**（1 通知につき最大 1 コマンド）。webhook で `notification_id` を受け、詳細をフェッチして choices から行動を選ぶ
- NPC は world 側の `agent_kind: 'npc'` エージェントとしてログインする（Discord bot 不要）

## セットアップ

### 1. インストールとビルド

```bash
npm install
npm run build        # server + web
```

### 2. 環境変数

```bash
cp apps/server/env.example apps/server/.env
```

| 変数 | 必須 | 説明 |
|---|---|---|
| `PORT` | - | サーバーポート（既定 8300） |
| `DATA_DIR` | - | SQLite の置き場所（既定 `./data`） |
| `WEBHOOK_PUBLIC_BASE_URL` | ✅ | world から見えるこのサーバーの公開 https URL |
| `WEB_PASSWORD` | - | WebUI のパスワード（未設定なら認証なし。localhost 運用専用） |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` | ✅(いずれかの LLM) | 既定 LLM（OpenAI 互換。LiteLLM proxy / Ollama 等も可） |
| `ANTHROPIC_API_KEY` | - | Anthropic を使う場合 |
| `LLM_MAX_CONCURRENCY` | - | LLM 同時実行数（既定 4） |

LLM 設定は WebUI の「設定」からも変更できる（settings が env より優先、NPC ごとの上書きが最優先）。

### 3. webhook 公開 URL の用意

world 側の SSRF ガードにより、webhook URL は **https 必須・localhost / プライベート IP 不可**。
ローカル開発ではトンネルを使う:

```bash
cloudflared tunnel --url http://localhost:8300
# 表示された https://xxxx.trycloudflare.com を WEBHOOK_PUBLIC_BASE_URL に設定
```

### 4. 起動

```bash
npm start            # 本番（ビルド済み dist を起動、WebUI 同梱配信）
# または開発:
npm run dev:server   # サーバー (tsx watch, :8300)
npm run dev:web      # WebUI (Vite, :8301 → /api を :8300 に proxy)
```

## NPC の作り方

1. **world 側**で NPC エージェントを作成する（admin 限定）
   - world の WebUI（マイページ）または Discord 管理コマンドから作成
   - `webhook_url` には karakuri-npc の「設定」画面に表示される URL（`{WEBHOOK_PUBLIC_BASE_URL}/webhook`）を指定
   - 発行された `agent_id` / `api_key` / `webhook_secret` を控える
2. **karakuri-npc の WebUI**（`http://localhost:8300`）で「NPC を作成」
   - world 接続情報（上記 3 点 + world のベース URL）を貼り付け
   - ペルソナ（役割・口調）、開始位置（`home_node_id`）、移動モード・範囲・確率、会話・アイテムのポリシーを設定
   - 保存後「接続テスト」で疎通確認
3. ダッシュボードで「稼働する」→ NPC が world にログインし、自走を始める

### NPC ができること

| 機能 | 説明 |
|---|---|
| 指定位置で開始 | `home_node_id` を位置指定ログインで使用（world 側に 10 分クールダウンあり。429 時は前回位置に自動フォールバック） |
| ランダム移動 / 定住 | アンカー ± 範囲の矩形から次の移動先をランダム選択。移動間隔は world 仕様上 約 10 分単位 |
| 会話 | 話しかけられると受諾し、ペルソナ + 相手の記憶 + 会話をまたいだ直近 15 往復の履歴で LLM 応答。グループ会話（次話者指名・継続確認）対応 |
| 簡易記憶 | 会話終了ごとに相手ごとの累積要約を自動更新。WebUI で閲覧・編集・削除可能 |
| アイテム授受 | 受け取りはポリシー（常に受け取る / LLM 判断 / 断る）。渡す方は会話の流れで LLM が判断（`give_enabled`） |

### できないこと（world 側の NPC 制約）

- NPC から会話を始める（`conversation_start` 不可 — 話しかけられ待ち）
- アクション実行・アイテム使用・ワールド間移動（`action` / `use_item` / `travel` 不可）

## 運用メモ

- **稼働維持**: 5 分間隔のヘルスループが enabled な NPC のログインを維持する。world 再起動後も自動で再ログインする
- **通知の信頼性**: world の webhook 配送は 5 秒タイムアウト × 2 回で再送なし。受信は即 200 を返し、`X-Karakuri-Npc-Delivery-Id` で重複排除する。取りこぼしは world 側の idle_reminder（約 10 分間隔）が保険になる
- **再起動リカバリ**: 未着手の通知（30 分の通知 TTL 内）は再処理される。処理中に落ちた通知はコマンド二重実行を避けるため再実行しない
- **LLM 障害時**: リトライ後も失敗した場合は定型文で応答し、会話をタイムアウトで殺さない
- **ログ**: WebUI の NPC 詳細 →「通知・コマンドログ」で全受信通知と実行コマンド（拒否理由込み）を確認できる

## 開発

```bash
npm run typecheck    # server + web
npm test             # server (vitest)
npm test -w @karakuri-npc/server -- test/unit/conversation.test.ts   # 単一ファイル
```

設計ドキュメント: [`docs/design/npc-system.md`](./docs/design/npc-system.md)

```
apps/
├── server/   # 本体（webhook 受信 / NPC ランタイム / WebUI API / 静的配信）
│   └── src/
│       ├── webhook/    # 署名検証・重複排除・即 200
│       ├── runtime/    # NpcManager / NpcRuntime / kind別ハンドラ / 移動プランナ / 会話エンジン / 記憶
│       ├── world/      # /api/npc/* クライアント
│       ├── llm/        # プロバイダ抽象（OpenAI 互換 / Anthropic）
│       ├── storage/    # SQLite（npcs / deliveries / conversations / memories ...）
│       └── api/        # WebUI 向け API + 認証
└── web/      # WebUI（React + Vite + Tailwind）
```
