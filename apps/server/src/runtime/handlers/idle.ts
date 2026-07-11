import type { NpcStore } from '../../storage/npc-store.js';
import { planIdleAction } from '../movement-planner.js';
import type { NotificationHandlers } from '../npc-runtime.js';

/** 状態ミラーがこの時間以上同期されていなければ、idle 契機を get_status に使う。 */
const STATUS_SYNC_INTERVAL_MS = 30 * 60 * 1000;

/**
 * idle 契機（自由に行動を選べる通知）のハンドラ群。
 * 移動プランナに従い move / wait を選ぶ。状態ミラーが古ければ先に get_status で同期する
 * （info コマンド実行後は world から info_choices 通知が届き、それが次の idle 契機になる）。
 */
export function createIdleHandlers(store: NpcStore, random: () => number = Math.random): NotificationHandlers {
  const handleIdleTrigger: NotificationHandlers['idle_reminder'] = ({ npc, notification }) => {
    const runtime = store.getRuntime(npc.npc_id);
    const commands = new Set(notification.choices.map((choice) => choice.command));

    const staleSince = runtime?.status_synced_at ?? 0;
    if (commands.has('get_status') && Date.now() - staleSince > STATUS_SYNC_INTERVAL_MS) {
      return { command: 'get_status', params: {} };
    }

    return planIdleAction(npc, notification, runtime, random);
  };

  return {
    agent_logged_in: handleIdleTrigger,
    movement_completed: handleIdleTrigger,
    wait_completed: handleIdleTrigger,
    idle_reminder: handleIdleTrigger,
    info_choices: handleIdleTrigger,
    // サーバーアナウンスは通知文自体が「無視してよい」と明記している。
    // 会話・行動を中断しないため v1 では記録のみ（perception 反映は共通処理で行われる）。
    server_announcement: () => null,
  };
}
