import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import type { Context, Hono } from 'hono';

import type { NpcStore } from '../storage/npc-store.js';
import type { WebhookPayload } from '../types/world.js';
import { webhookPayloadSchema } from '../types/world.js';

export function signWebhookBody(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface WebhookDispatch {
  npcId: string;
  deliveryId: string;
  payload: WebhookPayload;
}

export type WebhookDispatcher = (dispatch: WebhookDispatch) => void;

/**
 * karakuri-world からの NPC 通知 webhook 受信。
 * - agent_id で NPC を特定し、その webhook_secret で HMAC 署名を検証する
 * - delivery_id で重複配送を排除する
 * - 受理したら即 200 を返し、処理はディスパッチャ（per-NPC キュー）に委ねる
 *   （world 側の配送タイムアウトは 5 秒。ここで重い処理をしてはいけない）
 */
export function registerWebhookRoute(app: Hono, store: NpcStore, dispatch: WebhookDispatcher): void {
  app.post('/webhook', async (c: Context) => {
    const rawBody = await c.req.text();

    let payload: WebhookPayload;
    try {
      payload = webhookPayloadSchema.parse(JSON.parse(rawBody));
    } catch {
      return c.json({ error: 'invalid_payload' }, 400);
    }

    // ホットパス（world 側 5 秒タイムアウト）なのでフル Npc 復元は避け、認証情報だけ引く。
    // NPC 未登録と署名不一致を外部から区別できないよう、どちらも 401 を返す。
    const auth = store.getWebhookAuthByAgentId(payload.agent_id);
    if (!auth) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const signatureHeader = c.req.header('x-karakuri-npc-signature') ?? '';
    const expected = `sha256=${signWebhookBody(rawBody, auth.webhook_secret)}`;
    if (!safeEqualHex(signatureHeader, expected)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    // world は常に delivery_id ヘッダーを送る。欠落時（手動テスト等）は一意 ID を振り、
    // dedupe（world の再送は同一 delivery_id）を誤発動させない。
    const deliveryId = c.req.header('x-karakuri-npc-delivery-id') ?? `manual-${randomUUID()}`;
    const isNew = store.insertDelivery({
      delivery_id: deliveryId,
      npc_id: auth.npc_id,
      notification_id: payload.notification_id,
      kind: payload.kind,
      received_at: Date.now(),
    });
    if (!isNew) {
      // 重複配送。処理済み/処理中なのでキューに積まず 200 を返す。
      return c.json({ ok: true, duplicate: true });
    }

    dispatch({ npcId: auth.npc_id, deliveryId, payload });
    return c.json({ ok: true });
  });
}
