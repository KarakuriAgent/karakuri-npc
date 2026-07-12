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
