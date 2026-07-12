import { afterEach, describe, expect, it, vi } from 'vitest';

import { NpcManager } from '../../src/runtime/manager.js';
import { WorldApiError, type WorldClient } from '../../src/world/client.js';
import { MockWorldClient, createTestStore, testNpcInput } from '../helpers/test-env.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function setup(npcOverrides = {}, managerOverrides = {}) {
  const store = createTestStore();
  const npc = store.createNpc(testNpcInput(npcOverrides));
  const client = new MockWorldClient();
  const manager = new NpcManager({
    store,
    handlers: {},
    createClient: () => client as unknown as WorldClient,
    logger: silentLogger,
    ...managerOverrides,
  });
  return { store, npc, client, manager };
}

describe('NpcManager', () => {
  it('enabled な NPC をヘルスチェックでログインさせる', async () => {
    const { store, npc, client, manager } = setup();

    await manager.healthCheck();

    expect(client.loginCalls).toHaveLength(1);
    expect(store.getRuntime(npc.npc_id)).toMatchObject({ logged_in: true, node_id: '5-5', agent_state: 'idle' });
  });

  it('home_node_id があれば位置指定ログインし、429 なら位置指定なしにフォールバックする', async () => {
    const { store, npc, client, manager } = setup({ home_node_id: '10-10' });
    client.loginImpl = async (placement) => {
      if (placement?.node_id) {
        throw new WorldApiError(
          429,
          { error: 'rate_limited', message: 'rate limited', details: { retry_after_seconds: 60 } },
          'rate limited',
        );
      }
      return { node_id: '9-9' };
    };

    await manager.healthCheck();

    expect(client.loginCalls).toEqual([{ node_id: '10-10' }, undefined]);
    expect(store.getRuntime(npc.npc_id)?.node_id).toBe('9-9');
  });

  it('既にログイン済み (state_conflict) は成功として扱う', async () => {
    const { store, npc, client, manager } = setup();
    client.loginImpl = async () => {
      throw new WorldApiError(409, { error: 'state_conflict', message: 'Agent is already logged in: x' }, 'x');
    };

    await manager.healthCheck();
    expect(store.getRuntime(npc.npc_id)?.logged_in).toBe(true);
  });

  it('disabled でログイン中の NPC をログアウトさせる', async () => {
    const { store, npc, client, manager } = setup({ enabled: false });
    store.patchRuntime(npc.npc_id, { logged_in: true });

    await manager.healthCheck();

    expect(client.logoutCalls).toBe(1);
    expect(store.getRuntime(npc.npc_id)?.logged_in).toBe(false);
  });

  it('ログイン失敗は last_error に記録して他の NPC の処理を続ける', async () => {
    const store = createTestStore();
    const npc = store.createNpc(testNpcInput());
    const npc2 = store.createNpc(testNpcInput({ agent_id: 'npc-world-agent-2', name: '二郎' }));
    const failingClient = new MockWorldClient();
    failingClient.loginImpl = async () => {
      throw new WorldApiError(0, null, 'connection refused');
    };
    const okClient = new MockWorldClient();
    const manager = new NpcManager({
      store,
      handlers: {},
      createClient: (target) =>
        (target.npc_id === npc.npc_id ? failingClient : okClient) as unknown as WorldClient,
      logger: silentLogger,
    });

    await manager.healthCheck();

    expect(store.getRuntime(npc.npc_id)?.last_error).toContain('connection refused');
    expect(store.getRuntime(npc2.npc_id)?.logged_in).toBe(true);
  });
});

describe('NpcManager スケジュール', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // 2026-07-13 は月曜日
  const daySchedule = { windows: [{ start: '09:00', end: '18:00' }], logout_grace_minutes: 30 };

  it('時間帯内ならログインさせ、時間帯前ならログインさせない', async () => {
    vi.useFakeTimers();
    const { store, npc, client, manager } = setup({ schedule: daySchedule });

    vi.setSystemTime(new Date('2026-07-13T08:00:00'));
    await manager.healthCheck();
    expect(client.loginCalls).toHaveLength(0);

    vi.setSystemTime(new Date('2026-07-13T09:00:30'));
    await manager.healthCheck();
    expect(client.loginCalls).toHaveLength(1);
    expect(store.getRuntime(npc.npc_id)?.logged_in).toBe(true);
  });

  it('時間帯終了後は即ログアウトせず logout_pending_since を立てる', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T18:01:00'));
    const { store, npc, client, manager } = setup({ schedule: daySchedule });
    store.patchRuntime(npc.npc_id, { logged_in: true });

    await manager.healthCheck();

    expect(client.logoutCalls).toBe(0);
    expect(store.getRuntime(npc.npc_id)?.logout_pending_since).toBe(Date.now());
  });

  it('猶予を超えたら強制ログアウトする', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T18:01:00'));
    const { store, npc, client, manager } = setup({ schedule: daySchedule });
    store.patchRuntime(npc.npc_id, { logged_in: true });
    await manager.healthCheck();
    expect(client.logoutCalls).toBe(0);

    vi.setSystemTime(new Date('2026-07-13T18:32:00'));
    await manager.healthCheck();

    expect(client.logoutCalls).toBe(1);
    const runtime = store.getRuntime(npc.npc_id);
    expect(runtime?.logged_in).toBe(false);
    expect(runtime?.logout_pending_since).toBeNull();
  });

  it('時間帯に戻ったらログオフ保留を解除する', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T18:01:00'));
    const { store, npc, client, manager } = setup({ schedule: daySchedule });
    store.patchRuntime(npc.npc_id, { logged_in: true });
    await manager.healthCheck();
    expect(store.getRuntime(npc.npc_id)?.logout_pending_since).not.toBeNull();

    // （手動でスケジュールを広げた等で）時間帯内に戻ったケース
    vi.setSystemTime(new Date('2026-07-14T09:05:00'));
    await manager.healthCheck();

    expect(client.logoutCalls).toBe(0);
    expect(store.getRuntime(npc.npc_id)?.logout_pending_since).toBeNull();
  });

  it('ログアウト時にローカルの active な会話を閉じる', async () => {
    const closed: Array<{ npcId: string; reason: string }> = [];
    const { store, npc, client, manager } = setup(
      { enabled: false },
      { closeActiveConversation: (npcId: string, reason: string) => closed.push({ npcId, reason }) },
    );
    store.patchRuntime(npc.npc_id, { logged_in: true });

    await manager.healthCheck();

    expect(client.logoutCalls).toBe(1);
    expect(closed).toEqual([{ npcId: npc.npc_id, reason: 'npc_logged_out' }]);
  });

  it('PATCH で schedule を部分指定しても未指定フィールドは維持される', () => {
    const { store, npc } = setup({
      schedule: { windows: [{ start: '09:00', end: '18:00' }], logout_grace_minutes: 60 },
    });

    const updated = store.updateNpc(npc.npc_id, { schedule: { logout_grace_minutes: 10 } });

    expect(updated?.schedule.windows).toHaveLength(1);
    expect(updated?.schedule.logout_grace_minutes).toBe(10);
  });

  it('手動停止（enabled=false）はスケジュールに関係なく即ログアウトする', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T12:00:00'));
    const { store, npc, client, manager } = setup({ enabled: false, schedule: daySchedule });
    store.patchRuntime(npc.npc_id, { logged_in: true });

    await manager.healthCheck();

    expect(client.logoutCalls).toBe(1);
    expect(store.getRuntime(npc.npc_id)?.logged_in).toBe(false);
  });
});
