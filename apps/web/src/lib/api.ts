export interface NpcRuntimeState {
  npc_id: string;
  logged_in: boolean;
  world_id: string | null;
  node_id: string | null;
  agent_state: string | null;
  money: number | null;
  items: Array<{ item_id: string; name?: string }> | null;
  last_notification_at: number | null;
  last_command_at: number | null;
  last_error: string | null;
  status_synced_at: number | null;
  logout_pending_since: number | null;
}

export interface ScheduleWindow {
  /** 開始時刻が属する曜日（0=日〜6=土）。省略 or 空 = 毎日。 */
  days?: number[];
  start: string;
  end: string;
}

export interface ScheduleConfig {
  windows: ScheduleWindow[];
  logout_grace_minutes: number;
}

export interface MovementConfig {
  mode: 'random' | 'stationary';
  anchor_node_id?: string;
  range: { rows: number; cols: number };
  move_probability: number;
  rest_duration: number;
}

export interface NpcDto {
  npc_id: string;
  name: string;
  enabled: boolean;
  agent_id: string;
  api_key_masked: string;
  webhook_secret_masked: string;
  persona: string;
  rules: string;
  home_node_id: string | null;
  movement: MovementConfig;
  conversation: { accept: string; inactive_check: string; max_history_pairs: number };
  transfer: { receive: string; give_enabled: boolean };
  llm: { provider?: string; base_url?: string; api_key?: string; model?: string; temperature?: number; system_prompt_extra?: string };
  schedule: ScheduleConfig;
  /** 現在時刻がログイン時間帯内か（サーバー TZ で判定済み）。 */
  schedule_active: boolean;
  created_at: number;
  updated_at: number;
  runtime: NpcRuntimeState | null;
}

export interface ConversationDto {
  conversation_id: string;
  participants: Array<{ id: string; name: string }>;
  counterpart_agent_id: string | null;
  status: string;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
}

export interface MessageDto {
  id: number;
  conversation_id: string;
  turn: number | null;
  speaker_agent_id: string | null;
  speaker_name: string | null;
  is_self: boolean;
  message: string;
  created_at: number;
}

export interface MemoryDto {
  counterpart_agent_id: string;
  counterpart_name: string | null;
  summary: string;
  conversation_count: number;
  last_talked_at: number | null;
  updated_at: number;
}

export interface WorldMapSummary {
  world_id: string;
  name: string;
  rows: number;
  cols: number;
  error?: string;
}

export interface WorldMapNode {
  type: string;
  label?: string;
  building_id?: string;
}

export interface WorldSubmapDto {
  submap_id: string;
  name: string;
  building_id?: string;
  rows: number;
  cols: number;
  nodes: Record<string, WorldMapNode>;
}

export interface WorldMapDto extends WorldMapSummary {
  nodes: Record<string, WorldMapNode>;
  buildings: Record<string, string>;
  submaps: WorldSubmapDto[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 401 のとき Login 画面へ誘導するためのグローバルフック。 */
export let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(handler: () => void): void {
  onUnauthorized = handler;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (response.status === 401 && !path.startsWith('/api/auth/')) {
    onUnauthorized?.();
  }
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Hono 既定の 500 などプレーンテキスト応答。本文をそのままエラーメッセージにする。
      if (!response.ok) throw new ApiError(response.status, 'error', text.slice(0, 200));
      throw new ApiError(response.status, 'invalid_response', `不正なレスポンス: ${text.slice(0, 100)}`);
    }
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      typeof parsed.error === 'string' ? parsed.error : 'error',
      typeof parsed.message === 'string' ? parsed.message : `HTTP ${response.status}`,
    );
  }
  return parsed as T;
}

export function formatTime(ms: number | null | undefined): string {
  if (!ms) return '-';
  return new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
