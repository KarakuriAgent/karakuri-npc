import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import type { AppConfig } from '../config.js';
import {
  LLM_GLOBAL_SETTING_KEY,
  globalLlmSettingsSchema,
  loadGlobalLlmSettings,
} from '../llm/provider.js';
import type { NpcManager } from '../runtime/manager.js';
import type { ConversationStore } from '../storage/conversation-store.js';
import type { NpcStore } from '../storage/npc-store.js';
import type { Npc } from '../types/npc.js';
import {
  conversationPolicySchema,
  llmConfigSchema,
  movementConfigSchema,
  transferPolicySchema,
} from '../types/npc.js';
import { WorldApiError, WorldClient } from '../world/client.js';
import { issueSessionCookie, verifyPassword, verifySession, webAuth } from './web-auth.js';

const nodeIdSchema = z.string().regex(/^\d+-\d+$/);

const npcCreateSchema = z.object({
  name: z.string().min(1).max(100),
  world_base_url: z.string().url(),
  agent_id: z.string().min(1),
  api_key: z.string().min(1),
  webhook_secret: z.string().min(1),
  persona: z.string().max(20_000).optional(),
  home_node_id: nodeIdSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  movement: movementConfigSchema.partial().optional(),
  conversation: conversationPolicySchema.partial().optional(),
  transfer: transferPolicySchema.partial().optional(),
  llm: llmConfigSchema.optional(),
});

const npcUpdateSchema = npcCreateSchema.partial();

/** 秘匿値のマスク表示（末尾 4 文字のみ見せる）。 */
function mask(secret: string): string {
  return secret.length <= 4 ? '****' : `****${secret.slice(-4)}`;
}

function npcDto(npc: Npc, store: NpcStore): Record<string, unknown> {
  const runtime = store.getRuntime(npc.npc_id);
  return {
    npc_id: npc.npc_id,
    name: npc.name,
    enabled: npc.enabled,
    world_base_url: npc.world_base_url,
    agent_id: npc.agent_id,
    api_key_masked: mask(npc.api_key),
    webhook_secret_masked: mask(npc.webhook_secret),
    persona: npc.persona,
    home_node_id: npc.home_node_id,
    movement: npc.movement,
    conversation: npc.conversation,
    transfer: npc.transfer,
    llm: npc.llm,
    created_at: npc.created_at,
    updated_at: npc.updated_at,
    runtime,
  };
}

export interface WebApiDeps {
  config: AppConfig;
  store: NpcStore;
  conversations: ConversationStore;
  manager: NpcManager;
}

