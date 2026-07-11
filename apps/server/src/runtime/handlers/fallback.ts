import type { AgentNotification } from '../../types/world.js';

export interface CommandChoice {
  command: string;
  params: Record<string, unknown>;
}

/**
 * kind 専用ハンドラが無い（または判断材料が無い）通知への安全なフォールバック。
 * choices に wait があればその場で待機し、無ければ何もしない（コマンド消費しない）。
 * 通知に応答しないこと自体は world 仕様上許容される（idle_reminder が保険になる）。
 */
export function chooseFallbackCommand(notification: AgentNotification, restDuration = 1): CommandChoice | null {
  const wait = notification.choices.find((choice) => choice.command === 'wait');
  if (!wait) return null;
  return { command: 'wait', params: { duration: restDuration } };
}
