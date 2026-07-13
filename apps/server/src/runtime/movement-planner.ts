import type { MovementConfig, Npc, NpcRuntimeState } from '../types/npc.js';
import type { AgentNotification } from '../types/world.js';
import type { CommandChoice } from './handlers/fallback.js';

const MAX_MOVE_CANDIDATES = 5;

/**
 * world の nodeRef 形式をパースする。無修飾 "行-列" は mapId なし（NPC の現在マップ基準で
 * 解釈される）、"submap_id:行-列" は建物内サブマップ。
 */
function parseNodeRef(nodeRef: string): { mapId: string | null; row: number; col: number } | null {
  const match = /^(?:([a-z0-9][a-z0-9-]*):)?(\d+)-(\d+)$/.exec(nodeRef);
  if (!match) return null;
  return { mapId: match[1] ?? null, row: Number(match[2]), col: Number(match[3]) };
}

export interface MoveAnchor {
  /** null = 無修飾（屋外 or 現在マップ）。サブマップ内なら submap_id。 */
  mapId: string | null;
  row: number;
  col: number;
}

/**
 * 移動先アンカーの解決順: 設定のアンカー → home → 現在地（perception → 状態ミラー）。
 * どれも無ければ移動しない（範囲の基準が無いため）。
 */
function resolveAnchor(
  npc: Npc,
  notification: AgentNotification,
  runtime: NpcRuntimeState | null,
): MoveAnchor | null {
  const candidates = [
    npc.movement.anchor_node_id,
    npc.home_node_id ?? undefined,
    notification.perception?.current_node?.node_id,
    runtime?.node_id ?? undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = parseNodeRef(candidate);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * アンカー±range の矩形から通行を試す移動先候補を重複なしで最大 count 個選ぶ。
 * アンカーがサブマップ修飾つきなら候補も同じサブマップ修飾で返す。
 */
export function pickMoveTargets(
  anchor: MoveAnchor,
  range: MovementConfig['range'],
  count: number,
  random: () => number,
  excludeNodeId?: string,
): string[] {
  const targets = new Set<string>();
  const prefix = anchor.mapId ? `${anchor.mapId}:` : '';
  // 範囲内の全ノード数が小さい場合に無限ループしないよう試行回数を制限する。
  const maxAttempts = count * 10;
  for (let attempt = 0; attempt < maxAttempts && targets.size < count; attempt++) {
    const row = anchor.row + Math.floor(random() * (range.rows * 2 + 1)) - range.rows;
    const col = anchor.col + Math.floor(random() * (range.cols * 2 + 1)) - range.cols;
    // world の座標は 1 始まり（0 行 / 0 列は out_of_bounds）
    if (row < 1 || col < 1) continue;
    const nodeId = `${prefix}${row}-${col}`;
    if (nodeId === excludeNodeId) continue;
    targets.add(nodeId);
  }
  return [...targets];
}

/**
 * idle 契機（移動可能な通知）での行動決定。
 * 戻り値は優先順の候補列。move はマップ都合で拒否されうるため複数候補 + wait を積む。
 */
export function planIdleAction(
  npc: Npc,
  notification: AgentNotification,
  runtime: NpcRuntimeState | null,
  random: () => number = Math.random,
): CommandChoice[] {
  const commands = new Set(notification.choices.map((choice) => choice.command));
  const wait: CommandChoice | null = commands.has('wait')
    ? { command: 'wait', params: { duration: npc.movement.rest_duration } }
    : null;
  const waitTail = wait ? [wait] : [];

  if (npc.movement.mode !== 'random' || !commands.has('move')) {
    return waitTail;
  }
  if (random() >= npc.movement.move_probability) {
    return waitTail;
  }

  const anchor = resolveAnchor(npc, notification, runtime);
  if (!anchor) return waitTail;

  const currentNodeId = notification.perception?.current_node?.node_id ?? runtime?.node_id ?? undefined;
  const targets = pickMoveTargets(anchor, npc.movement.range, MAX_MOVE_CANDIDATES, random, currentNodeId);
  const moves: CommandChoice[] = targets.map((nodeId) => ({
    command: 'move',
    params: { target_node_id: nodeId },
  }));
  return [...moves, ...waitTail];
}
