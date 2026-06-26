/**
 * プロジェクト分析サービス — 分析タブのデータソース
 *
 * 役割:
 *   プロジェクトの進捗を「分析タブ」のグラフ用に集計する。第一弾は WBS の
 *   予定/実績の完了カーブ (予実カーブ)。PM/PL が「完了に向けた現在地」と
 *   「生産性 (消化ペース)」を 1 枚で把握するための数値を返す。
 *
 * 設計方針 (汎用分析タブ基盤):
 *   本サービスは **ドメイン数値のみ** (件数・割合) を返し、色・ラベル・線種などの
 *   表示は知らない。表示組み立てはクライアント側のパネル (analysis-panels.ts) が
 *   i18n と合わせて行う。これにより分析の追加 = ここに集計関数を 1 つ足すだけになる。
 *
 * 認可:
 *   呼び出し元 API ルート (/api/projects/[id]/analytics/...) で
 *   checkProjectPermission('analytics:read') を実施済の前提 (admin / pm_tl のみ)。
 *
 * テナント分離 (severity-1):
 *   Task は tenantId 列を持たないため、where に `project: { tenantId: viewerTenantId }`
 *   を必須付与して越境集計を遮断する (task.service.ts と同一パターン)。
 *
 * 関連: DESIGN.md §5 (tasks), docs/design/KEY_FLOWS.md (分析データフロー)
 */

import { prisma } from '@/lib/db';
import { getTenantTodayString } from '@/lib/tenant-time';
import { resolveTimezone } from '@/config/i18n';
import { classifyWorkloadLevel, type WorkloadLevel } from '@/config/workload';
import { distributeEffortByDay } from '@/lib/task-day-distribution';

/**
 * 分析の対象期間 (YYYY-MM-DD, テナント TZ 暦日)。
 *
 * 適用はパネルの性質ごとに異なる (analysis-panels.ts の rangeKind と対応):
 *   - 過去向き (予実カーブ / 週次消化工数 / 予実差): [from, to] で対象を絞る。
 *   - 未来向き (日次工数): from は無視 (起点は常に本日)、to で未来の終端を絞る。
 * `from` / `to` が未指定 (null/undefined) の側は無制限。
 */
export type AnalyticsRange = {
  /** 下限 (この日を含む)。未指定なら下限なし。 */
  from?: string | null;
  /** 上限 (この日を含む)。未指定なら上限なし。 */
  to?: string | null;
};

/** ymd が [from, to] (両端含む) に入るか。未指定の境界は無制限。 */
function inRange(ymd: string, range?: AnalyticsRange): boolean {
  if (!range) return true;
  if (range.from && ymd < range.from) return false;
  if (range.to && ymd > range.to) return false;
  return true;
}

/** 予実カーブの 1 日分の点。 */
export type WbsCompletionPoint = {
  /** YYYY-MM-DD (UTC ベース)。 */
  date: string;
  /** 予定完了日が当日までに到来した ACT の累積件数。 */
  plannedCount: number;
  /** plannedCount / ACT 総数 × 100 (小数 1 桁)。 */
  plannedPct: number;
  /**
   * 完了済みかつ実績完了日が当日までに到来した ACT の累積件数。
   * 本日より後の日付では null (実績線は未来を描かない)。
   */
  actualCount: number | null;
  /** actualCount / ACT 総数 × 100 (小数 1 桁)。本日より後は null。 */
  actualPct: number | null;
};

/** getWbsCompletionCurve の戻り値。 */
export type WbsCompletionResult = {
  /** 分母となる ACT 総数 (type='activity', 削除除く)。 */
  totalActCount: number;
  /** 完了 (status='completed') の ACT 件数。 */
  completedActCount: number;
  /** 集計基準の「本日」(YYYY-MM-DD, UTC)。 */
  today: string;
  /** 本日時点の予定割合 (%)。 */
  plannedPctToday: number;
  /** 本日時点の実績割合 (%)。 */
  actualPctToday: number;
  /** 実績 − 予定 (%)。負なら遅れ、正なら先行。 */
  gapPctToday: number;
  /** 横軸 (日次) の各点。date 昇順。ACT が 0 件なら空配列。 */
  points: WbsCompletionPoint[];
};

/** Date を YYYY-MM-DD (UTC) に変換。 */
function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 小数 digits 桁で丸める。 */
function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * テナントのタイムゾーン (既定 'Asia/Tokyo'=JST) における「本日」を YYYY-MM-DD で返す。
 * ガント / 画面表示と同じ getTenantTodayString を流用し、UTC 起点の日付ずれを排除する。
 */
async function resolveTenantTodayYmd(viewerTenantId: string, now: Date): Promise<string> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: viewerTenantId },
    select: { timezone: true },
  });
  return getTenantTodayString(now, resolveTimezone(tenant?.timezone));
}

