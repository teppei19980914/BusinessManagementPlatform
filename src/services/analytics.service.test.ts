import { describe, it, expect, vi, beforeEach } from 'vitest';

// prisma をモック (analytics.service は task.findMany + tenant.findUnique を使用)
vi.mock('@/lib/db', () => ({
  prisma: {
    task: { findMany: vi.fn() },
    tenant: { findUnique: vi.fn() },
  },
}));

import {
  getWbsCompletionCurve,
  getAssigneeWeeklyEffort,
  getAssigneeEffortVariance,
  getAssigneeWorkload,
  getAssigneeDailyCapacity,
  type WbsCompletionPoint,
} from './analytics.service';
import { prisma } from '@/lib/db';

/** テナント TZ をモック (既定 JST)。 */
function mockTenantTimezone(timezone: string) {
  vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ timezone } as never);
}

/** YYYY-MM-DD を UTC midnight の Date にする (DB の @db.Date を模す)。 */
const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

/** points から特定日付の点を引く。 */
function pointAt(points: WbsCompletionPoint[], date: string): WbsCompletionPoint {
  const p = points.find((pt) => pt.date === date);
  if (!p) throw new Error(`point not found: ${date}`);
  return p;
}

type ActRow = {
  plannedStartDate: Date | null;
  plannedEndDate: Date | null;
  actualEndDate: Date | null;
  status: string;
};

function mockActs(rows: ActRow[]) {
  vi.mocked(prisma.task.findMany).mockResolvedValue(rows as never);
}

const NOW = d('2026-06-10'); // 2026-06-10 00:00 UTC = 09:00 JST → JST today = 2026-06-10

