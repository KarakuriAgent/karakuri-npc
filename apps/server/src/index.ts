import { join } from 'node:path';

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLifecycleHandlers } from './runtime/handlers/lifecycle.js';
import { NpcManager } from './runtime/manager.js';
import { openDatabase } from './storage/database.js';
import { NpcStore } from './storage/npc-store.js';

const config = loadConfig();
const db = openDatabase(join(config.DATA_DIR, 'npc.sqlite'));
const store = new NpcStore(db);

const manager = new NpcManager({
  store,
  // kind 別ハンドラは Phase 2 以降で拡充する。未登録 kind は fallback（wait）で処理される。
  handlers: {
    ...createLifecycleHandlers(store),
  },
});

const app = createApp({ store, manager });

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.info(`karakuri-npc server listening on :${info.port}`);
  if (!config.WEBHOOK_PUBLIC_BASE_URL) {
    console.warn('WEBHOOK_PUBLIC_BASE_URL is not set. world からの webhook を受けるには公開 URL が必要です。');
  }
});

manager.start().catch((error) => {
  console.error('NpcManager start failed:', error);
});

async function shutdown(signal: string): Promise<void> {
  console.info(`${signal} received, shutting down...`);
  // 順序が重要: 新規リクエストの受付を止めてから NPC キューを排水し、最後に DB を閉じる。
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await manager.stop();
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
