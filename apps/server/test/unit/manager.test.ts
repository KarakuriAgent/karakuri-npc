import { describe, expect, it } from 'vitest';

import { NpcManager } from '../../src/runtime/manager.js';
import { WorldApiError, type WorldClient } from '../../src/world/client.js';
import { MockWorldClient, createTestStore, testNpcInput } from '../helpers/test-env.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function setup(npcOverrides = {}) {
  const store = createTestStore();
  const npc = store.createNpc(testNpcInput(npcOverrides));
  const client = new MockWorldClient();
  const manager = new NpcManager({
    store,
    handlers: {},
    createClient: () => client as unknown as WorldClient,
    logger: silentLogger,
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
    const { store, npc, client, manager } = setup();
    const npc2 = store.createNpc(testNpcInput({ agent_id: 'npc-world-agent-2', name: '二郎' }));
    let calls = 0;
    client.loginImpl = async () => {
      calls += 1;
      if (calls === 1) throw new WorldApiError(0, null, 'connection refused');
      return { node_id: '2-2' };
    };

    await manager.healthCheck();

    expect(store.getRuntime(npc.npc_id)?.last_error).toContain('connection refused');
    expect(store.getRuntime(npc2.npc_id)?.logged_in).toBe(true);
  });
});
