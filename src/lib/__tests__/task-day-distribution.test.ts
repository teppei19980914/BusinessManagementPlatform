import { describe, expect, it } from 'vitest';
import {
  getAllCalendarDays,
  getBusinessDays,
  countWorkingDays,
  distributeEffortByDay,
  getProjectDateRange,
  clampMaxDateToToday,
} from '../task-day-distribution';

describe('getAllCalendarDays', () => {
  it('月〜金の5日間を返す', () => {
    // 2026-06-15(月) 〜 2026-06-19(金)
    const days = getAllCalendarDays('2026-06-15', '2026-06-19');
    expect(days).toEqual([
      '2026-06-15',
      '2026-06-16',
      '2026-06-17',
      '2026-06-18',
      '2026-06-19',
    ]);
  });

  it('土日をまたぐ場合も土日を含む全暦日を返す', () => {
    // 2026-06-13(土) 〜 2026-06-17(水)
    const days = getAllCalendarDays('2026-06-13', '2026-06-17');
    expect(days).toEqual([
      '2026-06-13',
      '2026-06-14',
      '2026-06-15',
      '2026-06-16',
      '2026-06-17',
    ]);
  });

  it('start=end（単日）の場合は1日分を返す（平日）', () => {
    const days = getAllCalendarDays('2026-06-16', '2026-06-16');
    expect(days).toEqual(['2026-06-16']);
  });

  it('start=end が土曜日の場合も1日分を返す', () => {
    // 2026-06-13 = 土曜
    const days = getAllCalendarDays('2026-06-13', '2026-06-13');
    expect(days).toEqual(['2026-06-13']);
  });

  it('週末のみの範囲（土〜日）も2日分返す', () => {
    // 2026-06-13(土) 〜 2026-06-14(日)
    const days = getAllCalendarDays('2026-06-13', '2026-06-14');
    expect(days).toEqual(['2026-06-13', '2026-06-14']);
  });

  it('startDate が null の場合は空配列を返す', () => {
    expect(getAllCalendarDays(null, '2026-06-19')).toEqual([]);
  });

  it('endDate が null の場合は空配列を返す', () => {
    expect(getAllCalendarDays('2026-06-15', null)).toEqual([]);
  });

  it('両方 null の場合は空配列を返す', () => {
    expect(getAllCalendarDays(null, null)).toEqual([]);
  });

  it('startDate > endDate の場合は空配列を返す', () => {
    expect(getAllCalendarDays('2026-06-19', '2026-06-15')).toEqual([]);
  });
});

describe('getBusinessDays', () => {
  it('月〜金の5日間は全日を返す（平日のみ）', () => {
    const days = getBusinessDays('2026-06-15', '2026-06-19');
    expect(days).toEqual(['2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19']);
  });

  it('金〜月（4暦日）は金・月の2日のみ返す', () => {
    // 2026-06-19(金) 〜 2026-06-22(月)
    const days = getBusinessDays('2026-06-19', '2026-06-22');
    expect(days).toEqual(['2026-06-19', '2026-06-22']);
  });

  it('土日のみの範囲は空配列を返す', () => {
    // 2026-06-20(土) 〜 2026-06-21(日)
    const days = getBusinessDays('2026-06-20', '2026-06-21');
    expect(days).toEqual([]);
  });

  it('日付未設定は空配列を返す', () => {
    expect(getBusinessDays(null, '2026-06-19')).toEqual([]);
    expect(getBusinessDays('2026-06-15', null)).toEqual([]);
  });
});

describe('countWorkingDays', () => {
  it('includeWeekends=true は全暦日数を返す', () => {
    // 2026-06-19(金) 〜 2026-06-22(月): 4暦日
    expect(countWorkingDays('2026-06-19', '2026-06-22', true)).toBe(4);
  });

  it('includeWeekends=false は業務日数のみを返す', () => {
    // 2026-06-19(金) 〜 2026-06-22(月): 業務日は金・月の2日
    expect(countWorkingDays('2026-06-19', '2026-06-22', false)).toBe(2);
  });

  it('日付未設定は0を返す', () => {
    expect(countWorkingDays(null, '2026-06-19', false)).toBe(0);
  });
});