export function registerWebApiRoutes(app: Hono, deps: WebApiDeps): void {
  const { config, store, conversations, manager } = deps;
  const auth = webAuth(config.WEB_PASSWORD);

  // ---- 認証（この 2 つだけ auth 不要） ----

  app.post('/api/auth/login', async (c) => {
    if (!config.WEB_PASSWORD) return c.json({ ok: true, auth_required: false });
    const body = (await c.req.json().catch(() => ({}))) as { password?: unknown };
    if (typeof body.password !== 'string' || !verifyPassword(body.password, config.WEB_PASSWORD)) {
      return c.json({ error: 'unauthorized', message: 'パスワードが違います。' }, 401);
    }
    issueSessionCookie(c, config.WEB_PASSWORD);
    return c.json({ ok: true });
  });

  app.get('/api/auth/status', (c) => {
    if (!config.WEB_PASSWORD) return c.json({ auth_required: false, authenticated: true });
    return c.json({ auth_required: true, authenticated: verifySession(c, config.WEB_PASSWORD) });
  });

  // ---- NPC CRUD ----

  app.get('/api/npcs', auth, (c) => {
    return c.json({ npcs: store.listNpcs().map((npc) => npcDto(npc, store)) });
  });

  app.post('/api/npcs', auth, async (c) => {
    const body = npcCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'validation_error', message: body.error.message }, 400);
    }
    if (store.getNpcByAgentId(body.data.agent_id)) {
      return c.json({ error: 'duplicate_agent_id', message: 'この agent_id は登録済みです。' }, 409);
    }
    const npc = store.createNpc({ ...body.data, home_node_id: body.data.home_node_id ?? null });
    if (npc.enabled) void manager.healthCheck().catch(() => {});
    return c.json(npcDto(npc, store), 201);
  });

  app.get('/api/npcs/:id', auth, (c) => {
    const npc = store.getNpc(c.req.param('id'));
    if (!npc) return c.json({ error: 'not_found' }, 404);
    return c.json(npcDto(npc, store));
  });

  app.patch('/api/npcs/:id', auth, async (c) => {
    const body = npcUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'validation_error', message: body.error.message }, 400);
    }
    // 空文字の api_key / webhook_secret は「変更しない」扱い（マスク表示からの再送対策）
    const patch = { ...body.data };
    if (!patch.api_key) delete patch.api_key;
    if (!patch.webhook_secret) delete patch.webhook_secret;
    const npc = store.updateNpc(c.req.param('id'), patch);
    if (!npc) return c.json({ error: 'not_found' }, 404);
    void manager.healthCheck().catch(() => {});
    return c.json(npcDto(npc, store));
  });

  app.delete('/api/npcs/:id', auth, async (c) => {
    const npc = store.getNpc(c.req.param('id'));
    if (!npc) return c.json({ error: 'not_found' }, 404);
    const runtime = store.getRuntime(npc.npc_id);
    if (runtime?.logged_in) {
      try {
        await manager.logoutNpc(npc);
      } catch {
        // world 側に残っていても削除は続行する（world 側で別途 logout / 削除できる）
      }
    }
    store.deleteNpc(npc.npc_id);
    return c.body(null, 204);
  });

  // ---- 稼働操作 ----

  app.post('/api/npcs/:id/enable', auth, async (c) => {
    const npc = store.updateNpc(c.req.param('id'), { enabled: true });
    if (!npc) return c.json({ error: 'not_found' }, 404);
    await manager.healthCheck().catch(() => {});
    return c.json(npcDto(store.getNpc(npc.npc_id)!, store));
  });

  app.post('/api/npcs/:id/disable', auth, async (c) => {
    const npc = store.updateNpc(c.req.param('id'), { enabled: false });
    if (!npc) return c.json({ error: 'not_found' }, 404);
    await manager.healthCheck().catch(() => {});
    return c.json(npcDto(store.getNpc(npc.npc_id)!, store));
  });

  /** ホーム位置へ戻す: logout → 位置指定 login。クールダウン中は 429 を透過する。 */
  app.post('/api/npcs/:id/return-home', auth, async (c) => {
    const npc = store.getNpc(c.req.param('id'));
    if (!npc) return c.json({ error: 'not_found' }, 404);
    if (!npc.home_node_id) {
      return c.json({ error: 'no_home', message: 'home_node_id が設定されていません。' }, 400);
    }
    const client = new WorldClient(npc.world_base_url, npc.api_key);
    try {
      await client.logout().catch((error: unknown) => {
        if (!(error instanceof WorldApiError && error.status === 409)) throw error;
      });
      const result = await client.login({ node_id: npc.home_node_id });
      store.patchRuntime(npc.npc_id, {
        logged_in: true,
        node_id: typeof result.node_id === 'string' ? result.node_id : npc.home_node_id,
        agent_state: 'idle',
        last_error: null,
      });
      return c.json({ ok: true, node_id: result.node_id ?? npc.home_node_id });
    } catch (error) {
      if (error instanceof WorldApiError) {
        // 429 のときも放置せず、位置指定なしで復帰させておく（オフライン化を防ぐ）
        if (error.status === 429) {
          await client.login().catch(() => {});
          void manager.healthCheck().catch(() => {});
          return c.json(
            {
              error: 'rate_limited',
              message: `位置指定ログインはクールダウン中です（約${error.retryAfterSeconds ?? '?'}秒後に再試行できます）。現在位置で復帰しました。`,
              retry_after_seconds: error.retryAfterSeconds,
            },
            429,
          );
        }
        void manager.healthCheck().catch(() => {});
        return c.json({ error: error.code, message: error.message }, 502);
      }
      throw error;
    }
  });

  /** 接続テスト: 存在しない通知 ID の取得を試み、401 なら認証 NG、それ以外は疎通 OK。 */
  app.post('/api/npcs/:id/test-connection', auth, async (c) => {
    const npc = store.getNpc(c.req.param('id'));
    if (!npc) return c.json({ error: 'not_found' }, 404);
    const client = new WorldClient(npc.world_base_url, npc.api_key, { timeoutMs: 10_000 });
    try {
      await client.getNotification('connection-test');
      return c.json({ ok: true, detail: 'reachable' });
    } catch (error) {
      if (error instanceof WorldApiError) {
        if (error.status === 401) {
          return c.json({ ok: false, detail: 'API キーが無効です。' });
        }
        if (error.status === 0) {
          return c.json({ ok: false, detail: `接続できません: ${error.message}` });
        }
        // 403 not_logged_in / 404 not_found = 認証は通っている
        return c.json({ ok: true, detail: `認証 OK（${error.code}）` });
      }
      throw error;
    }
  });

  // ---- 会話・記憶・ログ ----

  app.get('/api/npcs/:id/conversations', auth, (c) => {
    const npc = store.getNpc(c.req.param('id'));
    if (!npc) return c.json({ error: 'not_found' }, 404);
    return c.json({ conversations: conversations.listConversations(npc.npc_id, 100) });
  });

  app.get('/api/npcs/:id/conversations/:cid/messages', auth, (c) => {
    const npc = store.getNpc(c.req.param('id'));
    if (!npc) return c.json({ error: 'not_found' }, 404);
    return c.json({ messages: conversations.listMessages(npc.npc_id, c.req.param('cid')) });
  });

  app.get('/api/npcs/:id/memories', auth, (c) => {
    const npc = store.getNpc(c.req.param('id'));
    if (!npc) return c.json({ error: 'not_found' }, 404);
    return c.json({ memories: conversations.listMemories(npc.npc_id) });
  });

  app.put('/api/npcs/:id/memories/:agentId', auth, async (c) => {
    const npc = store.getNpc(c.req.param('id'));
    if (!npc) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { summary?: unknown };
    if (typeof body.summary !== 'string' || body.summary.length === 0 || body.summary.length > 4000) {
      return c.json({ error: 'validation_error', message: 'summary は 1〜4000 文字で指定してください。' }, 400);
    }
    const updated = conversations.setMemorySummary(npc.npc_id, c.req.param('agentId'), body.summary);
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });

  app.delete('/api/npcs/:id/memories/:agentId', auth, (c) => {
    const npc = store.getNpc(c.req.param('id'));
    if (!npc) return c.json({ error: 'not_found' }, 404);
    if (!conversations.deleteMemory(npc.npc_id, c.req.param('agentId'))) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.body(null, 204);
  });

  app.get('/api/npcs/:id/logs', auth, (c) => {
    const npc = store.getNpc(c.req.param('id'));
    if (!npc) return c.json({ error: 'not_found' }, 404);
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    return c.json({
      deliveries: store.listDeliveries(npc.npc_id, limit),
      commands: store.listCommandLog(npc.npc_id, limit),
    });
  });

  // ---- 設定・メタ ----

  app.get('/api/settings', auth, (c) => {
    const settings = loadGlobalLlmSettings(store);
    return c.json({
      llm: { ...settings, api_key: settings.api_key ? mask(settings.api_key) : undefined },
      env_defaults: {
        openai_base_url: config.OPENAI_BASE_URL ?? null,
        openai_model: config.OPENAI_MODEL ?? null,
        anthropic_configured: Boolean(config.ANTHROPIC_API_KEY),
      },
    });
  });

  app.put('/api/settings', auth, async (c) => {
    const body = globalLlmSettingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'validation_error', message: body.error.message }, 400);
    }
    // マスクされた api_key（**** 始まり）は既存値を維持する
    const current = loadGlobalLlmSettings(store);
    const next = { ...body.data };
    if (next.api_key?.startsWith('****')) next.api_key = current.api_key;
    store.setSetting(LLM_GLOBAL_SETTING_KEY, JSON.stringify(next));
    return c.json({ ok: true });
  });

  app.get('/api/meta', auth, (c) => {
    return c.json({
      webhook_url: config.WEBHOOK_PUBLIC_BASE_URL ? `${config.WEBHOOK_PUBLIC_BASE_URL.replace(/\/+$/, '')}/webhook` : null,
      port: config.PORT,
    });
  });

  // ---- ダッシュボード用 SSE（3 秒ごとに全 NPC のランタイム状態を push） ----

  app.get('/api/events', auth, (c) => {
    return streamSSE(c, async (stream) => {
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
      });
      while (!aborted) {
        const npcs = store.listNpcs().map((npc) => ({
          npc_id: npc.npc_id,
          name: npc.name,
          enabled: npc.enabled,
          runtime: store.getRuntime(npc.npc_id),
        }));
        await stream.writeSSE({ event: 'summary', data: JSON.stringify({ npcs, at: Date.now() }) });
        await stream.sleep(3000);
      }
    });
  });
}
