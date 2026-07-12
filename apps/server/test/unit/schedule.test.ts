import { describe, expect, it } from 'vitest';

import { isScheduleActive } from '../../src/runtime/schedule.js';
import { scheduleConfigSchema } from '../../src/types/npc.js';

/** 2026-07-13 は月曜日（day=1）。 */
function at(dateTime: string): Date {
  return new Date(dateTime);
}

function schedule(windows: unknown[]) {
  return scheduleConfigSchema.parse({ windows });
}

describe('isScheduleActive', () => {
  it('windows が空なら常時アクティブ（従来動作）', () => {
    expect(isScheduleActive(schedule([]), at('2026-07-13T03:00:00'))).toBe(true);
  });

  it('時間帯内なら true、外なら false（end は排他）', () => {
    const config = schedule([{ start: '09:00', end: '18:00' }]);
    expect(isScheduleActive(config, at('2026-07-13T08:59:00'))).toBe(false);
    expect(isScheduleActive(config, at('2026-07-13T09:00:00'))).toBe(true);
    expect(isScheduleActive(config, at('2026-07-13T17:59:00'))).toBe(true);
    expect(isScheduleActive(config, at('2026-07-13T18:00:00'))).toBe(false);
  });

  it('複数の時間帯はいずれかに入っていればアクティブ', () => {
    const config = schedule([
      { start: '09:00', end: '12:00' },
      { start: '18:00', end: '22:00' },
    ]);
    expect(isScheduleActive(config, at('2026-07-13T10:00:00'))).toBe(true);
    expect(isScheduleActive(config, at('2026-07-13T15:00:00'))).toBe(false);
    expect(isScheduleActive(config, at('2026-07-13T20:00:00'))).toBe(true);
  });

  it('日またぎ（start > end）は当日の start 以降と翌日の end 前でアクティブ', () => {
    const config = schedule([{ start: '22:00', end: '02:00' }]);
    expect(isScheduleActive(config, at('2026-07-13T23:00:00'))).toBe(true);
    expect(isScheduleActive(config, at('2026-07-14T01:00:00'))).toBe(true);
    expect(isScheduleActive(config, at('2026-07-14T02:00:00'))).toBe(false);
    expect(isScheduleActive(config, at('2026-07-13T12:00:00'))).toBe(false);
  });

  it('days 指定は開始時刻が属する曜日で判定する', () => {
    // 月曜のみ 22:00〜02:00
    const config = schedule([{ days: [1], start: '22:00', end: '02:00' }]);
    expect(isScheduleActive(config, at('2026-07-13T23:00:00'))).toBe(true); // 月曜夜
    expect(isScheduleActive(config, at('2026-07-14T01:00:00'))).toBe(true); // 火曜未明（月曜開始分）
    expect(isScheduleActive(config, at('2026-07-14T23:00:00'))).toBe(false); // 火曜夜
    expect(isScheduleActive(config, at('2026-07-13T01:00:00'))).toBe(false); // 月曜未明（日曜開始分は対象外）
  });

  it('days が空配列なら毎日扱い', () => {
    const config = schedule([{ days: [], start: '09:00', end: '10:00' }]);
    expect(isScheduleActive(config, at('2026-07-13T09:30:00'))).toBe(true);
    expect(isScheduleActive(config, at('2026-07-15T09:30:00'))).toBe(true);
  });
});
