import { openDatabase } from '../../src/storage/database.js';
import { NpcStore, type NpcCreateInput } from '../../src/storage/npc-store.js';
import type { AgentNotification } from '../../src/types/world.js';
import { WorldApiError, type FetchedNotification } from '../../src/world/client.js';

export function createTestStore(): NpcStore {
  return new NpcStore(openDatabase(':memory:'));
}

export function testNpcInput(overrides: Partial<NpcCreateInput> = {}): NpcCreateInput {
  return {
    name: 'テスト花子',
    world_base_url: 'https://world.test',
    agent_id: 'npc-world-agent-1',
    api_key: 'karakuri_testkey',
    webhook_secret: 'a'.repeat(64),
    enabled: true,
    ...overrides,
  };
}

export function testNotification(overrides: Partial<AgentNotification> = {}): AgentNotification {
  return {
    schema_version: 1,
    kind: 'idle_reminder',
    summary: '前回の行動から10分が経過しました。',
    choices: [
      { command: 'move', label: '移動する', required_params: ['target_node_id'] },
      { command: 'wait', label: '待機する', required_params: ['duration'] },
      { command: 'get_perception', label: '周囲を確認する' },
    ],
    ...overrides,
  };
}

/** WorldClient 互換のモック。呼び出しを記録し、設定した応答を返す。 */
export class MockWorldClient {
  loginCalls: Array<{ node_id?: string } | undefined> = [];
  logoutCalls = 0;
  commandCalls: Array<{ notificationId: string; command: string; params: Record<string, unknown> }> = [];
  notificationRequests: string[] = [];

  notifications = new Map<string, AgentNotification>();
  staleIds = new Set<string>();
  loginImpl: (placement?: { node_id?: string }) => Promise<unknown> = async () => ({ node_id: '5-5' });
  commandImpl: (notificationId: string, command: string, params: Record<string, unknown>) => Promise<unknown> =
    async () => ({ ok: true });
  getNotificationImpl: ((notificationId: string) => Promise<FetchedNotification>) | null = null;

  async login(placement?: { node_id?: string }): Promise<unknown> {
    this.loginCalls.push(placement);
    return this.loginImpl(placement);
  }

  async logout(): Promise<void> {
    this.logoutCalls += 1;
  }

  async getNotification(notificationId: string): Promise<FetchedNotification> {
    this.notificationRequests.push(notificationId);
    if (this.getNotificationImpl) return this.getNotificationImpl(notificationId);
    const notification = this.notifications.get(notificationId);
    if (!notification) {
      throw new WorldApiError(404, { error: 'not_found', message: `notification not found: ${notificationId}` }, 'not found');
    }
    return {
      notificationId,
      stale: this.staleIds.has(notificationId),
      expiresAt: Date.now() + 30 * 60 * 1000,
      notification,
    };
  }

  async command(notificationId: string, command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.commandCalls.push({ notificationId, command, params });
    return this.commandImpl(notificationId, command, params);
  }
}