/**
 * WBS 予実カーブを集計する。
 *
 * 仕様 (ユーザ確定 2026-06-11):
 *   - 分母 D = ACT 総数 (type='activity', deletedAt=null)。WP は分母に含めない。
 *   - 縦軸 = 着手割合 (累積 ÷ D × 100)。
 *   - 横軸 = 日次。最小予定開始日 〜 max(最大予定完了日, 最大実績完了日, 本日)。
 *   - 予定線: 各日 d で「予定完了日 ≤ d」の ACT 累積件数 ÷ D。
 *   - 実績線: 各日 d で「status='completed' かつ 実績完了日 ≤ d」の ACT 累積件数 ÷ D。
 *             本日より後の日付は null (未来は描かない)。
 *   - 期間が複数日にまたがっても ACT は完了日の 1 点に丸ごと計上する (按分しない)。
 *
 * 「本日」の判定 (2026-06-11 ユーザ要望):
 *   テナントのタイムゾーン (Tenant.timezone, 既定 'Asia/Tokyo'=JST) で暦日を算出する。
 *   日付列 (plannedEndDate 等) は @db.Date の暦日のため、本日もテナント TZ の暦日で揃える。
 *   ガント / 画面表示と同じ getTenantTodayString を流用 (UTC 起点で日付がずれる罠を排除)。
 *
 * @param now 集計基準時刻 (テスト用に注入可能。既定は現在時刻)。
 */
