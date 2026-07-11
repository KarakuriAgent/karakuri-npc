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
  world_base_url: string;
  agent_id: string;
  api_key_masked: string;
  webhook_secret_masked: string;
  persona: string;
  home_node_id: string | null;
  movement: MovementConfig;
  conversation: { accept: string; inactive_check: string; max_history_pairs: number };
  transfer: { receive: string; give_enabled: boolean };
  llm: { provider?: string; model?: string; temperature?: number; system_prompt_extra?: string };
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
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
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
