import { Hono } from 'hono';

import type { NpcManager } from './runtime/manager.js';
import type { NpcStore } from './storage/npc-store.js';
import { registerWebhookRoute } from './webhook/receiver.js';

export interface AppDeps {
  store: NpcStore;
  manager: NpcManager;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  registerWebhookRoute(app, deps.store, (dispatch) => deps.manager.handleWebhook(dispatch));

  return app;
}
