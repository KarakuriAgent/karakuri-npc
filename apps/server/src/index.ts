import { Server } from 'node:http';
import { join } from 'node:path';

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { LlmService } from './llm/llm-service.js';
import { ConversationEngine } from './runtime/conversation-engine.js';
import { createConversationHandlers } from './runtime/handlers/conversation.js';
import { createIdleHandlers } from './runtime/handlers/idle.js';
import { createLifecycleHandlers } from './runtime/handlers/lifecycle.js';
import { createTransferHandlers } from './runtime/handlers/transfer.js';
import { NpcManager } from './runtime/manager.js';
import { MemoryService } from './runtime/memory.js';
import { openDatabase } from './storage/database.js';
import { ConversationStore } from './storage/conversation-store.js';
import { NpcStore } from './storage/npc-store.js';
import { worldClientFactory } from './world/client.js';
import { WorldMapRepository } from './world/maps.js';

const config = loadConfig();
const db = openDatabase(join(config.DATA_DIR, 'npc.sqlite'));
const store = new NpcStore(db);
const conversations = new ConversationStore(db);

const llm = new LlmService({ config, store });
const engine = new ConversationEngine({ llm, conversations });
const memory = new MemoryService({ conversations, engine });
const idleHandlers = createIdleHandlers(store);

const createWorldClient = worldClientFactory(config.WORLD_BASE_URL);

const manager = new NpcManager({
  store,
  createClient: createWorldClient,
  // スケジュール時間外のログオフを会話終了まで先送りするための参照
  hasActiveConversation: (npcId) => conversations.getActiveConversation(npcId) !== null,
  // ログアウト = world 側で会話が強制終了されるため、ローカルも閉じて記憶更新まで回す
  closeActiveConversation: (npcId, reason) => {
    const active = conversations.getActiveConversation(npcId);
    if (!active) return;
    conversations.endConversation(npcId, active.conversation_id, reason);
    const npc = store.getNpc(npcId);
    if (npc) {
      void memory.summarizeConversation(npc, active.conversation_id).catch((error) => {
        console.warn(`[${npcId}] memory job (logout) failed: ${String(error)}`);
      });
    }
  },
  // 未登録 kind は fallback（wait）で処理される。
  handlers: {
    ...createLifecycleHandlers(store),
    ...idleHandlers,
    ...createConversationHandlers({
      conversations,
      engine,
      memory,
      store,
      idleHandler: idleHandlers.idle_reminder,
    }),
    ...createTransferHandlers({
      store,
      conversations,
      engine,
      idleHandler: idleHandlers.idle_reminder,
    }),
  },
});

const app = createApp({
  config,
  store,
  conversations,
  manager,
  createWorldClient,
  worldMaps: new WorldMapRepository(config.WORLD_MAP_DIR),
  webDistDir: join(import.meta.dirname, '../../web/dist'),
});

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.info(`karakuri-npc server listening on :${info.port}`);
  if (!config.WEBHOOK_PUBLIC_BASE_URL) {
    console.warn('WEBHOOK_PUBLIC_BASE_URL is not set. world からの webhook を受けるには公開 URL が必要です。');
  }
  if (!config.WORLD_BASE_URL) {
    console.warn('WORLD_BASE_URL is not set. NPC を world に接続するには .env での設定が必要です。');
  }
});

manager.start().catch((error) => {
  console.error('NpcManager start failed:', error);
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    console.warn(`${signal} received again, exiting immediately`);
    process.exit(1);
  }
  shuttingDown = true;
  console.info(`${signal} received, shutting down...`);
  // 排水が詰まっても必ず終了できるようにする保険
  setTimeout(() => {
    console.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000).unref();
  // 順序が重要: 新規リクエストの受付を止めてから NPC キューを排水し、最後に DB を閉じる。
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // SSE(/api/events) などの持続接続が残っていると close が完了しないため強制切断する
    if (server instanceof Server) server.closeAllConnections();
  });
  await manager.stop();
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
