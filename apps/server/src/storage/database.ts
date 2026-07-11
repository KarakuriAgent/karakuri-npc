import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

export type Db = Database.Database;

export function openDatabase(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS npcs (
      npc_id            TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      enabled           INTEGER NOT NULL DEFAULT 0,
      world_base_url    TEXT NOT NULL,
      agent_id          TEXT NOT NULL UNIQUE,
      api_key           TEXT NOT NULL,
      webhook_secret    TEXT NOT NULL,
      persona           TEXT NOT NULL DEFAULT '',
      home_node_id      TEXT,
      movement_json     TEXT NOT NULL DEFAULT '{}',
      conversation_json TEXT NOT NULL DEFAULT '{}',
      transfer_json     TEXT NOT NULL DEFAULT '{}',
      llm_json          TEXT NOT NULL DEFAULT '{}',
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS npc_runtime (
      npc_id            TEXT PRIMARY KEY REFERENCES npcs(npc_id) ON DELETE CASCADE,
      logged_in         INTEGER NOT NULL DEFAULT 0,
      world_id          TEXT,
      node_id           TEXT,
      agent_state       TEXT,
      money             INTEGER,
      items_json        TEXT,
      last_notification_at INTEGER,
      last_command_at   INTEGER,
      last_error        TEXT,
      status_synced_at  INTEGER
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      delivery_id       TEXT PRIMARY KEY,
      npc_id            TEXT NOT NULL,
      notification_id   TEXT NOT NULL,
      kind              TEXT NOT NULL,
      received_at       INTEGER NOT NULL,
      status            TEXT NOT NULL,
      error             TEXT,
      notification_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deliveries_npc ON deliveries(npc_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status, received_at);

    CREATE TABLE IF NOT EXISTS command_log (
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
    CREATE INDEX IF NOT EXISTS idx_command_log_npc ON command_log(npc_id, executed_at DESC);

    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id   TEXT NOT NULL,
      npc_id            TEXT NOT NULL,
      participants_json TEXT NOT NULL DEFAULT '[]',
      -- 1:1 会話のときの相手 agent_id（会話をまたいだ履歴の引き当てに使う。グループは NULL）
      counterpart_agent_id TEXT,
      status            TEXT NOT NULL DEFAULT 'active',
      started_at        INTEGER NOT NULL,
      ended_at          INTEGER,
      end_reason        TEXT,
      summarized        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (conversation_id, npc_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_counterpart
      ON conversations(npc_id, counterpart_agent_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id   TEXT NOT NULL,
      npc_id            TEXT NOT NULL,
      turn              INTEGER,
      -- 通知 payload は名前ベースのため agent_id が特定できないことがある（NULL 許容）
      speaker_agent_id  TEXT,
      speaker_name      TEXT,
      -- 自 NPC の発言か（プロンプトの user/assistant 振り分けに使う）
      is_self           INTEGER NOT NULL DEFAULT 0,
      message           TEXT NOT NULL,
      created_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON conversation_messages(npc_id, conversation_id, id);

    CREATE TABLE IF NOT EXISTS memories (
      npc_id            TEXT NOT NULL,
      counterpart_agent_id TEXT NOT NULL,
      counterpart_name  TEXT,
      summary           TEXT NOT NULL,
      conversation_count INTEGER NOT NULL DEFAULT 0,
      last_talked_at    INTEGER,
      updated_at        INTEGER NOT NULL,
      PRIMARY KEY (npc_id, counterpart_agent_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}
