import { z } from 'zod';

/**
 * karakuri-world の NPC 向けインターフェースの型。
 * 正本は karakuri-world apps/server/src/types/discord-notification.ts /
 * npc/npc-webhook-delivery.ts。schema_version 1 に対応する。
 */

export const agentNotificationKinds = [
  'agent_logged_in',
  'agent_logged_out',
  'movement_completed',
  'world_moved',
  'action_completed',
  'action_interrupted',
  'action_rejected',
  'wait_completed',
  'item_use_completed',
  'item_use_venue_rejected',
  'conversation_request',
  'conversation_accepted',
  'conversation_rejected',
  'conversation_reply',
  'conversation_turn',
  'conversation_closing',
  'conversation_fyi',
  'conversation_inactive_check',
  'conversation_ended',
  'conversation_forced_ended',
  'conversation_pending_join_cancelled',
  'server_announcement',
  'info_choices',
  'transfer_request',
  'transfer_sent',
  'transfer_accepted',
  'transfer_rejected',
  'transfer_timeout',
  'transfer_cancelled',
  'transfer_escrow_lost',
  'idle_reminder',
] as const;

export type AgentNotificationKind = (typeof agentNotificationKinds)[number];

export interface AgentNotificationChoice {
  command: string;
  label: string;
  params?: Record<string, unknown>;
  required_params?: string[];
  param_schema?: Record<string, unknown>;
  param_constraints?: { exactly_one_of?: string[] };
}

export interface AgentNotificationPerception {
  current_world_id?: string;
  current_world_name?: string;
  world_time?: string;
  weather?: { condition: string; temperature_celsius?: number };
  current_node?: { node_id: string; label?: string; location_label?: string; [key: string]: unknown };
  nearby_nodes?: Array<{ label: string; node_ids: string[]; min_distance?: number }>;
  nearby_agents?: Array<{ agent_id: string; agent_name: string; node_id: string }>;
  nearby_npcs?: Array<{ npc_id?: string; name: string; node_id: string }>;
  nearby_buildings?: Array<{ building_id?: string; name: string; door_nodes: string[] }>;
  money?: number;
  item_count?: number;
  [key: string]: unknown;
}

export interface AgentNotification {
  schema_version: number;
  /** 既知の kind は AgentNotificationKind。world 側の追加に備えて string で保持する。 */
  kind: string;
  summary: string;
  choices: AgentNotificationChoice[];
  payload?: Record<string, unknown>;
  perception?: AgentNotificationPerception;
}

/** webhook で届くトリガー本体。通知詳細は別途フェッチする。 */
export const webhookPayloadSchema = z.object({
  notification_id: z.string().min(1),
  agent_id: z.string().min(1),
  kind: z.enum(agentNotificationKinds).or(z.string().min(1)),
  triggered_at: z.number(),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

/** POST /api/npc/login のレスポンス。 */
export interface WorldLoginResult {
  notification_transport?: string;
  node_id?: string;
  [key: string]: unknown;
}

/** world API のエラーレスポンス共通形式。 */
export interface WorldErrorBody {
  error: string;
  message: string;
  details?: unknown;
  hint?: string;
  suggestions?: Array<{ command: string; reason: string; params?: Record<string, unknown> }>;
}