describe('getWbsCompletionCurve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTenantTimezone('Asia/Tokyo'); // 既定は日本 (JST)
  });

  it('ACT が 0 件なら空カーブを返す', async () => {
    mockActs([]);
    const r = await getWbsCompletionCurve('p1', 'tenant-A', NOW);
    expect(r.totalActCount).toBe(0);
    expect(r.completedActCount).toBe(0);
    expect(r.points).toEqual([]);
    expect(r.plannedPctToday).toBe(0);
    expect(r.actualPctToday).toBe(0);
    expect(r.gapPctToday).toBe(0);
    expect(r.today).toBe('2026-06-10');
  });

  it('テナント境界と ACT 限定の where でクエリする (越境/WP 混入防止)', async () => {
    mockActs([]);
    await getWbsCompletionCurve('p1', 'tenant-A', NOW);
    expect(prisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: 'p1',
          deletedAt: null,
          type: 'activity',
          project: { tenantId: 'tenant-A' },
        }),
      }),
    );
  });

  describe('予定線と実績線の累積 (4 ACT シナリオ)', () => {
    // A: 予定完了 06-05 / 完了 実績完了 06-06
    // B: 予定完了 06-08 / 完了 実績完了 06-10 (本日)
    // C: 予定完了 06-12 / 進行中 実績完了なし
    // D: 予定完了 06-15 / 未着手 実績完了なし
    beforeEach(() => {
      mockActs([
        { plannedStartDate: d('2026-06-01'), plannedEndDate: d('2026-06-05'), actualEndDate: d('2026-06-06'), status: 'completed' },
        { plannedStartDate: d('2026-06-03'), plannedEndDate: d('2026-06-08'), actualEndDate: d('2026-06-10'), status: 'completed' },
        { plannedStartDate: d('2026-06-05'), plannedEndDate: d('2026-06-12'), actualEndDate: null, status: 'in_progress' },
        { plannedStartDate: d('2026-06-06'), plannedEndDate: d('2026-06-15'), actualEndDate: null, status: 'not_started' },
      ]);
    });

    it('分母と完了件数', async () => {
      const r = await getWbsCompletionCurve('p1', 'tenant-A', NOW);
      expect(r.totalActCount).toBe(4);
      expect(r.completedActCount).toBe(2);
    });

    it('横軸は最小予定開始日〜最大予定完了日 (06-01〜06-15)', async () => {
      const r = await getWbsCompletionCurve('p1', 'tenant-A', NOW);
      expect(r.points[0].date).toBe('2026-06-01');
      expect(r.points[r.points.length - 1].date).toBe('2026-06-15');
      expect(r.points).toHaveLength(15);
    });

    it('予定線は予定完了日に累積し、最終日で 100%', async () => {
      const r = await getWbsCompletionCurve('p1', 'tenant-A', NOW);
      expect(pointAt(r.points, '2026-06-04')!.plannedPct).toBe(0);
      expect(pointAt(r.points, '2026-06-05')!.plannedPct).toBe(25); // A
      expect(pointAt(r.points, '2026-06-08')!.plannedPct).toBe(50); // A,B
      expect(pointAt(r.points, '2026-06-12')!.plannedPct).toBe(75); // A,B,C
      expect(pointAt(r.points, '2026-06-15')!.plannedPct).toBe(100); // A,B,C,D
    });

    it('実績線は完了 ACT の実績完了日に累積する', async () => {
      const r = await getWbsCompletionCurve('p1', 'tenant-A', NOW);
      expect(pointAt(r.points, '2026-06-05')!.actualPct).toBe(0);
      expect(pointAt(r.points, '2026-06-06')!.actualPct).toBe(25); // A
      expect(pointAt(r.points, '2026-06-10')!.actualPct).toBe(50); // A,B
    });

    it('実績線は本日より後を null にする (未来を描かない)', async () => {
      const r = await getWbsCompletionCurve('p1', 'tenant-A', NOW);
      expect(pointAt(r.points, '2026-06-11')!.actualPct).toBeNull();
      expect(pointAt(r.points, '2026-06-11')!.actualCount).toBeNull();
      expect(pointAt(r.points, '2026-06-12')!.actualPct).toBeNull();
      // 予定線は未来も描く
      expect(pointAt(r.points, '2026-06-12')!.plannedPct).toBe(75);
    });

    it('本日サマリ (予定50% / 実績50% / 遅れ0%)', async () => {
      const r = await getWbsCompletionCurve('p1', 'tenant-A', NOW);
      expect(r.plannedPctToday).toBe(50);
      expect(r.actualPctToday).toBe(50);
      expect(r.gapPctToday).toBe(0);
    });
  });

  it('進行中/未着手や実績完了日 null の完了は実績線に計上しない', async () => {
    // 完了だが actualEndDate が null → 実績に乗らない
    mockActs([
      { plannedStartDate: d('2026-06-01'), plannedEndDate: d('2026-06-05'), actualEndDate: null, status: 'completed' },
      { plannedStartDate: d('2026-06-02'), plannedEndDate: d('2026-06-06'), actualEndDate: d('2026-06-07'), status: 'in_progress' },
    ]);
    const r = await getWbsCompletionCurve('p1', 'tenant-A', NOW);
    // 実績完了日を持つ「完了」ACT は無いので本日実績は 0%
    expect(r.actualPctToday).toBe(0);
    expect(r.completedActCount).toBe(1);
    // 予定は 2 件とも予定完了日<=本日なので 100%
    expect(r.plannedPctToday).toBe(100);
    expect(r.gapPctToday).toBe(-100);
  });

  it('同一実績完了日に複数 ACT が完了するとその日に積み上がる', async () => {
    mockActs([
      { plannedStartDate: d('2026-06-01'), plannedEndDate: d('2026-06-05'), actualEndDate: d('2026-06-08'), status: 'completed' },
      { plannedStartDate: d('2026-06-02'), plannedEndDate: d('2026-06-06'), actualEndDate: d('2026-06-08'), status: 'completed' },
      { plannedStartDate: d('2026-06-03'), plannedEndDate: d('2026-06-07'), actualEndDate: d('2026-06-09'), status: 'completed' },
      { plannedStartDate: d('2026-06-04'), plannedEndDate: d('2026-06-07'), actualEndDate: null, status: 'in_progress' },
    ]);
    const r = await getWbsCompletionCurve('p1', 'tenant-A', NOW);
    // 06-07 時点では実績 0、06-08 で 2 件 (50%)、06-09 で 3 件 (75%)
    expect(pointAt(r.points, '2026-06-07')!.actualPct).toBe(0);
    expect(pointAt(r.points, '2026-06-08')!.actualPct).toBe(50);
    expect(pointAt(r.points, '2026-06-09')!.actualPct).toBe(75);
  });

  it('全 ACT 完了済みなら本日実績 100%', async () => {
    mockActs([
      { plannedStartDate: d('2026-06-01'), plannedEndDate: d('2026-06-05'), actualEndDate: d('2026-06-04'), status: 'completed' },
      { plannedStartDate: d('2026-06-02'), plannedEndDate: d('2026-06-06'), actualEndDate: d('2026-06-07'), status: 'completed' },
    ]);
    const r = await getWbsCompletionCurve('p1', 'tenant-A', NOW);
    expect(r.actualPctToday).toBe(100);
    expect(r.plannedPctToday).toBe(100);
  });

  describe('本日はテナント TZ (ロケール) で判定する', () => {
    // 2026-06-10 20:00 UTC = 2026-06-11 05:00 JST。JST では「本日」が翌日 (06-11) になる。
    const NOW_LATE_UTC = new Date('2026-06-10T20:00:00.000Z');

    it('JST (Asia/Tokyo) では UTC 夜が翌日扱いになる', async () => {
      mockTenantTimezone('Asia/Tokyo');
      mockActs([
        // 予定完了 06-11 の ACT は、JST 本日 (06-11) には「予定完了済み」として数える
        { plannedStartDate: d('2026-06-09'), plannedEndDate: d('2026-06-11'), actualEndDate: d('2026-06-11'), status: 'completed' },
      ]);
      const r = await getWbsCompletionCurve('p1', 'tenant-A', NOW_LATE_UTC);
      expect(r.today).toBe('2026-06-11');
      expect(r.plannedPctToday).toBe(100); // 予定完了日 06-11 ≤ 本日 06-11
      expect(r.actualPctToday).toBe(100); // 実績完了日 06-11 ≤ 本日 06-11
    });

    it('UTC テナントでは同じ時刻でも本日は前日 (06-10) のまま', async () => {
      mockTenantTimezone('UTC');
      mockActs([
        { plannedStartDate: d('2026-06-09'), plannedEndDate: d('2026-06-11'), actualEndDate: d('2026-06-11'), status: 'completed' },
      ]);
      const r = await getWbsCompletionCurve('p1', 'tenant-A', NOW_LATE_UTC);
      expect(r.today).toBe('2026-06-10');
      // 予定完了日 06-11 は UTC 本日 06-10 より後 → まだ数えない
      expect(r.plannedPctToday).toBe(0);
      // 実績も 06-11 完了は本日 (06-10) より後なので 0、かつ未来日として actual は null
      expect(r.actualPctToday).toBe(0);
    });
  });
});

