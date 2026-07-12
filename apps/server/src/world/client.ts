import { z } from 'zod';

import type { AgentNotification, WorldErrorBody, WorldLoginResult } from '../types/world.js';

/** world API のエラー。ステータスとエラーコードを正規化して保持する。 */
export class WorldApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly hint?: string;

  constructor(status: number, body: Partial<WorldErrorBody> | null, fallbackMessage: string) {
    super(body?.message ?? fallbackMessage);
    this.status = status;
    this.code = body?.error ?? 'unknown_error';
    this.details = body?.details;
    if (body?.hint !== undefined) this.hint = body.hint;
  }

  /** rate_limited (429) のリトライ可能秒数。無ければ null。 */
  get retryAfterSeconds(): number | null {
    if (this.status !== 429) return null;
    const details = this.details as { retry_after_seconds?: unknown } | undefined;
    return typeof details?.retry_after_seconds === 'number' ? details.retry_after_seconds : null;
  }
}

/**
 * GET /api/npc/notifications/:id のレスポンス。world は通知本体を
 * { ok, notification_id, created_at, expires_at, stale, notification } の
 * ラッパーに包んで返す（正本: world-engine.ts AgentNotificationResponse）。
 */
export interface FetchedNotification {
  notificationId: string;
  stale: boolean;
  expiresAt: number;
  notification: AgentNotification;
}

const fetchedNotificationSchema = z.looseObject({
  ok: z.literal(true),
  notification_id: z.string(),
  expires_at: z.number(),
  stale: z.boolean(),
  notification: z.looseObject({
    schema_version: z.number(),
    // 未知の kind でも受理する（world 側の追加に耐える）。ルーティングは文字列一致。
    kind: z.string(),
    summary: z.string(),
    choices: z.array(
      z.looseObject({
        command: z.string(),
        label: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
        required_params: z.array(z.string()).optional(),
      }),
    ),
    payload: z.record(z.string(), z.unknown()).optional(),
    perception: z.record(z.string(), z.unknown()).optional(),
  }),
});

export interface WorldClientOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type CreateWorldClient = (npc: { api_key: string }, options?: WorldClientOptions) => WorldClient;

/**
 * WorldClient の生成を一箇所に集約する（Manager / Runtime / Web API で共用）。
 * ベース URL は NPC ごとではなく .env の WORLD_BASE_URL に一本化されている。
 * 未設定時は生成時に throw する（呼び出し側でエラー表示 / failed 記録に変換する）。
 */
export function worldClientFactory(worldBaseUrl: string | undefined): CreateWorldClient {
  return (npc, options) => {
    if (!worldBaseUrl) {
      throw new Error('WORLD_BASE_URL が設定されていません（.env で指定してください）');
    }
    return new WorldClient(worldBaseUrl, npc.api_key, options);
  };
}

/**
 * karakuri-world の NPC 専用 API (/api/npc/*) の薄いクライアント。
 * 認証は NPC ごとの API key（Bearer）。
 */
export class WorldClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, apiKey: string, options: WorldClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async login(placement?: { node_id?: string }): Promise<WorldLoginResult> {
    const body = placement?.node_id ? { node_id: placement.node_id } : undefined;
    return (await this.request('POST', '/api/npc/login', body)) as WorldLoginResult;
  }

  async logout(): Promise<void> {
    await this.request('POST', '/api/npc/logout');
  }

  async getNotification(notificationId: string): Promise<FetchedNotification> {
    const raw = await this.request('GET', `/api/npc/notifications/${encodeURIComponent(notificationId)}`);
    const parsed = fetchedNotificationSchema.safeParse(raw);
    if (!parsed.success) {
      throw new WorldApiError(
        0,
        { error: 'invalid_notification_response', message: parsed.error.message },
        `unexpected notification response shape for ${notificationId}`,
      );
    }
    return {
      notificationId: parsed.data.notification_id,
      stale: parsed.data.stale,
      expiresAt: parsed.data.expires_at,
      notification: parsed.data.notification as AgentNotification,
    };
  }

  async command(notificationId: string, command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.request('POST', '/api/npc/command', {
      notification_id: notificationId,
      command,
      params,
    });
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError'
        ? `world API request timed out: ${method} ${path}`
        : `world API request failed: ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`;
      throw new WorldApiError(0, null, message);
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      throw new WorldApiError(
        response.status,
        (parsed as WorldErrorBody | null) ?? null,
        `world API responded with ${response.status}: ${method} ${path}`,
      );
    }
    return parsed;
  }
}
