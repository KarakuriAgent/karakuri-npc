import { describe, expect, it } from 'vitest';

import { pickMoveTargets, planIdleAction } from '../../src/runtime/movement-planner.js';
import { createTestStore, testNotification, testNpcInput } from '../helpers/test-env.js';

function makeNpc(movement: Record<string, unknown>, homeNodeId?: string) {
  const store = createTestStore();
  return store.createNpc(
    testNpcInput({ movement: { mode: 'random', ...movement }, home_node_id: homeNodeId ?? null }),
  );
}

/** 決定的な擬似乱数列を返す。 */
function sequenceRandom(values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length]!;
}

describe('pickMoveTargets', () => {
  it('アンカー±range の矩形内から重複なしで候補を選ぶ', () => {
    const targets = pickMoveTargets({ mapId: null, row: 10, col: 20 }, { rows: 2, cols: 3 }, 5, Math.random);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      const [row, col] = target.split('-').map(Number);
      expect(row).toBeGreaterThanOrEqual(8);
      expect(row).toBeLessThanOrEqual(12);
      expect(col).toBeGreaterThanOrEqual(17);
      expect(col).toBeLessThanOrEqual(23);
    }
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('範囲外座標（0 以下）と現在地を除外する', () => {
    // world の座標は 1 始まり。アンカーが原点付近でも 0 行 / 0 列は生成されない
    const targets = pickMoveTargets({ mapId: null, row: 1, col: 1 }, { rows: 2, cols: 2 }, 20, Math.random, '1-1');
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      const [row, col] = target.split('-').map(Number);
      expect(row).toBeGreaterThanOrEqual(1);
      expect(col).toBeGreaterThanOrEqual(1);
      expect(target).not.toBe('1-1');
    }
  });

  it('サブマップ修飾つきアンカーは候補も同じ修飾で返す', () => {
    const targets = pickMoveTargets({ mapId: 'ryokan-1f', row: 2, col: 3 }, { rows: 1, cols: 1 }, 10, Math.random, 'ryokan-1f:2-3');
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target).toMatch(/^ryokan-1f:\d+-\d+$/);
      expect(target).not.toBe('ryokan-1f:2-3');
      const [row, col] = target.slice('ryokan-1f:'.length).split('-').map(Number);
      expect(Math.abs(row! - 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(col! - 3)).toBeLessThanOrEqual(1);
    }
  });
});

describe('planIdleAction', () => {
  it('stationary モードは wait のみ返す', () => {
    const store = createTestStore();
    const npc = store.createNpc(testNpcInput({ movement: { mode: 'stationary', rest_duration: 3 } }));
    const plan = planIdleAction(npc, testNotification(), null);
    expect(plan).toEqual([{ command: 'wait', params: { duration: 3 } }]);
  });

  it('random モードで確率に当たると move 候補列 + wait を返す', () => {
    const npc = makeNpc({ move_probability: 0.9, anchor_node_id: '50-50', range: { rows: 3, cols: 3 } });
    const plan = planIdleAction(npc, testNotification(), null, sequenceRandom([0.1, 0.5, 0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.9, 0.05]));

    expect(plan.length).toBeGreaterThan(1);
    const moves = plan.filter((c) => c.command === 'move');
    expect(moves.length).toBeGreaterThan(0);
    for (const move of moves) {
      expect(move.params.target_node_id).toMatch(/^\d+-\d+$/);
    }
    expect(plan.at(-1)).toEqual({ command: 'wait', params: { duration: 1 } });
  });

  it('確率に外れると wait のみ返す', () => {
    const npc = makeNpc({ move_probability: 0.3 });
    const plan = planIdleAction(npc, testNotification(), null, sequenceRandom([0.9]));
    expect(plan).toEqual([{ command: 'wait', params: { duration: 1 } }]);
  });

  it('choices に move が無ければ移動しない（会話中の通知など）', () => {
    const npc = makeNpc({ move_probability: 1, anchor_node_id: '5-5' });
    const notification = testNotification({
      choices: [{ command: 'wait', label: '待機する' }],
    });
    const plan = planIdleAction(npc, notification, null, () => 0);
    expect(plan).toEqual([{ command: 'wait', params: { duration: 1 } }]);
  });

  it('アンカー未設定なら perception の現在地を基準にする', () => {
    const npc = makeNpc({ move_probability: 1, range: { rows: 1, cols: 1 } });
    const notification = testNotification({
      perception: { current_node: { node_id: '30-40' }, nearby_nodes: [] },
    });
    const plan = planIdleAction(npc, notification, null, sequenceRandom([0, 0.1, 0.9, 0.5, 0.5, 0.2, 0.8, 0.3, 0.6, 0.4, 0.7]));
    const moves = plan.filter((c) => c.command === 'move');
    expect(moves.length).toBeGreaterThan(0);
    for (const move of moves) {
      const [row, col] = (move.params.target_node_id as string).split('-').map(Number);
      expect(Math.abs(row! - 30)).toBeLessThanOrEqual(1);
      expect(Math.abs(col! - 40)).toBeLessThanOrEqual(1);
    }
  });

  it('アンカーがサブマップ修飾つきなら move 候補も同じサブマップ内', () => {
    const npc = makeNpc({ move_probability: 1, anchor_node_id: 'ryokan-1f:2-3', range: { rows: 1, cols: 1 } });
    const plan = planIdleAction(npc, testNotification(), null, sequenceRandom([0, 0.1, 0.9, 0.5, 0.5, 0.2, 0.8, 0.3, 0.6, 0.4, 0.7]));
    const moves = plan.filter((c) => c.command === 'move');
    expect(moves.length).toBeGreaterThan(0);
    for (const move of moves) {
      expect(move.params.target_node_id).toMatch(/^ryokan-1f:\d+-\d+$/);
    }
  });

  it('基準位置がどこにも無ければ wait のみ', () => {
    const npc = makeNpc({ move_probability: 1 });
    const plan = planIdleAction(npc, testNotification(), null, () => 0);
    expect(plan).toEqual([{ command: 'wait', params: { duration: 1 } }]);
  });
});