// 完了 ACT 行のモック (actualEndDate + assignee)。
type CompletedRow = {
  actualEndDate: Date | null;
  assigneeId: string | null;
  assignee: { name: string } | null;
  plannedEffort: number;
  actualEffort: number | null;
};
function mockCompleted(rows: CompletedRow[]) {
  vi.mocked(prisma.task.findMany).mockResolvedValue(rows as never);
}
/** テスト簡略化: 完了行を作る。 */
function row(
  actualEndDate: string,
  assigneeId: string | null,
  name: string | null,
  plannedEffort: number,
  actualEffort: number | null,
): CompletedRow {
  return {
    actualEndDate: d(actualEndDate),
    assigneeId,
    assignee: name == null ? null : { name },
    plannedEffort,
    actualEffort,
  };
}

describe('getAssigneeWeeklyEffort', () => {
  // 2026 年: 06-01=月, 06-08=月, 06-10=水(週は 06-08), 06-15=月。
  const NOW = d('2026-06-10'); // JST 本日 = 2026-06-10 (週 06-08)

  beforeEach(() => {
    vi.clearAllMocks();
    mockTenantTimezone('Asia/Tokyo');
  });

  it('完了 ACT が 0 件なら空 + efficiency=null を返す', async () => {
    mockCompleted([]);
    const r = await getAssigneeWeeklyEffort('p1', 'tenant-A', NOW);
    expect(r.weekStarts).toEqual([]);
    expect(r.assignees).toEqual([]);
    expect(r.completedActCount).toBe(0);
    expect(r.efficiency).toBeNull();
    expect(r.today).toBe('2026-06-10');
  });

  it('完了 + 実績完了日あり + ACT + テナント境界 の where でクエリする', async () => {
    mockCompleted([]);
    await getAssigneeWeeklyEffort('p1', 'tenant-A', NOW);
    expect(prisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: 'p1',
          deletedAt: null,
          type: 'activity',
          status: 'completed',
          actualEndDate: { not: null },
          project: { tenantId: 'tenant-A' },
        }),
      }),
    );
  });

  it('実績完了日の週 × 担当者で実工数(人時)を SUM する', async () => {
    mockCompleted([
      row('2026-06-01', 'uX', 'X', 4, 5), // 週 06-01, 実工数 5
      row('2026-06-10', 'uX', 'X', 6, 7), // 週 06-08, 実工数 7
      row('2026-06-08', 'uY', 'Y', 3, 2), // 週 06-08, 実工数 2
    ]);
    const r = await getAssigneeWeeklyEffort('p1', 'tenant-A', NOW);

    expect(r.weekStarts).toEqual(['2026-06-01', '2026-06-08']);
    for (const ws of r.weekStarts) {
      expect(new Date(`${ws}T00:00:00.000Z`).getUTCDay()).toBe(1); // 月曜
    }
    // totalEffort 降順: X(12) → Y(2)
    expect(r.assignees.map((a) => a.assigneeId)).toEqual(['uX', 'uY']);
    expect(r.assignees[0].totalEffort).toBe(12);
    expect(r.assignees[0].weekly).toEqual([5, 7]);
    expect(r.assignees[1].totalEffort).toBe(2);
    expect(r.assignees[1].weekly).toEqual([0, 2]);
    expect(r.completedActCount).toBe(3);
    // 工数効率 = Σ予定(4+6+3=13) ÷ Σ実績(5+7+2=14)
    expect(r.totalPlannedEffort).toBe(13);
    expect(r.totalActualEffort).toBe(14);
    expect(r.efficiency).toBe(round(13 / 14, 2));
    expect(r.effortLoggedCount).toBe(3);
  });

  it('実工数 未入力(null) の完了は棒に乗らず効率の母数からも除外', async () => {
    mockCompleted([
      row('2026-06-08', 'uX', 'X', 10, null), // 実工数なし → 棒0、効率対象外
      row('2026-06-08', 'uX', 'X', 4, 8), // 実工数8
    ]);
    const r = await getAssigneeWeeklyEffort('p1', 'tenant-A', NOW);
    expect(r.assignees[0].totalEffort).toBe(8); // null は 0 扱い
    expect(r.completedActCount).toBe(2); // 完了件数は両方数える
    expect(r.effortLoggedCount).toBe(1); // 効率母数は実工数入力済の 1 件
    expect(r.totalPlannedEffort).toBe(4);
    expect(r.totalActualEffort).toBe(8);
    expect(r.efficiency).toBe(0.5); // 4 / 8
  });

  it('未割当 (assigneeId=null) は 1 グループ。効率>1 は効率的', async () => {
    mockCompleted([
      row('2026-06-08', null, null, 10, 5), // 予定10/実績5 → 効率2.0
    ]);
    const r = await getAssigneeWeeklyEffort('p1', 'tenant-A', NOW);
    expect(r.assignees).toHaveLength(1);
    expect(r.assignees[0].assigneeId).toBeNull();
    expect(r.assignees[0].assigneeName).toBeNull();
    expect(r.assignees[0].totalEffort).toBe(5);
    expect(r.efficiency).toBe(2); // 見積より速い
  });

  it('完了の無い中間週も 0 で連続表示する', async () => {
    mockCompleted([row('2026-06-01', 'uX', 'X', 4, 4)]);
    const r = await getAssigneeWeeklyEffort('p1', 'tenant-A', NOW);
    expect(r.weekStarts).toEqual(['2026-06-01', '2026-06-08']);
    expect(r.assignees[0].weekly).toEqual([4, 0]);
  });

  it('本日週はテナント TZ (JST) で判定し横軸を延ばす', async () => {
    const nowLate = new Date('2026-06-14T20:00:00.000Z'); // JST 06-15 (週 06-15)
    mockTenantTimezone('Asia/Tokyo');
    mockCompleted([row('2026-06-01', 'uX', 'X', 4, 4)]);
    const r = await getAssigneeWeeklyEffort('p1', 'tenant-A', nowLate);
    expect(r.today).toBe('2026-06-15');
    expect(r.weekStarts).toEqual(['2026-06-01', '2026-06-08', '2026-06-15']);
  });
});

