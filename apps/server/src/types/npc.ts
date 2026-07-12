import { z } from 'zod';

/** 移動設定。range は「次の移動先を選ぶ範囲」（アンカー±range の矩形）。 */
export const movementConfigSchema = z.object({
  mode: z.enum(['random', 'stationary']).default('stationary'),
  anchor_node_id: z.string().regex(/^\d+-\d+$/).optional(),
  range: z
    .object({
      rows: z.number().int().min(0).max(200),
      cols: z.number().int().min(0).max(200),
    })
    .default({ rows: 5, cols: 5 }),
  move_probability: z.number().min(0).max(1).default(0.5),
  rest_duration: z.number().int().min(1).max(36).default(1),
});
export type MovementConfig = z.infer<typeof movementConfigSchema>;

export const conversationPolicySchema = z.object({
  accept: z.enum(['always', 'llm', 'never']).default('always'),
  inactive_check: z.enum(['stay', 'leave', 'llm']).default('stay'),
  max_history_pairs: z.number().int().min(1).max(50).default(15),
});
export type ConversationPolicy = z.infer<typeof conversationPolicySchema>;

export const transferPolicySchema = z.object({
  receive: z.enum(['always_accept', 'always_reject', 'llm']).default('always_accept'),
  give_enabled: z.boolean().default(true),
});
export type TransferPolicy = z.infer<typeof transferPolicySchema>;

/**
 * ログイン時間帯。start > end は日をまたぐ（例 22:00〜02:00）。
 * days は開始時刻が属する曜日（0=日〜6=土）。省略 or 空配列 = 毎日。
 */
export const scheduleWindowSchema = z
  .object({
    days: z.array(z.number().int().min(0).max(6)).optional(),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  })
  .refine((window) => window.start !== window.end, { message: 'start と end は同じ時刻にできません' });
export type ScheduleWindow = z.infer<typeof scheduleWindowSchema>;

export const scheduleConfigSchema = z.object({
  /** 空 = スケジュールなし（従来通り常時ログイン）。 */
  windows: z.array(scheduleWindowSchema).max(20).default([]),
  /** 時間帯終了後、会話などが続いていても強制ログオフするまでの猶予（分）。 */
  logout_grace_minutes: z.number().int().min(0).max(720).default(30),
});
export type ScheduleConfig = z.infer<typeof scheduleConfigSchema>;

export const llmConfigSchema = z.object({
  provider: z.enum(['openai_compatible', 'anthropic']).optional(),
  base_url: z.string().url().optional(),
  api_key: z.string().optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  system_prompt_extra: z.string().optional(),
});
export type LlmConfig = z.infer<typeof llmConfigSchema>;

/** npcs テーブルの 1 行（JSON カラムはパース済み）。 */
export interface Npc {
  npc_id: string;
  name: string;
  enabled: boolean;
  agent_id: string;
  api_key: string;
  webhook_secret: string;
  persona: string;
  /** ペルソナと別枠で「必ず守るルール」として system prompt に最優先で入る。 */
  rules: string;
  home_node_id: string | null;
  movement: MovementConfig;
  conversation: ConversationPolicy;
  transfer: TransferPolicy;
  llm: LlmConfig;
  schedule: ScheduleConfig;
  created_at: number;
  updated_at: number;
}

export interface NpcRuntimeState {
  npc_id: string;
  logged_in: boolean;
  world_id: string | null;
  node_id: string | null;
  agent_state: string | null;
  money: number | null;
  items: Array<{ item_id: string; name?: string; [key: string]: unknown }> | null;
  last_notification_at: number | null;
  last_command_at: number | null;
  last_error: string | null;
  status_synced_at: number | null;
  /** スケジュール時間外になった時刻。次のターン境界での安全ログオフの合図（猶予超過で強制ログオフ）。 */
  logout_pending_since: number | null;
}

export type DeliveryStatus = 'received' | 'processing' | 'done' | 'failed' | 'skipped';

export interface DeliveryRecord {
  delivery_id: string;
  npc_id: string;
  notification_id: string;
  kind: string;
  received_at: number;
  status: DeliveryStatus;
  error: string | null;
  notification_json: string | null;
}
