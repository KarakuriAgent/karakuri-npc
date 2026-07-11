import { describe, expect, it, vi } from 'vitest';

import { WorldApiError, WorldClient } from '../../src/world/client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return impl(url, init ?? {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('WorldClient', () => {
  it('login は node_id 指定時のみボディを送る', async () => {
    const { fetchImpl, calls } = mockFetch(async () => jsonResponse(200, { node_id: '5-5' }));
    const client = new WorldClient('https://world.test/', 'key', { fetchImpl });

    await client.login();
    expect(calls[0]!.url).toBe('https://world.test/api/npc/login');
    expect(calls[0]!.init.body).toBeUndefined();

    await client.login({ node_id: '7-8' });
    expect(calls[1]!.init.body).toBe(JSON.stringify({ node_id: '7-8' }));
    const headers = calls[1]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer key');
  });

  it('エラーレスポンスを WorldApiError に正規化する', async () => {
    const { fetchImpl } = mockFetch(async () =>
      jsonResponse(429, {
        error: 'rate_limited',
        message: 'Login with node_id is rate limited.',
        details: { retry_after_seconds: 123 },
      }),
    );
    const client = new WorldClient('https://world.test', 'key', { fetchImpl });

    const error = await client.login({ node_id: '1-1' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorldApiError);
    expect((error as WorldApiError).status).toBe(429);
    expect((error as WorldApiError).code).toBe('rate_limited');
    expect((error as WorldApiError).retryAfterSeconds).toBe(123);
  });

  it('command は notification_id / command / params を送る', async () => {
    const { fetchImpl, calls } = mockFetch(async () => jsonResponse(200, { ok: true }));
    const client = new WorldClient('https://world.test', 'key', { fetchImpl });

    await client.command('notif-1', 'wait', { duration: 1 });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      notification_id: 'notif-1',
      command: 'wait',
      params: { duration: 1 },
    });
  });

  it('getNotification はラッパーを剥がして通知本体を返す', async () => {
    const { fetchImpl, calls } = mockFetch(async () =>
      jsonResponse(200, {
        ok: true,
        notification_id: 'notif-1',
        created_at: 1,
        expires_at: 2,
        stale: false,
        notification: {
          schema_version: 1,
          kind: 'idle_reminder',
          summary: 'テスト',
          choices: [{ command: 'wait', label: '待機する' }],
        },
      }),
    );
    const client = new WorldClient('https://world.test', 'key', { fetchImpl });

    const fetched = await client.getNotification('notif-1');
    expect(calls[0]!.url).toBe('https://world.test/api/npc/notifications/notif-1');
    expect(fetched.stale).toBe(false);
    expect(fetched.notification.kind).toBe('idle_reminder');
    expect(fetched.notification.choices[0]!.command).toBe('wait');
  });

  it('getNotification は想定外のレスポンス形状を invalid_notification_response にする', async () => {
    const { fetchImpl } = mockFetch(async () => jsonResponse(200, { unexpected: true }));
    const client = new WorldClient('https://world.test', 'key', { fetchImpl });

    const error = await client.getNotification('notif-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorldApiError);
    expect((error as WorldApiError).code).toBe('invalid_notification_response');
  });

  it('ネットワークエラーは status 0 の WorldApiError になる', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const client = new WorldClient('https://world.test', 'key', { fetchImpl });

    const error = await client.logout().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorldApiError);
    expect((error as WorldApiError).status).toBe(0);
  });
});
