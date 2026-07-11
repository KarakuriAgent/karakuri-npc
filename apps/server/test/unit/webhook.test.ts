import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { registerWebhookRoute, signWebhookBody, type WebhookDispatch } from '../../src/webhook/receiver.js';
import { createTestStore, testNpcInput } from '../helpers/test-env.js';

function buildApp() {
  const store = createTestStore();
  const npc = store.createNpc(testNpcInput());
  const dispatched: WebhookDispatch[] = [];
  const app = new Hono();
  registerWebhookRoute(app, store, (dispatch) => dispatched.push(dispatch));
  return { app, store, npc, dispatched };
}

function webhookRequest(body: string, secret: string, deliveryId = 'delivery-1'): Request {
  return new Request('http://localhost/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
      'X-Karakuri-Npc-Signature': `sha256=${signWebhookBody(body, secret)}`,
      'X-Karakuri-Npc-Delivery-Id': deliveryId,
    },
    body,
  });
}

const validBody = JSON.stringify({
  notification_id: 'notif-1',
  agent_id: 'npc-world-agent-1',
  kind: 'idle_reminder',
  triggered_at: 1_700_000_000_000,
});

describe('webhook receiver', () => {
  it('正しい署名の webhook を受理してキューへ投入する', async () => {
    const { app, store, npc, dispatched } = buildApp();
    const res = await app.request(webhookRequest(validBody, npc.webhook_secret));

    expect(res.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ npcId: npc.npc_id, deliveryId: 'delivery-1' });
    expect(store.getDelivery('delivery-1')?.status).toBe('received');
  });

  it('署名が不正なら 401 でキューに積まない', async () => {
    const { app, dispatched } = buildApp();
    const res = await app.request(webhookRequest(validBody, 'wrong-secret'));

    expect(res.status).toBe(401);
    expect(dispatched).toHaveLength(0);
  });

  it('未知の agent_id は 401（存在を漏らさない）', async () => {
    const { app, npc, dispatched } = buildApp();
    const body = JSON.stringify({
      notification_id: 'notif-1',
      agent_id: 'unknown-agent',
      kind: 'idle_reminder',
      triggered_at: 1,
    });
    const res = await app.request(webhookRequest(body, npc.webhook_secret));

    expect(res.status).toBe(401);
    expect(dispatched).toHaveLength(0);
  });

  it('同じ delivery_id の再送は 200 を返しつつ二重処理しない', async () => {
    const { app, npc, dispatched } = buildApp();
    const first = await app.request(webhookRequest(validBody, npc.webhook_secret));
    const second = await app.request(webhookRequest(validBody, npc.webhook_secret));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true });
    expect(dispatched).toHaveLength(1);
  });

  it('壊れたボディは 400', async () => {
    const { app, npc } = buildApp();
    const res = await app.request(webhookRequest('{not json', npc.webhook_secret));
    expect(res.status).toBe(400);
  });
});