/** 小数 2 桁丸め (サービスと同じ)。 */
function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// 予実差用の完了行 (plannedEffort + actualEffort)。
type VarRow = {
  assigneeId: string | null;
  assignee: { name: string } | null;
  plannedEffort: number;
  actualEffort: number | null;
};
function mockVariance(rows: VarRow[]) {
  vi.mocked(prisma.task.findMany).mockResolvedValue(rows as never);
}

describe('getAssigneeEffortVariance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('完了 + 実工数入力済 + ACT + テナント境界 の where でクエリする', async () => {
    mockVariance([]);
    await getAssigneeEffortVariance('p1', 'tenant-A');
    expect(prisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: 'p1',
          deletedAt: null,
          type: 'activity',
          status: 'completed',
          actualEndDate: { not: null },
          actualEffort: { not: null },
          project: { tenantId: 'tenant-A' },
        }),
      }),
    );
  });

  it('担当者ごとに予定/実績工数を SUM し、実績工数 降順で返す', async () => {
    mockVariance([
      { assigneeId: 'uX', assignee: { name: 'X' }, plannedEffort: 8, actualEffort: 10 },
      { assigneeId: 'uX', assignee: { name: 'X' }, plannedEffort: 4, actualEffort: 5 },
      { assigneeId: 'uY', assignee: { name: 'Y' }, plannedEffort: 6, actualEffort: 4 },
    ]);
    const r = await getAssigneeEffortVariance('p1', 'tenant-A');
    // 実績工数 降順: X(15) → Y(4)
    expect(r.assignees.map((a) => a.assigneeId)).toEqual(['uX', 'uY']);
    expect(r.assignees[0]).toMatchObject({ taskCount: 2, plannedEffort: 12, actualEffort: 15 });
    expect(r.assignees[1]).toMatchObject({ taskCount: 1, plannedEffort: 6, actualEffort: 4 });
    expect(r.totalPlannedEffort).toBe(18);
    expect(r.totalActualEffort).toBe(19);
  });

  it('実工数 0/未入力 は比較対象外 (where + コード両方で除外)', async () => {
    // where で actualEffort:null は除外されるが、防御的に 0 も code で除外する
    mockVariance([
      { assigneeId: 'uX', assignee: { name: 'X' }, plannedEffort: 8, actualEffort: 0 },
      { assigneeId: 'uX', assignee: { name: 'X' }, plannedEffort: 4, actualEffort: 6 },
    ]);
    const r = await getAssigneeEffortVariance('p1', 'tenant-A');
    expect(r.assignees).toHaveLength(1);
    expect(r.assignees[0]).toMatchObject({ taskCount: 1, plannedEffort: 4, actualEffort: 6 });
  });

  it('未割当 (assigneeId=null) は 1 グループになる', async () => {
    mockVariance([
      { assigneeId: null, assignee: null, plannedEffort: 5, actualEffort: 7 },
    ]);
    const r = await getAssigneeEffortVariance('p1', 'tenant-A');
    expect(r.assignees).toHaveLength(1);
    expect(r.assignees[0].assigneeId).toBeNull();
    expect(r.assignees[0].assigneeName).toBeNull();
    expect(r.assignees[0].plannedEffort).toBe(5);
    expect(r.assignees[0].actualEffort).toBe(7);
  });

  it('0 件なら空 + 合計 0', async () => {
    mockVariance([]);
    const r = await getAssigneeEffortVariance('p1', 'tenant-A');
    expect(r.assignees).toEqual([]);
    expect(r.totalPlannedEffort).toBe(0);
    expect(r.totalActualEffort).toBe(0);
  });
});

