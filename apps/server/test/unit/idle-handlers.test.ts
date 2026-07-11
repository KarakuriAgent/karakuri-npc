import { describe, expect, it } from 'vitest';

import { createIdleHandlers } from '../../src/runtime/handlers/idle.js';
import { NpcRuntime } from '../../src/runtime/npc-runtime.js';
import { WorldApiError, type WorldClient } from '../../src/world/client.js';
import { MockWorldClient, createTestStore, testNotification, testNpcInput } from '../helpers/test-env.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** 変動する決定的乱数列（先頭 0 → move_probability 判定に必ず当たる）。 */
function testRandom(): () => number {
  const values = [0, 0.13, 0.87, 0.42, 0.68, 0.25, 0.91, 0.56, 0.34, 0.79, 0.05, 0.62];
  let index = 0;
  return () => values[index++ % values.length]!;
}

function setup(npcOverrides = {}) {
  const store = createTestStore();
  const npc = store.createNpc(testNpcInput(npcOverrides));
  const client = new MockWorldClient();
  const runtime = new NpcRuntime(npc.npc_id, {
    store,
    handlers: createIdleHandlers(store, testRandom()),
    createClient: () => client as unknown as WorldClient,
    logger: silentLogger,
  });
  return { store, npc, client, runtime };
}

function enqueue(store: ReturnType<typeof createTestStore>, npcId: string, notificationId: string): void {
  store.insertDelivery({
    delivery_id: `delivery-${notificationId}`,
    npc_id: npcId,
    notification_id: notificationId,
    kind: 'idle_reminder',
    received_at: Date.now(),
  });
}

describe('idle handlers 統合', () => {
  it('random モード: move が拒否されたら次の候補を試し、受理されたら止まる', async () => {
    const { store, npc, client, runtime } = setup({
      movement: { mode: 'random', anchor_node_id: '10-10', range: { rows: 2, cols: 2 }, move_probability: 1 },
    });
    store.patchRuntime(npc.npc_id, { status_synced_at: Date.now() }); // status 同期をスキップ
    client.notifications.set('notif-1', testNotification());
    enqueue(store, npc.npc_id, 'notif-1');

    let attempts = 0;
    client.commandImpl = async (_id, command) => {
      if (command === 'move') {
        attempts += 1;
        if (attempts === 1) {
          throw new WorldApiError(400, { error: 'invalid_move_target', message: 'wall' }, 'wall');
        }
        return { ok: true, status: 'started' };
      }
      return { ok: true };
    };

    runtime.enqueueDelivery('delivery-notif-1');
    await runtime.drain();

    const moveCalls = client.commandCalls.filter((c) => c.command === 'move');
    expect(moveCalls.length).toBe(2); // 1回目拒否 → 2回目受理で停止
    expect(store.getDelivery('delivery-notif-1')?.status).toBe('done');
  });

  it('状態ミラーが古ければ idle 契機を get_status に使う', async () => {
    const { store, npc, client, runtime } = setup();
    client.notifications.set('notif-1', testNotification({
      choices: [
        { command: 'move', label: '移動する' },
        { command: 'wait', label: '待機する' },
        { command: 'get_status', label: '状態を確認する' },
      ],
    }));
    enqueue(store, npc.npc_id, 'notif-1');
    client.commandImpl = async () => ({
      ok: true,
      command: 'get_status',
      data: { current_world_id: 'main', node_id: '7-7', location_label: '広場', money: 800, items: [] },
    });

    runtime.enqueueDelivery('delivery-notif-1');
    await runtime.drain();

    expect(client.commandCalls).toEqual([
      { notificationId: 'notif-1', command: 'get_status', params: {} },
    ]);
    const state = store.getRuntime(npc.npc_id);
    expect(state).toMatchObject({ node_id: '7-7', world_id: 'main', money: 800 });
    expect(state?.status_synced_at).toBeGreaterThan(0);
  });

  it('perception 付き通知で状態ミラーが更新される', async () => {
    const { store, npc, client, runtime } = setup();
    store.patchRuntime(npc.npc_id, { status_synced_at: Date.now() });
    client.notifications.set('notif-1', testNotification({
      kind: 'movement_completed',
      perception: {
        current_world_id: 'main',
        current_node: { node_id: '12-34' },
        money: 1200,
        nearby_nodes: [],
      },
    }));
    store.insertDelivery({
      delivery_id: 'delivery-1',
      npc_id: npc.npc_id,
      notification_id: 'notif-1',
      kind: 'movement_completed',
      received_at: Date.now(),
    });

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(store.getRuntime(npc.npc_id)).toMatchObject({ node_id: '12-34', world_id: 'main', money: 1200 });
  });

  it('server_announcement は何もしない', async () => {
    const { store, npc, client, runtime } = setup();
    client.notifications.set('notif-1', testNotification({ kind: 'server_announcement' }));
    store.insertDelivery({
      delivery_id: 'delivery-1',
      npc_id: npc.npc_id,
      notification_id: 'notif-1',
      kind: 'server_announcement',
      received_at: Date.now(),
    });

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(client.commandCalls).toHaveLength(0);
    expect(store.getDelivery('delivery-1')?.status).toBe('done');
  });
});
