import type { NpcStore } from '../storage/npc-store.js';
import type { NpcRuntimeState } from '../types/npc.js';
import type { AgentNotification } from '../types/world.js';

/**
 * world をポーリングできない（info コマンドも通知を消費する）ため、
 * 通知の perception とコマンド結果から npc_runtime テーブルを一元更新する。
 */

/** 通知の perception から現在地・所持金・ワールドを反映する。 */
export function applyNotificationToMirror(store: NpcStore, npcId: string, notification: AgentNotification): void {
  const perception = notification.perception;
  if (!perception) return;
  const patch: Partial<Omit<NpcRuntimeState, 'npc_id'>> = {};
  const nodeId = perception.current_node?.node_id;
  if (typeof nodeId === 'string') patch.node_id = nodeId;
  if (typeof perception.current_world_id === 'string') patch.world_id = perception.current_world_id;
  if (typeof perception.money === 'number') patch.money = perception.money;
  if (Object.keys(patch).length > 0) store.patchRuntime(npcId, patch);
}

interface InfoCommandResultLike {
  command?: unknown;
  data?: unknown;
}

/**
 * info 系コマンドの inline data を状態ミラーへ反映する。
 * get_status: { current_world_id, node_id, location_label, money, items }
 */
export function applyCommandResultToMirror(store: NpcStore, npcId: string, command: string, result: unknown): void {
  if (command !== 'get_status') return;
  const data = (result as InfoCommandResultLike | null)?.data as
    | { current_world_id?: unknown; node_id?: unknown; money?: unknown; items?: unknown }
    | undefined;
  if (!data || typeof data !== 'object') return;
  const patch: Partial<Omit<NpcRuntimeState, 'npc_id'>> = { status_synced_at: Date.now() };
  if (typeof data.node_id === 'string') patch.node_id = data.node_id;
  if (typeof data.current_world_id === 'string') patch.world_id = data.current_world_id;
  if (typeof data.money === 'number') patch.money = data.money;
  if (Array.isArray(data.items)) patch.items = data.items as NpcRuntimeState['items'];
  store.patchRuntime(npcId, patch);
}