export async function getWbsCompletionCurve(
  projectId: string,
  viewerTenantId: string,
  now: Date = new Date(),
  range?: AnalyticsRange,
): Promise<WbsCompletionResult> {
  // 本日はテナント TZ (例: 日本 → JST) の暦日で判定する。
  const today = await resolveTenantTodayYmd(viewerTenantId, now);

  // ACT のみ取得 (WP は分母に含めない)。severity-1: project tenant 越境遮断。
  const acts = await prisma.task.findMany({
    where: {
      projectId,
      deletedAt: null,
      type: 'activity',
      project: { tenantId: viewerTenantId },
    },
    select: {
      plannedStartDate: true,
      plannedEndDate: true,
      actualEndDate: true,
      status: true,
    },
  });

  const totalActCount = acts.length;
  if (totalActCount === 0) {
    return {
      totalActCount: 0,
      completedActCount: 0,
      today,
      plannedPctToday: 0,
      actualPctToday: 0,
      gapPctToday: 0,
      points: [],
    };
  }

  const completedActCount = acts.filter((a) => a.status === 'completed').length;

  // 完了日 (YYYY-MM-DD) ごとの増分マップを構築。
  //   予定: plannedEndDate を持つ全 ACT。
  //   実績: status='completed' かつ actualEndDate を持つ ACT (完了日に計上)。
  const plannedInc = new Map<string, number>();
  const actualInc = new Map<string, number>();
  const allDates: string[] = [];

  for (const a of acts) {
    if (a.plannedStartDate) allDates.push(toYmd(a.plannedStartDate));
    if (a.plannedEndDate) {
      const ymd = toYmd(a.plannedEndDate);
      plannedInc.set(ymd, (plannedInc.get(ymd) ?? 0) + 1);
      allDates.push(ymd);
    }
    if (a.status === 'completed' && a.actualEndDate) {
      const ymd = toYmd(a.actualEndDate);
      actualInc.set(ymd, (actualInc.get(ymd) ?? 0) + 1);
      allDates.push(ymd);
    }
  }

  // 横軸の範囲。日付が 1 つも無い (全 ACT の日付が null) 場合は本日 1 点に縮退。
  allDates.push(today);
  const startYmd = allDates.reduce((min, d) => (d < min ? d : min), today);
  const endYmd = allDates.reduce((max, d) => (d > max ? d : max), today);

  // 本日時点のサマリ (横軸範囲に依存せず直接カウント)。
  const plannedCountToday = acts.filter(
    (a) => a.plannedEndDate && toYmd(a.plannedEndDate) <= today,
  ).length;
  const actualCountToday = acts.filter(
    (a) => a.status === 'completed' && a.actualEndDate && toYmd(a.actualEndDate) <= today,
  ).length;
  const plannedPctToday = round((plannedCountToday / totalActCount) * 100, 1);
  const actualPctToday = round((actualCountToday / totalActCount) * 100, 1);
  const gapPctToday = round(actualPctToday - plannedPctToday, 1);

  // 日次の累積点を生成 (start 〜 end inclusive)。
  const points: WbsCompletionPoint[] = [];
  let plannedCum = 0;
  let actualCum = 0;
  const cursor = new Date(`${startYmd}T00:00:00.000Z`);
  const endDate = new Date(`${endYmd}T00:00:00.000Z`);
  // 暴走防止の上限 (約 10 年)。現実的なプロジェクト期間では到達しない。
  let guard = 0;
  while (cursor.getTime() <= endDate.getTime() && guard < 3700) {
    const ymd = toYmd(cursor);
    // 累積は常にプロジェクト開始から積み上げる (期間で絞っても窓内の値が正しくなるよう、
    // from より前の日も加算は続け、push だけ期間内に限定する)。
    plannedCum += plannedInc.get(ymd) ?? 0;
    actualCum += actualInc.get(ymd) ?? 0;
    const isFuture = ymd > today;
    if (inRange(ymd, range)) {
      points.push({
        date: ymd,
        plannedCount: plannedCum,
        plannedPct: round((plannedCum / totalActCount) * 100, 1),
        actualCount: isFuture ? null : actualCum,
        actualPct: isFuture ? null : round((actualCum / totalActCount) * 100, 1),
      });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }

  return {
    totalActCount,
    completedActCount,
    today,
    plannedPctToday,
    actualPctToday,
    gapPctToday,
    points,
  };
}

// ================================================================
// 担当者別 週次消化数 (ACT スループット) — 分析タブ パネル2
// ================================================================

/** 担当者別 週次消化工数 + 工数効率の集計結果。 */
export type AssigneeWeeklyEffortResult = {
  /** 集計基準の本日 (YYYY-MM-DD, テナント TZ)。 */
  today: string;
  /** 週開始 (月曜) の YYYY-MM-DD を昇順で。完了 ACT が無ければ空配列。 */
  weekStarts: string[];
  /** 担当者ごとの週次実績工数 (totalEffort 降順)。 */
  assignees: {
    /** 担当者 ID。未割当は null。 */
    assigneeId: string | null;
    /** 担当者氏名 (DB)。未割当は null (表示側で i18n)。 */
    assigneeName: string | null;
    /** 期間内の実績工数合計 (人時)。 */
    totalEffort: number;
    /** weekStarts と同じ index の週次実績工数 (人時)。 */
    weekly: number[];
  }[];
  /** 完了 ACT 総数 (実工数の有無を問わない)。 */
  completedActCount: number;
  /** うち実績工数を入力済みの ACT 件数 (効率の母数)。 */
  effortLoggedCount: number;
  /** 効率算出対象 (完了 + 実工数入力済) の予定工数合計 (人時)。 */
  totalPlannedEffort: number;
  /** 同 実績工数合計 (人時)。 */
  totalActualEffort: number;
  /** 工数効率 = 予定工数 ÷ 実績工数 (>1 効率的 / <1 想定超過)。実工数が無ければ null。 */
  efficiency: number | null;
};

/** ymd (UTC) が属する ISO 週 (月曜始まり) の月曜日を YYYY-MM-DD で返す。 */
function weekStartMonday(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  const dow = d.getUTCDay(); // 0=Sun .. 6=Sat
  const diff = dow === 0 ? -6 : 1 - dow; // 月曜まで戻す
  d.setUTCDate(d.getUTCDate() + diff);
  return toYmd(d);
}

/** start..end (両端含む) の月曜日を 7 日刻みで列挙。 */
function enumerateWeeks(startMonday: string, endMonday: string): string[] {
  const weeks: string[] = [];
  const cursor = new Date(`${startMonday}T00:00:00.000Z`);
  const end = new Date(`${endMonday}T00:00:00.000Z`);
  let guard = 0;
  while (cursor.getTime() <= end.getTime() && guard < 540) {
    weeks.push(toYmd(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
    guard += 1;
  }
  return weeks;
}

/**
 * 担当者別の「週次 消化工数 (実績工数)」と「工数効率」を集計する (分析タブ パネル2)。
 *
 * 目的:
 *   予実カーブで遅れ/先行が見えたあと、「なぜ生産性が高い/低いのか」を、
 *   どの担当者がいつどれだけの工数をこなしたか (出来高) と、見積に対する効率で説明する。
 *   件数ではなく **実績工数 (人時)** で測ることで、タスクの大小を吸収する。
 *
 * 仕様 (ユーザ確定 2026-06-11):
 *   - 対象 = status='completed' かつ actualEndDate を持つ ACT (type='activity')。
 *   - 棒 = 実績完了日が属する週 (月曜始まり) × 担当者 で **actualEffort を SUM** (人時)。
 *     actualEffort 未入力 (null) は 0 として扱う (棒に乗らない = 入力を促す)。
 *   - 横軸 = 週次。範囲 = 最初に完了した週 〜 max(本日週, 最後に完了した週)。中間週も 0 で連続表示。
 *   - 担当者は totalEffort 降順。未割当 (assigneeId=null) は 1 グループ。上位 N + その他は表示側の責務。
 *   - 工数効率 = Σ予定工数 ÷ Σ実績工数 (完了 + 実工数入力済の ACT のみ)。実工数 0 の場合 null。
 *     これは「見積に対する効率 (EVM の CPI 相当)」であり、絶対的生産性ではない点に留意。
 *
 * 「本日週」はテナント TZ (JST 等) で判定 (getWbsCompletionCurve と整合)。
 * テナント分離 (severity-1): where に project: { tenantId: viewerTenantId } を必須付与。
 *
 * @param now 集計基準時刻 (テスト用に注入可能)。
 */
export async function getAssigneeWeeklyEffort(
  projectId: string,
  viewerTenantId: string,
  now: Date = new Date(),
  range?: AnalyticsRange,
): Promise<AssigneeWeeklyEffortResult> {
  const today = await resolveTenantTodayYmd(viewerTenantId, now);
  const empty: AssigneeWeeklyEffortResult = {
    today,
    weekStarts: [],
    assignees: [],
    completedActCount: 0,
    effortLoggedCount: 0,
    totalPlannedEffort: 0,
    totalActualEffort: 0,
    efficiency: null,
  };

  const allActs = await prisma.task.findMany({
    where: {
      projectId,
      deletedAt: null,
      type: 'activity',
      status: 'completed',
      actualEndDate: { not: null },
      project: { tenantId: viewerTenantId },
    },
    select: {
      actualEndDate: true,
      assigneeId: true,
      assignee: { select: { name: true } },
      plannedEffort: true,
      actualEffort: true,
    },
  });

  // 対象期間: 実績完了日 (actualEndDate) が [from, to] に入る完了 ACT のみで再集計する。
  const acts = range
    ? allActs.filter((a) => a.actualEndDate != null && inRange(toYmd(a.actualEndDate), range))
    : allActs;

  if (acts.length === 0) return empty;

  // 担当者 (null 含む) → { name, totalEffort, weekMap(weekStart→effort) }
  const UNASSIGNED = '__unassigned__';
  type Acc = {
    assigneeId: string | null;
    assigneeName: string | null;
    totalEffort: number;
    weekMap: Map<string, number>;
  };
  const byAssignee = new Map<string, Acc>();
  const todayWeek = weekStartMonday(today);
  let minWeek = todayWeek;
  let maxCompletionWeek = todayWeek;
  let firstWeekSeen = false;

  // 工数効率サマリ (完了 + 実工数入力済の ACT のみ)。
  let effortLoggedCount = 0;
  let totalPlannedEffort = 0;
  let totalActualEffort = 0;

  for (const a of acts) {
    if (!a.actualEndDate) continue;
    const ws = weekStartMonday(toYmd(a.actualEndDate));
    if (!firstWeekSeen || ws < minWeek) {
      minWeek = ws;
      firstWeekSeen = true;
    }
    if (ws > maxCompletionWeek) maxCompletionWeek = ws;

    const effort = a.actualEffort == null ? 0 : Number(a.actualEffort);

    const key = a.assigneeId ?? UNASSIGNED;
    const acc = byAssignee.get(key) ?? {
      assigneeId: a.assigneeId ?? null,
      assigneeName: a.assignee?.name ?? null,
      totalEffort: 0,
      weekMap: new Map<string, number>(),
    };
    acc.totalEffort += effort;
    acc.weekMap.set(ws, (acc.weekMap.get(ws) ?? 0) + effort);
    byAssignee.set(key, acc);

    // 効率: 実工数が入力済 (> 0) の完了 ACT のみを母数にする。
    if (effort > 0) {
      effortLoggedCount += 1;
      totalPlannedEffort += Number(a.plannedEffort);
      totalActualEffort += effort;
    }
  }

  // 横軸の週: 最初の完了週 〜 max(本日週, 最後の完了週) を連続列挙。
  const endWeek = maxCompletionWeek > todayWeek ? maxCompletionWeek : todayWeek;
  const weekStarts = enumerateWeeks(minWeek, endWeek);

  const assignees = Array.from(byAssignee.values())
    .map((acc) => ({
      assigneeId: acc.assigneeId,
      assigneeName: acc.assigneeName,
      totalEffort: round(acc.totalEffort, 2),
      weekly: weekStarts.map((ws) => round(acc.weekMap.get(ws) ?? 0, 2)),
    }))
    .sort(
      (a, b) => b.totalEffort - a.totalEffort || (a.assigneeName ?? '').localeCompare(b.assigneeName ?? ''),
    );

  return {
    today,
    weekStarts,
    assignees,
    completedActCount: acts.length,
    effortLoggedCount,
    totalPlannedEffort: round(totalPlannedEffort, 2),
    totalActualEffort: round(totalActualEffort, 2),
    efficiency: totalActualEffort > 0 ? round(totalPlannedEffort / totalActualEffort, 2) : null,
  };
}

// ================================================================
// 担当者別 予定工数 vs 実績工数 (工数の予実差) — 分析タブ パネル3
// ================================================================

/** 担当者別 予定/実績 工数の対比結果。 */
export type AssigneeEffortVarianceResult = {
  /** 担当者ごとの予定/実績工数 (実績工数 降順)。 */
  assignees: {
    /** 担当者 ID。未割当は null。 */
    assigneeId: string | null;
    /** 担当者氏名 (DB)。未割当は null (表示側で i18n)。 */
    assigneeName: string | null;
    /** 比較対象タスク件数 (完了 + 実工数入力済)。 */
    taskCount: number;
    /** 予定工数合計 (人時)。 */
    plannedEffort: number;
    /** 実績工数合計 (人時)。 */
    actualEffort: number;
  }[];
  /** 全体の予定工数合計 (人時)。 */
  totalPlannedEffort: number;
  /** 全体の実績工数合計 (人時)。 */
  totalActualEffort: number;
};

/**
 * 担当者別の「予定工数 vs 実績工数」を集計する (分析タブ パネル3)。
 *
 * 目的:
 *   PM/PL が記載した予定工数と、担当者が記載した実績工数の差を担当者ごとに把握し、
 *   見積もりやタスク割り振りの参考にする。
 *
 * 仕様:
 *   - 母数 = status='completed' かつ actualEndDate あり かつ **実績工数 > 0** の ACT
 *     (予定・実績の両方が揃うタスクのみで公平に比較する)。
 *   - 担当者ごとに plannedEffort / actualEffort を SUM。担当者は実績工数 降順。
 *   - 未割当 (assigneeId=null) は 1 グループ。上位 N + その他は表示側の責務。
 *   - 時系列でないため本日 (TZ) 判定は不要。
 *
 * テナント分離 (severity-1): where に project: { tenantId: viewerTenantId } を必須付与。
 */
export async function getAssigneeEffortVariance(
  projectId: string,
  viewerTenantId: string,
  range?: AnalyticsRange,
): Promise<AssigneeEffortVarianceResult> {
  const allActs = await prisma.task.findMany({
    where: {
      projectId,
      deletedAt: null,
      type: 'activity',
      status: 'completed',
      actualEndDate: { not: null },
      actualEffort: { not: null },
      project: { tenantId: viewerTenantId },
    },
    select: {
      assigneeId: true,
      assignee: { select: { name: true } },
      actualEndDate: true,
      plannedEffort: true,
      actualEffort: true,
    },
  });

  // 対象期間: 実績完了日が [from, to] に入る完了 ACT のみで再集計する。
  const acts = range
    ? allActs.filter((a) => a.actualEndDate != null && inRange(toYmd(a.actualEndDate), range))
    : allActs;

  const UNASSIGNED = '__unassigned__';
  type Acc = {
    assigneeId: string | null;
    assigneeName: string | null;
    taskCount: number;
    plannedEffort: number;
    actualEffort: number;
  };
  const byAssignee = new Map<string, Acc>();
  let totalPlannedEffort = 0;
  let totalActualEffort = 0;

  for (const a of acts) {
    const actual = a.actualEffort == null ? 0 : Number(a.actualEffort);
    if (actual <= 0) continue; // 実工数 0/未入力 は比較対象外
    const planned = Number(a.plannedEffort);

    const key = a.assigneeId ?? UNASSIGNED;
    const acc = byAssignee.get(key) ?? {
      assigneeId: a.assigneeId ?? null,
      assigneeName: a.assignee?.name ?? null,
      taskCount: 0,
      plannedEffort: 0,
      actualEffort: 0,
    };
    acc.taskCount += 1;
    acc.plannedEffort += planned;
    acc.actualEffort += actual;
    byAssignee.set(key, acc);

    totalPlannedEffort += planned;
    totalActualEffort += actual;
  }

  const assignees = Array.from(byAssignee.values())
    .map((acc) => ({
      assigneeId: acc.assigneeId,
      assigneeName: acc.assigneeName,
      taskCount: acc.taskCount,
      plannedEffort: round(acc.plannedEffort, 2),
      actualEffort: round(acc.actualEffort, 2),
    }))
    .sort(
      (a, b) => b.actualEffort - a.actualEffort || (a.assigneeName ?? '').localeCompare(b.assigneeName ?? ''),
    );

  return {
    assignees,
    totalPlannedEffort: round(totalPlannedEffort, 2),
    totalActualEffort: round(totalActualEffort, 2),
  };
}

// ================================================================
// 担当者別 作業負担 (未完了の予定工数) — 分析タブ パネル4
// ================================================================

/** 担当者別 作業負担の集計結果。 */
export type AssigneeWorkloadResult = {
  /** 担当者ごとの未完了予定工数 (totalPlanned 降順)。 */
  assignees: {
    /** 担当者 ID。未割当は null。 */
    assigneeId: string | null;
    /** 担当者氏名 (DB)。未割当は null (表示側で i18n)。 */
    assigneeName: string | null;
    /** 未着手 ACT の予定工数合計 (人時)。 */
    notStarted: number;
    /** 進行中 ACT の予定工数合計 (人時)。 */
    inProgress: number;
    /** 未完了の予定工数合計 (人時) = notStarted + inProgress。保留 (on_hold) は集計に含めない。 */
    totalPlanned: number;
    /**
     * 個人ペース比 = Σ実績工数 ÷ Σ予定工数 (完了 + 実工数入力済の履歴から)。
     * 補正モードで totalPlanned に掛けて「予想残工数」を出す。履歴が無ければ null (補正なし=×1)。
     */
    paceRatio: number | null;
    /** ペース比の母数 (完了 + 実工数入力済の件数)。信頼度の目安。 */
    effortLoggedCount: number;
  }[];
};

/**
 * 担当者別の「作業負担 (未完了タスクの予定工数)」と「個人ペース比」を集計する (分析タブ パネル4)。
 *
 * 目的:
 *   できる人に作業が偏るのを防ぎ、負荷分散・割り振りを検討するための材料。
 *   誰に作業が多く残り、誰が軽いかを比較する。
 *
 * 仕様:
 *   - 負担 = status が 未着手 (not_started) / 進行中 (in_progress) の ACT の予定工数を担当者×状態で SUM。
 *     完了タスクは含めない (もう負担ではない)。**保留 (on_hold) も含めない** (ユーザ要件 2026-06-15。
 *     保留は一時停止中で現在の負担とは言えないため)。
 *   - 個人ペース比 = 完了 + 実工数入力済の ACT から Σ実績 ÷ Σ予定。補正モードでこの比を掛ける。履歴なし null。
 *   - 担当者は totalPlanned 降順。未割当 (assigneeId=null) は 1 グループ。上位 N + その他は表示側の責務。
 *   - 時系列でないため本日 (TZ) 判定は不要。
 *
 * 注意 (限界): 予定工数は見積であり「その人にとってのきつさ」を正確には測れない。補正モードは個人の
 *   実績/予定比でスピード差を織り込むが、見積誤差は残る。個人評価には使わない (UI/FAQ で明記)。
 *   未完了タスクが 0 件の担当者は (タスク由来の集計のため) 一覧に現れない。
 *
 * テナント分離 (severity-1): where に project: { tenantId: viewerTenantId } を必須付与。
 */
export async function getAssigneeWorkload(
  projectId: string,
  viewerTenantId: string,
): Promise<AssigneeWorkloadResult> {
  // 未完了 ACT (負担の母数)
  const openActs = await prisma.task.findMany({
    where: {
      projectId,
      deletedAt: null,
      type: 'activity',
      status: { in: ['not_started', 'in_progress'] }, // 保留 (on_hold) は除外
      project: { tenantId: viewerTenantId },
    },
    select: {
      assigneeId: true,
      assignee: { select: { name: true } },
      status: true,
      plannedEffort: true,
    },
  });

  // 個人ペース比の母数: 完了 + 実工数入力済
  const doneActs = await prisma.task.findMany({
    where: {
      projectId,
      deletedAt: null,
      type: 'activity',
      status: 'completed',
      actualEffort: { not: null },
      project: { tenantId: viewerTenantId },
    },
    select: {
      assigneeId: true,
      plannedEffort: true,
      actualEffort: true,
    },
  });

  const UNASSIGNED = '__unassigned__';

  // ペース比 (assigneeKey → {planned, actual, count})
  const paceByKey = new Map<string, { planned: number; actual: number; count: number }>();
  for (const a of doneActs) {
    const actual = a.actualEffort == null ? 0 : Number(a.actualEffort);
    if (actual <= 0) continue;
    const key = a.assigneeId ?? UNASSIGNED;
    const acc = paceByKey.get(key) ?? { planned: 0, actual: 0, count: 0 };
    acc.planned += Number(a.plannedEffort);
    acc.actual += actual;
    acc.count += 1;
    paceByKey.set(key, acc);
  }

  // 未完了 ACT を担当者×状態で集計 (保留 on_hold は where で除外済)
  type Acc = {
    assigneeId: string | null;
    assigneeName: string | null;
    notStarted: number;
    inProgress: number;
  };
  const byAssignee = new Map<string, Acc>();
  for (const a of openActs) {
    const key = a.assigneeId ?? UNASSIGNED;
    const acc = byAssignee.get(key) ?? {
      assigneeId: a.assigneeId ?? null,
      assigneeName: a.assignee?.name ?? null,
      notStarted: 0,
      inProgress: 0,
    };
    const effort = Number(a.plannedEffort);
    if (a.status === 'not_started') acc.notStarted += effort;
    else if (a.status === 'in_progress') acc.inProgress += effort;
    byAssignee.set(key, acc);
  }

  const assignees = Array.from(byAssignee.entries())
    .map(([key, acc]) => {
      const totalPlanned = acc.notStarted + acc.inProgress;
      const pace = paceByKey.get(key);
      const paceRatio = pace && pace.planned > 0 ? round(pace.actual / pace.planned, 2) : null;
      return {
        assigneeId: acc.assigneeId,
        assigneeName: acc.assigneeName,
        notStarted: round(acc.notStarted, 2),
        inProgress: round(acc.inProgress, 2),
        totalPlanned: round(totalPlanned, 2),
        paceRatio,
        effortLoggedCount: pace?.count ?? 0,
      };
    })
    .sort(
      (a, b) => b.totalPlanned - a.totalPlanned || (a.assigneeName ?? '').localeCompare(b.assigneeName ?? ''),
    );

  return { assignees };
}

// ================================================================
// 担当者別 日次工数 (1 日 8h 上限チェック) — 分析タブ パネル5
// ================================================================

/** 担当者×日付 の 1 セル (日次予定工数 + 閾値レベル)。 */
export type AssigneeDailyCapacityCell = {
  /** 日付 (YYYY-MM-DD, テナント TZ 暦日)。 */
  date: string;
  /** その日の予定工数合計 (人時)。期間で均等按分した値の和。 */
  effortHours: number;
  /** 閾値レベル (≤7h ok / >7h warning / >8h alert)。 */
  level: WorkloadLevel;
};

/** 担当者別 日次工数の集計結果。 */
export type AssigneeDailyCapacityResult = {
  /** 集計基準の本日 (YYYY-MM-DD, テナント TZ)。列はこの日以降。 */
  today: string;
  /** 横軸の日付 (本日 〜 未完了タスクの最大予定完了日)。昇順。対象が無ければ空配列。 */
  dates: string[];
  /** 担当者ごとの日次セル (超過日数の多い順 → 最大日次工数の多い順)。 */
  assignees: {
    /** 担当者 ID。未割当は null。 */
    assigneeId: string | null;
    /** 担当者氏名 (DB)。未割当は null (表示側で i18n)。 */
    assigneeName: string | null;
    /** dates と同じ index のセル。割当の無い日 (按分 0) は null。 */
    cells: (AssigneeDailyCapacityCell | null)[];
    /** 8h 超 (alert) の日数。並び替え・サマリ用。 */
    alertDayCount: number;
    /** 7h 超 (warning + alert) の日数。 */
    warnDayCount: number;
    /** 期間内の日次工数の最大値 (人時)。 */
    maxDailyEffort: number;
  }[];
};

/**
 * 担当者別の「日次 予定工数 (1 日 8h 上限チェック)」を集計する (分析タブ パネル5)。
 *
 * 目的:
 *   WBS で設定した予定工数を日次に按分し、各担当者の 1 日の負荷が上限 (8h) に
 *   達していないかを担当者×日付の一覧 (ヒートマップ) で俯瞰する。山積み (特定日への
 *   集中) を早期に発見し、負荷の平準化・割り振り直しの材料にする。パネル4 (作業負担の
 *   総量比較) と役割を分け、本パネルは「いつ」に焦点を当てる。
 *
 * 仕様 (ユーザ確定 2026-06-12):
 *   - 対象 = status が 未着手 (not_started) / 進行中 (in_progress) の ACT (type='activity')。
 *     完了・保留 (on_hold) は除外 (現在〜将来の負荷のみを見る)。
 *   - 各タスクの plannedEffort を予定期間 (plannedStartDate〜plannedEndDate, inclusive) の
 *     日数で **均等按分** し、担当者×日付で SUM (既存 getAssigneeDailyWorkload と同ロジック)。
 *   - 横軸 = 本日 〜 未完了タスクの最大予定完了日。本日より前の按分日は表示しない (過去の
 *     負荷は対象外)。割当の無い日は空セル (null)。
 *   - 閾値・色 = config/workload.ts を流用。≤7h=OK / >7h=警告 / >8h=超過 (classifyWorkloadLevel)。
 *   - 担当者は alert 日数 → warning 日数 → 最大日次工数 の降順 (逼迫している人を上に)。
 *     未割当 (assigneeId=null) も 1 グループ。
 *
 * 「本日」はテナント TZ (JST 等) で判定 (他パネルと整合)。
 *
 * 注意 (限界): 均等按分は概算であり、実際の作業配分 (前倒し/後ろ倒し) は反映しない。
 *   土日祝も 1 日として按分する (営業日按分は将来拡張)。個人評価には使わない (UI/FAQ で明記)。
 *   plannedStartDate / plannedEndDate / 正の plannedEffort が揃わない ACT は按分できず対象外。
 *
 * テナント分離 (severity-1): where に project: { tenantId: viewerTenantId } を必須付与。
 *
 * @param now 集計基準時刻 (テスト用に注入可能)。
 */
export async function getAssigneeDailyCapacity(
  projectId: string,
  viewerTenantId: string,
  now: Date = new Date(),
  range?: AnalyticsRange,
): Promise<AssigneeDailyCapacityResult> {
  const today = await resolveTenantTodayYmd(viewerTenantId, now);
  // 未来向きパネル: from は無視 (起点は常に本日)。to があれば未来の終端を絞る。
  // to が本日より前なら表示対象 0 (空) になる。
  const futureCap = range?.to ?? null;

  const openActs = await prisma.task.findMany({
    where: {
      projectId,
      deletedAt: null,
      type: 'activity',
      status: { in: ['not_started', 'in_progress'] }, // 完了・保留 (on_hold) は除外
      assigneeId: { not: null },
      plannedStartDate: { not: null },
      plannedEndDate: { not: null },
      project: { tenantId: viewerTenantId },
    },
    select: {
      assigneeId: true,
      assignee: { select: { name: true } },
      plannedStartDate: true,
      plannedEndDate: true,
      plannedEffort: true,
      includeWeekends: true,
    },
  });

  const empty: AssigneeDailyCapacityResult = { today, dates: [], assignees: [] };
  if (openActs.length === 0) return empty;

  const UNASSIGNED = '__unassigned__';
  type Acc = {
    assigneeId: string | null;
    assigneeName: string | null;
    dailyMap: Map<string, number>;
  };
  const byAssignee = new Map<string, Acc>();
  let maxDateSeen = today; // 横軸の終端 (本日以降の最大按分日)

  for (const a of openActs) {
    if (!a.assigneeId || !a.plannedStartDate || !a.plannedEndDate) continue;
    const effort = Number(a.plannedEffort);
    if (effort <= 0) continue;

    const startStr = a.plannedStartDate.toISOString().split('T')[0]!;
    const endStr = a.plannedEndDate.toISOString().split('T')[0]!;
    const entries = distributeEffortByDay(startStr, endStr, effort, a.includeWeekends);
    if (entries.length === 0) continue;

    const key = a.assigneeId ?? UNASSIGNED;
    const acc = byAssignee.get(key) ?? {
      assigneeId: a.assigneeId ?? null,
      assigneeName: a.assignee?.name ?? null,
      dailyMap: new Map<string, number>(),
    };

    // 本日以降、かつ未来キャップ以内の稼働日のみ横軸に載せる
    for (const entry of entries) {
      const ymd = entry.date;
      if (ymd >= today && (futureCap == null || ymd <= futureCap)) {
        acc.dailyMap.set(ymd, (acc.dailyMap.get(ymd) ?? 0) + entry.dailyEffort);
        if (ymd > maxDateSeen) maxDateSeen = ymd;
      }
    }
    byAssignee.set(key, acc);
  }

  // 本日以降に 1 日も負荷の無い担当者 (全タスクが過去) は一覧から除外。
  const accList = Array.from(byAssignee.values()).filter((acc) => acc.dailyMap.size > 0);
  if (accList.length === 0) return empty;

  // 横軸: 本日 〜 maxDateSeen を連続列挙。
  const dates = enumerateDays(today, maxDateSeen);

  const assignees = accList
    .map((acc) => {
      let alertDayCount = 0;
      let warnDayCount = 0;
      let maxDailyEffort = 0;
      const cells = dates.map((d) => {
        const raw = acc.dailyMap.get(d);
        if (raw == null) return null;
        const effortHours = round(raw, 2);
        const level = classifyWorkloadLevel(effortHours);
        if (level === 'alert') alertDayCount += 1;
        if (level === 'alert' || level === 'warning') warnDayCount += 1;
        if (effortHours > maxDailyEffort) maxDailyEffort = effortHours;
        return { date: d, effortHours, level };
      });
      return {
        assigneeId: acc.assigneeId,
        assigneeName: acc.assigneeName,
        cells,
        alertDayCount,
        warnDayCount,
        maxDailyEffort: round(maxDailyEffort, 2),
      };
    })
    .sort(
      (a, b) =>
        b.alertDayCount - a.alertDayCount ||
        b.warnDayCount - a.warnDayCount ||
        b.maxDailyEffort - a.maxDailyEffort ||
        (a.assigneeName ?? '').localeCompare(b.assigneeName ?? ''),
    );

  return { today, dates, assignees };
}

/** start..end (両端含む) の暦日を 1 日刻みで列挙 (YYYY-MM-DD)。 */
function enumerateDays(startYmd: string, endYmd: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${startYmd}T00:00:00.000Z`);
  const end = new Date(`${endYmd}T00:00:00.000Z`);
  let guard = 0;
  // 暴走防止の上限 (約 2 年)。現実的なプロジェクト期間では到達しない。
  while (cursor.getTime() <= end.getTime() && guard < 760) {
    out.push(toYmd(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }
  return out;
}
