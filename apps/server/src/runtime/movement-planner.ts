import type { MovementConfig, Npc, NpcRuntimeState } from '../types/npc.js';
import type { AgentNotification } from '../types/world.js';
import type { CommandChoice } from './handlers/fallback.js';

const MAX_MOVE_CANDIDATES = 5;

function parseNodeId(nodeId: string): { row: number; col: number } | null {
  const match = /^(\d+)-(\d+)$/.exec(nodeId);
  if (!match) return null;
  return { row: Number(match[1]), col: Number(match[2]) };
}

/**
 * 移動先アンカーの解決順: 設定のアンカー → home → 現在地（perception → 状態ミラー）。
 * どれも無ければ移動しない（範囲の基準が無いため）。
 */
function resolveAnchor(
  npc: Npc,
  notification: AgentNotification,
  runtime: NpcRuntimeState | null,
): { row: number; col: number } | null {
  const candidates = [
    npc.movement.anchor_node_id,
    npc.home_node_id ?? undefined,
    notification.perception?.current_node?.node_id,
    runtime?.node_id ?? undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = parseNodeId(candidate);
    if (parsed) return parsed;
  }
  return null;
}

/** アンカー±range の矩形から通行を試す移動先候補を重複なしで最大 count 個選ぶ。 */
export function pickMoveTargets(
  anchor: { row: number; col: number },
  range: MovementConfig['range'],
  count: number,
  random: () => number,
  excludeNodeId?: string,
): string[] {
  const targets = new Set<string>();
  // 範囲内の全ノード数が小さい場合に無限ループしないよう試行回数を制限する。
  const maxAttempts = count * 10;
  for (let attempt = 0; attempt < maxAttempts && targets.size < count; attempt++) {
    const row = anchor.row + Math.floor(random() * (range.rows * 2 + 1)) - range.rows;
    const col = anchor.col + Math.floor(random() * (range.cols * 2 + 1)) - range.cols;
    if (row < 0 || col < 0) continue;
    const nodeId = `${row}-${col}`;
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
