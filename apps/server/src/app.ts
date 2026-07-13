import { existsSync } from 'node:fs';
import { relative } from 'node:path';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

import { registerWebApiRoutes } from './api/web.js';
import type { AppConfig } from './config.js';
import type { NpcManager } from './runtime/manager.js';
import type { ConversationStore } from './storage/conversation-store.js';
import type { NpcStore } from './storage/npc-store.js';
import { registerWebhookRoute } from './webhook/receiver.js';
import type { CreateWorldClient } from './world/client.js';
import type { WorldMapRepository } from './world/maps.js';

export interface AppDeps {
  config: AppConfig;
  store: NpcStore;
  conversations: ConversationStore;
  manager: NpcManager;
  createWorldClient: CreateWorldClient;
  worldMaps: WorldMapRepository;
  /** WebUI ビルド成果物のディレクトリ（本番配信用）。存在しなければ配信しない。 */
  webDistDir?: string | undefined;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  registerWebhookRoute(app, deps.store, (dispatch) => deps.manager.handleWebhook(dispatch));
  registerWebApiRoutes(app, deps);

  if (deps.webDistDir && existsSync(deps.webDistDir)) {
    // @hono/node-server の serveStatic は CWD 相対パスを要求する
    const root = relative(process.cwd(), deps.webDistDir) || '.';
    app.use('/*', serveStatic({ root }));
    // SPA fallback: 未マッチの GET は index.html
    app.get('*', serveStatic({ root, path: 'index.html' }));
  }

  return app;
}
