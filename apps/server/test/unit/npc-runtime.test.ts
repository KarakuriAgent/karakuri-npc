import { afterEach, describe, expect, it, vi } from 'vitest';

import { NpcRuntime } from '../../src/runtime/npc-runtime.js';
import type { NpcStore } from '../../src/storage/npc-store.js';
import { WorldApiError, type WorldClient } from '../../src/world/client.js';
import { MockWorldClient, createTestStore, testNotification, testNpcInput } from '../helpers/test-env.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function setup(handlers = {}) {
  const store = createTestStore();
  const npc = store.createNpc(testNpcInput());
  const client = new MockWorldClient();
  const runtime = new NpcRuntime(npc.npc_id, {
    store,
    handlers,
    createClient: () => client as unknown as WorldClient,
    logger: silentLogger,
  });
  return { store, npc, client, runtime };
}

function enqueue(store: NpcStore, npcId: string, deliveryId: string, notificationId: string): void {
  store.insertDelivery({
    delivery_id: deliveryId,
    npc_id: npcId,
    notification_id: notificationId,
    kind: 'idle_reminder',
    received_at: Date.now(),
  });
}

describe('NpcRuntime', () => {
  it('通知をフェッチしてフォールバック（wait）を実行する', async () => {
    const { store, npc, client, runtime } = setup();
    client.notifications.set('notif-1', testNotification());
    enqueue(store, npc.npc_id, 'delivery-1', 'notif-1');

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(client.commandCalls).toEqual([
      { notificationId: 'notif-1', command: 'wait', params: { duration: 1 } },
    ]);
    const delivery = store.getDelivery('delivery-1');
    expect(delivery?.status).toBe('done');
    expect(delivery?.notification_json).toContain('idle_reminder');
    expect(store.listCommandLog(npc.npc_id)).toHaveLength(1);
  });

  it('createClient が throw したら delivery を failed にして last_error を残す', async () => {
    const store = createTestStore();
    const npc = store.createNpc(testNpcInput());
    const runtime = new NpcRuntime(npc.npc_id, {
      store,
      handlers: {},
      createClient: () => {
        throw new Error('WORLD_BASE_URL が設定されていません（.env で指定してください）');
      },
      logger: silentLogger,
    });
    enqueue(store, npc.npc_id, 'delivery-1', 'notif-1');

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    const delivery = store.getDelivery('delivery-1');
    expect(delivery?.status).toBe('failed');
    expect(delivery?.error).toContain('WORLD_BASE_URL');
    expect(store.getRuntime(npc.npc_id)?.last_error).toContain('WORLD_BASE_URL');
  });

  it('choices に wait が無ければコマンドを実行しない', async () => {
    const { store, npc, client, runtime } = setup();
    client.notifications.set('notif-1', testNotification({ choices: [] }));
    enqueue(store, npc.npc_id, 'delivery-1', 'notif-1');

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(client.commandCalls).toHaveLength(0);
    expect(store.getDelivery('delivery-1')?.status).toBe('done');
  });

  it('kind 別ハンドラが登録されていればそちらを使う', async () => {
    const { store, npc, client, runtime } = setup({
      idle_reminder: () => ({ command: 'get_status', params: {} }),
    });
    client.notifications.set('notif-1', testNotification());
    enqueue(store, npc.npc_id, 'delivery-1', 'notif-1');

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(client.commandCalls[0]).toMatchObject({ command: 'get_status' });
  });

  it('notification_stale は最新通知で 1 回だけ再決定する', async () => {
    const { store, npc, client, runtime } = setup();
    client.notifications.set('notif-old', testNotification());
    enqueue(store, npc.npc_id, 'delivery-1', 'notif-old');

    let calls = 0;
    client.commandImpl = async (notificationId) => {
      calls += 1;
      if (notificationId === 'notif-old') {
        throw new WorldApiError(
          409,
          {
            error: 'notification_stale',
            message: 'stale',
            details: {
              latest_notification_id: 'notif-new',
              latest_notification: testNotification(),
            },
          },
          'stale',
        );
      }
      return { ok: true };
    };

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(calls).toBe(2);
    expect(client.commandCalls[1]).toMatchObject({ notificationId: 'notif-new', command: 'wait' });
    expect(store.getDelivery('delivery-1')?.status).toBe('done');
  });

  it('state_conflict は握りつぶして delivery を done にする', async () => {
    const { store, npc, client, runtime } = setup();
    client.notifications.set('notif-1', testNotification());
    enqueue(store, npc.npc_id, 'delivery-1', 'notif-1');
    client.commandImpl = async () => {
      throw new WorldApiError(409, { error: 'state_conflict', message: 'busy' }, 'busy');
    };

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(store.getDelivery('delivery-1')?.status).toBe('done');
    expect(store.getRuntime(npc.npc_id)?.last_error).toContain('state_conflict');
  });

  it('not_logged_in で runtime を logged_out に落とす', async () => {
    const { store, npc, client, runtime } = setup();
    store.patchRuntime(npc.npc_id, { logged_in: true });
    client.notifications.set('notif-1', testNotification());
    enqueue(store, npc.npc_id, 'delivery-1', 'notif-1');
    client.commandImpl = async () => {
      throw new WorldApiError(403, { error: 'not_logged_in', message: 'not logged in' }, 'not logged in');
    };

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(store.getRuntime(npc.npc_id)?.logged_in).toBe(false);
    expect(store.getDelivery('delivery-1')?.status).toBe('failed');
  });

  it('通知フェッチ失敗は delivery を failed にする', async () => {
    const { store, npc, runtime } = setup();
    enqueue(store, npc.npc_id, 'delivery-1', 'missing-notif');

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(store.getDelivery('delivery-1')?.status).toBe('failed');
    expect(store.getDelivery('delivery-1')?.error).toContain('notification_fetch_failed');
  });

  it('stale 通知はコマンドを実行せず skipped にする', async () => {
    const { store, npc, client, runtime } = setup();
    client.notifications.set('notif-1', testNotification());
    client.staleIds.add('notif-1');
    enqueue(store, npc.npc_id, 'delivery-1', 'notif-1');

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(client.commandCalls).toHaveLength(0);
    expect(store.getDelivery('delivery-1')?.status).toBe('skipped');
  });

  it('通知フェッチ時の not_logged_in でも runtime を logged_out に落とす', async () => {
    const { store, npc, client, runtime } = setup();
    store.patchRuntime(npc.npc_id, { logged_in: true });
    client.getNotificationImpl = async () => {
      throw new WorldApiError(403, { error: 'not_logged_in', message: 'not logged in' }, 'not logged in');
    };
    enqueue(store, npc.npc_id, 'delivery-1', 'notif-1');

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(store.getRuntime(npc.npc_id)?.logged_in).toBe(false);
    expect(store.getDelivery('delivery-1')?.status).toBe('failed');
  });

  it('agent_logged_out ハンドラで状態ミラーを落とす', async () => {
    const { createLifecycleHandlers } = await import('../../src/runtime/handlers/lifecycle.js');
    const store = createTestStore();
    const npc = store.createNpc(testNpcInput());
    store.patchRuntime(npc.npc_id, { logged_in: true });
    const client = new MockWorldClient();
    const runtime = new NpcRuntime(npc.npc_id, {
      store,
      handlers: createLifecycleHandlers(store),
      createClient: () => client as unknown as WorldClient,
      logger: silentLogger,
    });
    client.notifications.set('notif-1', testNotification({ kind: 'agent_logged_out', choices: [] }));
    enqueue(store, npc.npc_id, 'delivery-1', 'notif-1');

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(store.getRuntime(npc.npc_id)?.logged_in).toBe(false);
    expect(client.commandCalls).toHaveLength(0);
  });
});