// 未完了 ACT 行 (作業負担用)。
type OpenRow = {
  assigneeId: string | null;
  assignee: { name: string } | null;
  status: string;
  plannedEffort: number;
};
// 完了+実工数 行 (ペース比用)。
type DoneRow = { assigneeId: string | null; plannedEffort: number; actualEffort: number | null };

/** openActs / doneActs の順に findMany を返す。 */
function mockWorkload(open: OpenRow[], done: DoneRow[]) {
  vi.mocked(prisma.task.findMany)
    .mockResolvedValueOnce(open as never)
    .mockResolvedValueOnce(done as never);
}

describe('getAssigneeWorkload', () => {
  beforeEach(() => vi.clearAllMocks());

  it('未完了ACTの予定工数を担当者×状態で集計 (完了除外)', async () => {
    mockWorkload(
      [
        { assigneeId: 'uX', assignee: { name: 'X' }, status: 'not_started', plannedEffort: 4 },
        { assigneeId: 'uX', assignee: { name: 'X' }, status: 'in_progress', plannedEffort: 6 },
        { assigneeId: 'uY', assignee: { name: 'Y' }, status: 'in_progress', plannedEffort: 3 },
      ],
      [],
    );
    const r = await getAssigneeWorkload('p1', 'tenant-A');
    // totalPlanned 降順: X(10) → Y(3)
    expect(r.assignees.map((a) => a.assigneeId)).toEqual(['uX', 'uY']);
    expect(r.assignees[0]).toMatchObject({ notStarted: 4, inProgress: 6, totalPlanned: 10 });
    expect(r.assignees[1]).toMatchObject({ notStarted: 0, inProgress: 3, totalPlanned: 3 });
  });

  it('未完了ACTの where は status in (not_started/in_progress) のみ (保留除外) かつ ACT/テナント境界', async () => {
    mockWorkload([], []);
    await getAssigneeWorkload('p1', 'tenant-A');
    const firstCall = vi.mocked(prisma.task.findMany).mock.calls[0][0] as { where: Record<string, unknown> };
    expect(firstCall.where).toMatchObject({
      projectId: 'p1',
      deletedAt: null,
      type: 'activity',
      status: { in: ['not_started', 'in_progress'] },
      project: { tenantId: 'tenant-A' },
    });
  });

  it('保留 (on_hold) は集計に含めない (万一渡っても加算しない)', async () => {
    mockWorkload(
      [
        { assigneeId: 'uX', assignee: { name: 'X' }, status: 'in_progress', plannedEffort: 5 },
        { assigneeId: 'uX', assignee: { name: 'X' }, status: 'on_hold', plannedEffort: 100 },
      ],
      [],
    );
    const r = await getAssigneeWorkload('p1', 'tenant-A');
    // on_hold の 100 は加算されない
    expect(r.assignees[0].totalPlanned).toBe(5);
    expect(r.assignees[0].inProgress).toBe(5);
  });

  it('個人ペース比 = Σ実績 ÷ Σ予定 (完了+実工数済から)', async () => {
    mockWorkload(
      [{ assigneeId: 'uX', assignee: { name: 'X' }, status: 'not_started', plannedEffort: 10 }],
      [
        { assigneeId: 'uX', plannedEffort: 4, actualEffort: 6 },
        { assigneeId: 'uX', plannedEffort: 6, actualEffort: 9 },
      ],
    );
    const r = await getAssigneeWorkload('p1', 'tenant-A');
    // Σ実績(15) ÷ Σ予定(10) = 1.5
    expect(r.assignees[0].paceRatio).toBe(1.5);
    expect(r.assignees[0].effortLoggedCount).toBe(2);
  });

  it('履歴が無い担当者は paceRatio=null (補正なし=×1 のフォールバック)', async () => {
    mockWorkload(
      [{ assigneeId: 'uX', assignee: { name: 'X' }, status: 'not_started', plannedEffort: 8 }],
      [], // 完了+実工数の履歴なし
    );
    const r = await getAssigneeWorkload('p1', 'tenant-A');
    expect(r.assignees[0].paceRatio).toBeNull();
    expect(r.assignees[0].effortLoggedCount).toBe(0);
  });

  it('未割当 (assigneeId=null) は 1 グループ', async () => {
    mockWorkload(
      [{ assigneeId: null, assignee: null, status: 'in_progress', plannedEffort: 5 }],
      [],
    );
    const r = await getAssigneeWorkload('p1', 'tenant-A');
    expect(r.assignees).toHaveLength(1);
    expect(r.assignees[0].assigneeId).toBeNull();
    expect(r.assignees[0].assigneeName).toBeNull();
    expect(r.assignees[0].totalPlanned).toBe(5);
  });

  it('未完了ACTが無ければ空', async () => {
    mockWorkload([], [{ assigneeId: 'uX', plannedEffort: 4, actualEffort: 5 }]);
    const r = await getAssigneeWorkload('p1', 'tenant-A');
    expect(r.assignees).toEqual([]);
  });
});

