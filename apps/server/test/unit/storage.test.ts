import { describe, expect, it } from 'vitest';

import { createTestStore, testNpcInput } from '../helpers/test-env.js';

describe('NpcStore', () => {
  it('NPC を作成・取得・更新・削除できる', () => {
    const store = createTestStore();
    const npc = store.createNpc(testNpcInput());

    expect(npc.npc_id).toMatch(/^npc-local-/);
    expect(npc.movement.mode).toBe('stationary');
    expect(npc.conversation.max_history_pairs).toBe(15);
    expect(store.getNpcByAgentId('npc-world-agent-1')?.npc_id).toBe(npc.npc_id);

    const updated = store.updateNpc(npc.npc_id, {
      persona: '駅前のパン屋の店主',
      movement: { mode: 'random', anchor_node_id: '10-10', range: { rows: 3, cols: 3 } },
      home_node_id: '10-10',
    });
    expect(updated?.persona).toBe('駅前のパン屋の店主');
    expect(updated?.movement.mode).toBe('random');
    expect(updated?.movement.move_probability).toBe(0.5);
    expect(updated?.home_node_id).toBe('10-10');

    expect(store.deleteNpc(npc.npc_id)).toBe(true);
    expect(store.getNpc(npc.npc_id)).toBeNull();
  });

  it('不正な movement 設定はエラーになる', () => {
    const store = createTestStore();
    const npc = store.createNpc(testNpcInput());
    expect(() => store.updateNpc(npc.npc_id, { movement: { mode: 'flying' } })).toThrow();
  });

  it('delivery_id で重複配送を排除できる', () => {
    const store = createTestStore();
    const npc = store.createNpc(testNpcInput());
    const record = {
      delivery_id: 'delivery-1',
      npc_id: npc.npc_id,
      notification_id: 'notif-1',
      kind: 'idle_reminder',
      received_at: Date.now(),
    };
    expect(store.insertDelivery(record)).toBe(true);
    expect(store.insertDelivery(record)).toBe(false);

    store.updateDelivery('delivery-1', { status: 'done' });
    expect(store.getDelivery('delivery-1')?.status).toBe('done');
  });

  it('リカバリ対象は received のみで、processing は failed に落とせる', () => {
    const store = createTestStore();
    const npc = store.createNpc(testNpcInput());
    const now = Date.now();
    const base = { npc_id: npc.npc_id, kind: 'idle_reminder' };
    store.insertDelivery({ ...base, delivery_id: 'old', notification_id: 'n-old', received_at: now - 60 * 60 * 1000 });
    store.insertDelivery({ ...base, delivery_id: 'fresh', notification_id: 'n-fresh', received_at: now });
    store.insertDelivery({ ...base, delivery_id: 'done', notification_id: 'n-done', received_at: now });
    store.insertDelivery({ ...base, delivery_id: 'inflight', notification_id: 'n-inflight', received_at: now });
    store.updateDelivery('done', { status: 'done' });
    store.updateDelivery('inflight', { status: 'processing' });

    const since = now - 30 * 60 * 1000;
    // processing(コマンド送信済みか不明)は再実行対象にしない
    expect(store.listRecoverableDeliveries(since).map((d) => d.delivery_id)).toEqual(['fresh']);

    expect(store.markAbandonedProcessingDeliveries(since)).toBe(1);
    expect(store.getDelivery('inflight')?.status).toBe('failed');
    expect(store.getDelivery('inflight')?.error).toBe('abandoned_on_restart');
  });

  it('webhook 認証用の軽量ルックアップが引ける', () => {
    const store = createTestStore();
    const npc = store.createNpc(testNpcInput());
    expect(store.getWebhookAuthByAgentId('npc-world-agent-1')).toEqual({
      npc_id: npc.npc_id,
      webhook_secret: 'a'.repeat(64),
    });
    expect(store.getWebhookAuthByAgentId('unknown')).toBeNull();
  });

  it('runtime 状態を部分更新できる', () => {
    const store = createTestStore();
    const npc = store.createNpc(testNpcInput());
    store.patchRuntime(npc.npc_id, { logged_in: true, node_id: '3-4', money: 500 });
    store.patchRuntime(npc.npc_id, { agent_state: 'idle' });

    const runtime = store.getRuntime(npc.npc_id);
    expect(runtime).toMatchObject({ logged_in: true, node_id: '3-4', money: 500, agent_state: 'idle' });
  });

  it('settings を読み書きできる', () => {
    const store = createTestStore();
    expect(store.getSetting('llm')).toBeNull();
    store.setSetting('llm', '{"provider":"openai_compatible"}');
    store.setSetting('llm', '{"provider":"anthropic"}');
    expect(store.getSetting('llm')).toBe('{"provider":"anthropic"}');
  });
});