describe('NpcRuntime スケジュール時間外のログオフ', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // 2026-07-13T20:00 は時間帯（09:00〜18:00）の外
  const daySchedule = { windows: [{ start: '09:00', end: '18:00' }], logout_grace_minutes: 30 };

  function setupScheduled(options: { inConversation?: boolean; handlers?: object } = {}) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T20:00:00'));
    const store = createTestStore();
    const npc = store.createNpc(testNpcInput({ schedule: daySchedule }));
    store.patchRuntime(npc.npc_id, { logged_in: true });
    const client = new MockWorldClient();
    const logoutCalls: string[] = [];
    let conversationActive = options.inConversation ?? false;
    const runtime = new NpcRuntime(npc.npc_id, {
      store,
      handlers: options.handlers ?? {},
      createClient: () => client as unknown as WorldClient,
      logger: silentLogger,
      logout: async (target) => {
        logoutCalls.push(target.npc_id);
        store.patchRuntime(target.npc_id, { logged_in: false, logout_pending_since: null });
      },
      hasActiveConversation: () => conversationActive,
    });
    return { store, npc, client, runtime, logoutCalls, endConversation: () => (conversationActive = false) };
  }

  it('時間外の通知は行動せずログオフする', async () => {
    const { store, npc, client, runtime, logoutCalls } = setupScheduled();
    client.notifications.set('notif-1', testNotification());
    enqueue(store, npc.npc_id, 'delivery-1', 'notif-1');

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(client.commandCalls).toHaveLength(0);
    expect(logoutCalls).toEqual([npc.npc_id]);
    expect(store.getDelivery('delivery-1')?.status).toBe('done');
  });

  it('時間外の新規会話リクエストは reject してからログオフする', async () => {
    const { store, npc, client, runtime, logoutCalls } = setupScheduled();
    client.notifications.set(
      'notif-1',
      testNotification({
        kind: 'conversation_request',
        choices: [
          { command: 'conversation_accept', label: '受ける', required_params: ['message'] },
          { command: 'conversation_reject', label: '断る' },
        ],
      }),
    );
    enqueue(store, npc.npc_id, 'delivery-1', 'notif-1');

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(client.commandCalls).toEqual([
      { notificationId: 'notif-1', command: 'conversation_reject', params: {} },
    ]);
    expect(logoutCalls).toEqual([npc.npc_id]);
  });

  it('会話中は時間外でも通常処理を続ける', async () => {
    const { store, npc, client, runtime, logoutCalls } = setupScheduled({
      inConversation: true,
      handlers: { idle_reminder: () => ({ command: 'conversation_speak', params: { message: 'はい' } }) },
    });
    client.notifications.set('notif-1', testNotification());
    enqueue(store, npc.npc_id, 'delivery-1', 'notif-1');

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(client.commandCalls[0]).toMatchObject({ command: 'conversation_speak' });
    expect(logoutCalls).toEqual([]);
  });

  it('ハンドラ内で会話が終わったら後続の行動を破棄してログオフする', async () => {
    // conversation_ended 相当: ハンドラが会話を閉じ、次の行動（wait）を返すケース
    const { store, npc, client, runtime, logoutCalls, endConversation } = setupScheduled({
      inConversation: true,
      handlers: {
        idle_reminder: () => {
          endConversation();
          return { command: 'wait', params: { duration: 1 } };
        },
      },
    });
    client.notifications.set('notif-1', testNotification());
    enqueue(store, npc.npc_id, 'delivery-1', 'notif-1');

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(client.commandCalls).toHaveLength(0);
    expect(logoutCalls).toEqual([npc.npc_id]);
    expect(store.getDelivery('delivery-1')?.status).toBe('done');
  });

  it('時間外でも応答が必要な通知（transfer 等）は処理してからログオフする', async () => {
    const { store, npc, client, runtime, logoutCalls } = setupScheduled({
      handlers: { transfer_request: () => ({ command: 'transfer_accept', params: {} }) },
    });
    client.notifications.set(
      'notif-1',
      testNotification({
        kind: 'transfer_request',
        choices: [
          { command: 'transfer_accept', label: '受け取る' },
          { command: 'transfer_reject', label: '断る' },
        ],
      }),
    );
    enqueue(store, npc.npc_id, 'delivery-1', 'notif-1');

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(client.commandCalls).toEqual([{ notificationId: 'notif-1', command: 'transfer_accept', params: {} }]);
    expect(logoutCalls).toEqual([npc.npc_id]);
  });

  it('会話中でも時間外の新規会話リクエストは reject する', async () => {
    const { store, npc, client, runtime, logoutCalls } = setupScheduled({ inConversation: true });
    client.notifications.set(
      'notif-1',
      testNotification({
        kind: 'conversation_request',
        choices: [
          { command: 'conversation_accept', label: '受ける', required_params: ['message'] },
          { command: 'conversation_reject', label: '断る' },
        ],
      }),
    );
    enqueue(store, npc.npc_id, 'delivery-1', 'notif-1');

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(client.commandCalls).toEqual([{ notificationId: 'notif-1', command: 'conversation_reject', params: {} }]);
    // 既存会話が続いているうちはログオフしない
    expect(logoutCalls).toEqual([]);
  });

  it('手動停止（enabled=false）中の通知は会話中でも行動せずログオフする', async () => {
    const { store, npc, client, runtime, logoutCalls } = setupScheduled({ inConversation: true });
    store.updateNpc(npc.npc_id, { enabled: false });
    client.notifications.set('notif-1', testNotification());
    enqueue(store, npc.npc_id, 'delivery-1', 'notif-1');

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(client.commandCalls).toHaveLength(0);
    expect(logoutCalls).toEqual([npc.npc_id]);
    expect(store.getDelivery('delivery-1')?.status).toBe('done');
  });

  it('既にログアウト済みなら重ねてログオフしない', async () => {
    const { store, npc, client, runtime, logoutCalls } = setupScheduled();
    store.patchRuntime(npc.npc_id, { logged_in: false });
    client.notifications.set('notif-1', testNotification());
    enqueue(store, npc.npc_id, 'delivery-1', 'notif-1');

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(logoutCalls).toEqual([]);
    expect(store.getDelivery('delivery-1')?.status).toBe('done');
  });

  it('時間帯内なら通常通り行動する', async () => {
    const { store, npc, client, runtime, logoutCalls } = setupScheduled();
    vi.setSystemTime(new Date('2026-07-13T12:00:00'));
    client.notifications.set('notif-1', testNotification());
    enqueue(store, npc.npc_id, 'delivery-1', 'notif-1');

    runtime.enqueueDelivery('delivery-1');
    await runtime.drain();

    expect(client.commandCalls[0]).toMatchObject({ command: 'wait' });
    expect(logoutCalls).toEqual([]);
  });
});