// 日次工数 (8h 上限) 用の未完了 ACT 行。
type CapRow = {
  assigneeId: string | null;
  assignee: { name: string } | null;
  plannedStartDate: Date | null;
  plannedEndDate: Date | null;
  plannedEffort: number;
};
function mockCapacity(rows: CapRow[]) {
  vi.mocked(prisma.task.findMany).mockResolvedValue(rows as never);
}
/** 未完了 ACT 行を作る。 */
function capRow(
  assigneeId: string | null,
  name: string | null,
  start: string,
  end: string,
  plannedEffort: number,
): CapRow {
  return {
    assigneeId,
    assignee: name == null ? null : { name },
    plannedStartDate: d(start),
    plannedEndDate: d(end),
    plannedEffort,
  };
}

describe('getAssigneeDailyCapacity', () => {
  const NOW = d('2026-06-10'); // JST 本日 = 2026-06-10

  beforeEach(() => {
    vi.clearAllMocks();
    mockTenantTimezone('Asia/Tokyo');
  });

  it('対象が 0 件なら空 (today だけ返す)', async () => {
    mockCapacity([]);
    const r = await getAssigneeDailyCapacity('p1', 'tenant-A', NOW);
    expect(r.dates).toEqual([]);
    expect(r.assignees).toEqual([]);
    expect(r.today).toBe('2026-06-10');
  });

  it('未完了(未着手/進行中) + ACT + 担当/日付あり + テナント境界 の where でクエリ', async () => {
    mockCapacity([]);
    await getAssigneeDailyCapacity('p1', 'tenant-A', NOW);
    expect(prisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: 'p1',
          deletedAt: null,
          type: 'activity',
          status: { in: ['not_started', 'in_progress'] },
          assigneeId: { not: null },
          plannedStartDate: { not: null },
          plannedEndDate: { not: null },
          project: { tenantId: 'tenant-A' },
        }),
      }),
    );
  });

  it('予定工数を期間で均等按分し、担当者×日付に展開する', async () => {
    // 06-10〜06-13 (4 日) に 8h → 2h/日。全日が本日以降。
    mockCapacity([capRow('uX', 'X', '2026-06-10', '2026-06-13', 8)]);
    const r = await getAssigneeDailyCapacity('p1', 'tenant-A', NOW);
    expect(r.dates).toEqual(['2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13']);
    const x = r.assignees[0];
    expect(x.assigneeId).toBe('uX');
    expect(x.cells.map((c) => c?.effortHours)).toEqual([2, 2, 2, 2]);
    expect(x.cells.every((c) => c?.level === 'ok')).toBe(true);
  });

  it('複数タスクが同じ日に重なると日次工数が合算される', async () => {
    // タスク1: 06-10〜06-11 (2日) 8h → 4h/日
    // タスク2: 06-10〜06-10 (1日) 5h → 5h/日。06-10 は 4+5=9h
    mockCapacity([
      capRow('uX', 'X', '2026-06-10', '2026-06-11', 8),
      capRow('uX', 'X', '2026-06-10', '2026-06-10', 5),
    ]);
    const r = await getAssigneeDailyCapacity('p1', 'tenant-A', NOW);
    const x = r.assignees[0];
    // 06-10 = 9h (alert), 06-11 = 4h (ok)
    expect(x.cells[0]).toMatchObject({ date: '2026-06-10', effortHours: 9, level: 'alert' });
    expect(x.cells[1]).toMatchObject({ date: '2026-06-11', effortHours: 4, level: 'ok' });
    expect(x.alertDayCount).toBe(1);
    expect(x.maxDailyEffort).toBe(9);
  });

  it('本日より前の按分日は横軸に載せない (本日以降にクリップ)', async () => {
    // 06-08〜06-11 (4 日) 8h → 2h/日。本日 06-10 以降の 06-10,06-11 のみ表示。
    mockCapacity([capRow('uX', 'X', '2026-06-08', '2026-06-11', 8)]);
    const r = await getAssigneeDailyCapacity('p1', 'tenant-A', NOW);
    expect(r.dates).toEqual(['2026-06-10', '2026-06-11']);
    expect(r.assignees[0].cells.map((c) => c?.effortHours)).toEqual([2, 2]);
  });

  it('全期間が過去のタスクしか持たない担当者は一覧から除外', async () => {
    // 06-05〜06-08 は全て本日 (06-10) より前 → 本日以降に負荷なし
    mockCapacity([capRow('uX', 'X', '2026-06-05', '2026-06-08', 8)]);
    const r = await getAssigneeDailyCapacity('p1', 'tenant-A', NOW);
    expect(r.assignees).toEqual([]);
    expect(r.dates).toEqual([]);
  });

  it('閾値: ≤7h=ok / >7h=warning / >8h=alert (境界 7.0/8.0 を確認)', async () => {
    // 各タスク 1 日 (start=end) に effort をそのまま載せる。別担当で分離。
    mockCapacity([
      capRow('u7', 'A7', '2026-06-10', '2026-06-10', 7), // 7.0 ちょうど → ok
      capRow('u7p', 'B', '2026-06-10', '2026-06-10', 7.5), // >7 → warning
      capRow('u8', 'C8', '2026-06-10', '2026-06-10', 8), // 8.0 ちょうど → warning
      capRow('u8p', 'D', '2026-06-10', '2026-06-10', 9), // >8 → alert
    ]);
    const r = await getAssigneeDailyCapacity('p1', 'tenant-A', NOW);
    const byId = Object.fromEntries(r.assignees.map((a) => [a.assigneeId, a.cells[0]?.level]));
    expect(byId['u7']).toBe('ok');
    expect(byId['u7p']).toBe('warning');
    expect(byId['u8']).toBe('warning');
    expect(byId['u8p']).toBe('alert');
  });

  it('担当者は alert 日数 → warning 日数 → 最大日次工数 の降順で並ぶ', async () => {
    mockCapacity([
      // uLow: 1 日 5h (ok のみ)
      capRow('uLow', 'Low', '2026-06-10', '2026-06-10', 5),
      // uWarn: 1 日 7.5h (warning 1 日)
      capRow('uWarn', 'Warn', '2026-06-10', '2026-06-10', 7.5),
      // uAlert: 1 日 10h (alert 1 日)
      capRow('uAlert', 'Alert', '2026-06-10', '2026-06-10', 10),
    ]);
    const r = await getAssigneeDailyCapacity('p1', 'tenant-A', NOW);
    expect(r.assignees.map((a) => a.assigneeId)).toEqual(['uAlert', 'uWarn', 'uLow']);
  });

  it('割当の無い日は null セルになる', async () => {
    // uX は 06-10 のみ、uY は 06-12 のみ。横軸は 06-10〜06-12。
    mockCapacity([
      capRow('uX', 'X', '2026-06-10', '2026-06-10', 4),
      capRow('uY', 'Y', '2026-06-12', '2026-06-12', 4),
    ]);
    const r = await getAssigneeDailyCapacity('p1', 'tenant-A', NOW);
    expect(r.dates).toEqual(['2026-06-10', '2026-06-11', '2026-06-12']);
    const x = r.assignees.find((a) => a.assigneeId === 'uX')!;
    expect(x.cells[0]?.effortHours).toBe(4);
    expect(x.cells[1]).toBeNull(); // 06-11 は割当なし
    expect(x.cells[2]).toBeNull(); // 06-12 は割当なし
  });

  it('予定工数 0 / 期間逆転 は対象外', async () => {
    mockCapacity([
      capRow('uX', 'X', '2026-06-10', '2026-06-11', 0), // 0h → 除外
      capRow('uY', 'Y', '2026-06-12', '2026-06-10', 8), // start>end → 除外
    ]);
    const r = await getAssigneeDailyCapacity('p1', 'tenant-A', NOW);
    expect(r.assignees).toEqual([]);
  });

  it('本日はテナント TZ (JST) で判定し横軸の起点が変わる', async () => {
    const nowLate = new Date('2026-06-10T20:00:00.000Z'); // JST 06-11
    mockTenantTimezone('Asia/Tokyo');
    mockCapacity([capRow('uX', 'X', '2026-06-10', '2026-06-12', 6)]);
    const r = await getAssigneeDailyCapacity('p1', 'tenant-A', nowLate);
    expect(r.today).toBe('2026-06-11');
    // 06-10 は本日 (06-11) より前なので落ち、06-11/06-12 のみ
    expect(r.dates).toEqual(['2026-06-11', '2026-06-12']);
  });
});