describe('distributeEffortByDay', () => {
  describe('includeWeekends=true（全暦日モード）', () => {
    it('10h を 5暦日（月〜金）で均等分散すると 2h/日', () => {
      const entries = distributeEffortByDay('2026-06-15', '2026-06-19', 10, true);
      expect(entries).toHaveLength(5);
      for (const e of entries) expect(e.dailyEffort).toBe(2);
    });

    it('4h を 金土日月（4暦日）で均等分散すると 1h/日', () => {
      const entries = distributeEffortByDay('2026-06-19', '2026-06-22', 4, true);
      expect(entries).toHaveLength(4);
      expect(entries[1].date).toBe('2026-06-20'); // 土
      expect(entries[2].date).toBe('2026-06-21'); // 日
      for (const e of entries) expect(e.dailyEffort).toBe(1);
    });

    it('土曜単日タスクも1日分を返す', () => {
      const entries = distributeEffortByDay('2026-06-13', '2026-06-13', 4, true);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({ date: '2026-06-13', dailyEffort: 4 });
    });
  });

  describe('includeWeekends=false（業務日モード、デフォルト）', () => {
    it('10h を 月〜金（5業務日）で均等分散すると 2h/日', () => {
      const entries = distributeEffortByDay('2026-06-15', '2026-06-19', 10, false);
      expect(entries).toHaveLength(5);
      for (const e of entries) expect(e.dailyEffort).toBe(2);
    });

    it('4h を 金〜月（業務日は金・月の2日）で分散すると 2h/日', () => {
      const entries = distributeEffortByDay('2026-06-19', '2026-06-22', 4, false);
      expect(entries).toHaveLength(2);
      expect(entries[0].date).toBe('2026-06-19'); // 金
      expect(entries[1].date).toBe('2026-06-22'); // 月
      for (const e of entries) expect(e.dailyEffort).toBe(2);
    });

    it('土日のみの範囲は空配列（業務日なし）', () => {
      const entries = distributeEffortByDay('2026-06-20', '2026-06-21', 4, false);
      expect(entries).toEqual([]);
    });

    it('デフォルト引数は false（業務日モード）として動作する', () => {
      // 金〜月: 業務日は金・月の2日
      const entries = distributeEffortByDay('2026-06-19', '2026-06-22', 4);
      expect(entries).toHaveLength(2);
    });
  });

  it('単日タスク（平日）は全工数をその日に配置する', () => {
    const entries = distributeEffortByDay('2026-06-16', '2026-06-16', 8);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ date: '2026-06-16', dailyEffort: 8 });
  });

  it('日付未設定の場合は空配列を返す（未スケジュール扱い）', () => {
    expect(distributeEffortByDay(null, '2026-06-19', 8)).toEqual([]);
    expect(distributeEffortByDay('2026-06-15', null, 8)).toEqual([]);
    expect(distributeEffortByDay(null, null, 8)).toEqual([]);
  });

  it('工数が0の場合でも日付があれば entries を返す（最低高さ付箋用）', () => {
    const entries = distributeEffortByDay('2026-06-16', '2026-06-16', 0);
    expect(entries).toHaveLength(1);
    expect(entries[0].dailyEffort).toBe(0);
  });

  it('割り切れない工数は小数第2位で丸める', () => {
    // 10h / 3業務日 = 3.333... → 3.33
    const entries = distributeEffortByDay('2026-06-16', '2026-06-18', 10, false);
    expect(entries).toHaveLength(3);
    expect(entries[0].dailyEffort).toBe(3.33);
  });
});

describe('getProjectDateRange', () => {
  it('タスク一覧から最小・最大日付を返す', () => {
    const tasks = [
      { plannedStartDate: '2026-06-01', plannedEndDate: '2026-06-10' },
      { plannedStartDate: '2026-06-05', plannedEndDate: '2026-06-30' },
    ];
    const range = getProjectDateRange(tasks);
    expect(range.minDate).toBe('2026-06-01');
    expect(range.maxDate).toBe('2026-06-30');
  });

  it('日付未設定タスクはスキップする', () => {
    const tasks = [
      { plannedStartDate: null, plannedEndDate: null },
      { plannedStartDate: '2026-06-10', plannedEndDate: '2026-06-20' },
    ];
    const range = getProjectDateRange(tasks);
    expect(range.minDate).toBe('2026-06-10');
    expect(range.maxDate).toBe('2026-06-20');
  });

  it('全タスクが日付未設定の場合は今日から30日を返す', () => {
    const range = getProjectDateRange([{ plannedStartDate: null, plannedEndDate: null }]);
    expect(range.minDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(range.maxDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(range.maxDate > range.minDate).toBe(true);
  });

  it('タスク配列が空の場合は今日から30日を返す', () => {
    const range = getProjectDateRange([]);
    expect(range.minDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(range.maxDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('clampMaxDateToToday', () => {
  const base = { minDate: '2026-06-01', maxDate: '2026-06-05' };

  it('today が maxDate より後なら maxDate を today に延ばす', () => {
    const result = clampMaxDateToToday(base, '2026-06-20');
    expect(result).toEqual({ minDate: '2026-06-01', maxDate: '2026-06-20' });
  });

  it('today が maxDate と同じなら変更なし', () => {
    const result = clampMaxDateToToday(base, '2026-06-05');
    expect(result).toEqual(base);
  });

  it('today が maxDate より前なら変更なし', () => {
    const result = clampMaxDateToToday(base, '2026-06-03');
    expect(result).toEqual(base);
  });

  it('today が空文字なら変更なし', () => {
    const result = clampMaxDateToToday(base, '');
    expect(result).toEqual(base);
  });

  it('minDate は常に変更されない', () => {
    const result = clampMaxDateToToday(base, '2026-06-30');
    expect(result.minDate).toBe('2026-06-01');
  });
});
