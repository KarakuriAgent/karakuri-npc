import type { ScheduleConfig } from '../types/npc.js';

function toMinutes(hhmm: string): number {
  const [hours, minutes] = hhmm.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/**
 * 現在時刻がログイン時間帯に含まれるか。windows が空なら常時ログイン（従来動作）。
 * 判定はサーバーのローカル時刻。end は排他（22:00〜23:00 なら 23:00 ちょうどは時間外）。
 * start > end の窓は日またぎで、start の属する曜日で days を判定し翌日の end まで有効。
 */
export function isScheduleActive(schedule: ScheduleConfig, now: Date): boolean {
  if (schedule.windows.length === 0) return true;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const day = now.getDay();
  const previousDay = (day + 6) % 7;
  return schedule.windows.some((window) => {
    const start = toMinutes(window.start);
    const end = toMinutes(window.end);
    const matchesDay = (d: number) => !window.days || window.days.length === 0 || window.days.includes(d);
    if (start < end) return matchesDay(day) && minutes >= start && minutes < end;
    // 日またぎ: 開始日の start〜24:00 と翌日の 0:00〜end
    return (matchesDay(day) && minutes >= start) || (matchesDay(previousDay) && minutes < end);
  });
}