// ================================================================
// 対象期間フィルタ (range) — ツールバーの期間選択 (パネル別セマンティクス)
// ================================================================
describe('対象期間フィルタ (range)', () => {
  const NOW = d('2026-06-10'); // JST 本日 = 2026-06-10
  beforeEach(() => {
    vi.clearAllMocks();
    mockTenantTimezone('Asia/Tokyo');
  });

  describe('① getWbsCompletionCurve: points を [from, to] にクリップ (累積値は維持)', () => {
    beforeEach(() => {
      mockActs([
        { plannedStartDate: d('2026-06-01'), plannedEndDate: d('2026-06-05'), actualEndDate: d('2026-06-06'), status: 'completed' },
        { plannedStartDate: d('2026-06-03'), plannedEndDate: d('2026-06-08'), actualEndDate: d('2026-06-10'), status: 'completed' },
        { plannedStartDate: d('2026-06-05'), plannedEndDate: d('2026-06-12'), actualEndDate: null, status: 'in_progress' },
        { plannedStartDate: d('2026-06-06'), plannedEndDate: d('2026-06-15'), actualEndDate: null, status: 'not_started' },
      ]);
    });

    it('窓 [06-06, 06-10] の点だけ返し、累積値はプロジェクト開始からの値を保つ', async () => {
      const r = await getWbsCompletionCurve('p1', 'tenant-A', NOW, { from: '2026-06-06', to: '2026-06-10' });
      expect(r.points[0].date).toBe('2026-06-06');
      expect(r.points[r.points.length - 1].date).toBe('2026-06-10');
      // 06-06 時点で A(予定完了06-05) は既に累積済み → 予定 25%
      expect(pointAt(r.points, '2026-06-06').plannedPct).toBe(25);
      // 06-08 で A,B → 50% (窓の外の 06-01〜06-05 も加算は続いている証拠)
      expect(pointAt(r.points, '2026-06-08').plannedPct).toBe(50);
      // 本日サマリは全期間ベースのまま
      expect(r.plannedPctToday).toBe(50);
    });

    it('範囲外しか含まない窓では points 空 (集計値・本日サマリは維持)', async () => {
      const r = await getWbsCompletionCurve('p1', 'tenant-A', NOW, { from: '2025-01-01', to: '2025-01-31' });
      expect(r.points).toEqual([]);
      expect(r.totalActCount).toBe(4);
      expect(r.plannedPctToday).toBe(50);
    });
  });

  describe('② getAssigneeWeeklyEffort: 期間内に完了した ACT だけで効率・順位を再計算', () => {
    it('期間外の完了を除外し、効率を絞り込み後で算出', async () => {
      mockCompleted([
        row('2026-06-01', 'uX', 'X', 4, 5), // 週 06-01 (範囲外)
        row('2026-06-10', 'uX', 'X', 6, 7), // 週 06-08 (範囲内)
        row('2026-06-08', 'uY', 'Y', 3, 2), // 週 06-08 (範囲内)
      ]);
      const r = await getAssigneeWeeklyEffort('p1', 'tenant-A', NOW, { from: '2026-06-08', to: '2026-06-14' });
      // 06-01 の完了は範囲外 → 除外
      expect(r.completedActCount).toBe(2);
      expect(r.weekStarts).toEqual(['2026-06-08']);
      // X(7) → Y(2)
      expect(r.assignees.map((a) => a.assigneeId)).toEqual(['uX', 'uY']);
      expect(r.assignees[0].totalEffort).toBe(7);
      // 効率 = Σ予定(6+3=9) ÷ Σ実績(7+2=9) = 1
      expect(r.totalPlannedEffort).toBe(9);
      expect(r.totalActualEffort).toBe(9);
      expect(r.efficiency).toBe(1);
    });

    it('期間内に完了が無ければ空', async () => {
      mockCompleted([row('2026-06-01', 'uX', 'X', 4, 5)]);
      const r = await getAssigneeWeeklyEffort('p1', 'tenant-A', NOW, { from: '2026-06-08', to: '2026-06-14' });
      expect(r.assignees).toEqual([]);
      expect(r.efficiency).toBeNull();
    });
  });

  describe('③ getAssigneeEffortVariance: 実績完了日が範囲内の ACT だけ集計', () => {
    // 予実差用の行に actualEndDate を持たせる。
    const vrow = (id: string, name: string, end: string, planned: number, actual: number) => ({
      assigneeId: id,
      assignee: { name },
      actualEndDate: d(end),
      plannedEffort: planned,
      actualEffort: actual,
    });
    it('範囲外の完了を除外して予定/実績を再集計', async () => {
      vi.mocked(prisma.task.findMany).mockResolvedValue([
        vrow('uX', 'X', '2026-06-02', 8, 10), // 範囲外
        vrow('uX', 'X', '2026-06-10', 4, 5), // 範囲内
        vrow('uY', 'Y', '2026-06-09', 6, 4), // 範囲内
      ] as never);
      const r = await getAssigneeEffortVariance('p1', 'tenant-A', { from: '2026-06-08', to: '2026-06-14' });
      // 実績工数 降順: X(5) → Y(4)
      expect(r.assignees.map((a) => a.assigneeId)).toEqual(['uX', 'uY']);
      expect(r.assignees[0]).toMatchObject({ taskCount: 1, plannedEffort: 4, actualEffort: 5 });
      expect(r.totalPlannedEffort).toBe(10);
      expect(r.totalActualEffort).toBe(9);
    });
  });

  describe('⑤ getAssigneeDailyCapacity: range.to で未来の終端を絞る (from は無視)', () => {
    it('to で未来をキャップし、それ以降の列を出さない', async () => {
      mockCapacity([capRow('uX', 'X', '2026-06-10', '2026-06-20', 11)]); // 11 日 1h/日
      const r = await getAssigneeDailyCapacity('p1', 'tenant-A', NOW, { from: '2020-01-01', to: '2026-06-12' });
      // from は無視 (起点は本日 06-10)。to=06-12 で 06-10〜06-12 のみ
      expect(r.dates).toEqual(['2026-06-10', '2026-06-11', '2026-06-12']);
    });

    it('to が本日より前なら空', async () => {
      mockCapacity([capRow('uX', 'X', '2026-06-10', '2026-06-20', 11)]);
      const r = await getAssigneeDailyCapacity('p1', 'tenant-A', NOW, { from: null, to: '2026-06-05' });
      expect(r.dates).toEqual([]);
      expect(r.assignees).toEqual([]);
    });
  });
});
