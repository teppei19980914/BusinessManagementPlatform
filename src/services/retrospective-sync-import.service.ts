/**
 * 振り返り 上書きインポート (Sync by ID) サービス (T-22 Phase 22b)。
 *
 * 役割:
 *   既存の振り返りを「export → Excel 編集 → re-import」の往復編集サイクルで管理する。
 *   Phase 22a (risks) で確立した flat sync-import パターンの機械流用。
 *
 * CSV 列構成 (13 列、編集 dialog 完全網羅):
 *   ID / conductedDate / planSummary / actualSummary / goodPoints / problems /
 *   estimateGapFactors / scheduleGapFactors / qualityIssues /
 *   riskResponseEvaluation / improvements / knowledgeToShare / visibility
 *
 * ID 突合 + conductedDate (実施日) の重複検知 + visibility validation。
 *
 * 認可: PM/TL + admin (呼出側 API ルートで retrospective:update + retrospective:delete を確認済の前提)
 */

import { prisma } from '@/lib/db';
import { parseCsvLine } from './task.service';

// ============================================================
// 型定義
// ============================================================

export type RetrospectiveSyncImportRow = {
  tempRowIndex: number;
  id: string | null;
  conductedDate: string; // YYYY-MM-DD (必須)
  planSummary: string;
  actualSummary: string;
  goodPoints: string;
  problems: string;
  estimateGapFactors: string | null;
  scheduleGapFactors: string | null;
  qualityIssues: string | null;
  riskResponseEvaluation: string | null;
  improvements: string;
  knowledgeToShare: string | null;
  visibility: 'draft' | 'public';
};

export type SyncDiffAction = 'CREATE' | 'UPDATE' | 'NO_CHANGE' | 'REMOVE_CANDIDATE';
export type SyncDiffWarningLevel = 'INFO' | 'WARN' | 'ERROR';
export type SyncDiffFieldChange = { field: string; before: unknown; after: unknown };

export type RetrospectiveSyncDiffRow = {
  csvRow: number | null;
  id: string | null;
  action: SyncDiffAction;
  name: string; // 識別表示用 (= conductedDate)
  fieldChanges?: SyncDiffFieldChange[];
  warnings?: string[];
  errors?: string[];
  /** REMOVE_CANDIDATE で state != 'draft' なら true */
  hasProgress?: boolean;
  warningLevel?: SyncDiffWarningLevel;
};

export type RetrospectiveSyncDiffResult = {
  summary: { added: number; updated: number; removed: number; blockedErrors: number; warnings: number };
  rows: RetrospectiveSyncDiffRow[];
  canExecute: boolean;
  globalErrors: string[];
};

export type RemoveMode = 'keep' | 'warn' | 'delete';

// ============================================================
// CSV ヘッダー (13 列)
// ============================================================

export const RETRO_CSV_HEADERS = [
  'ID', '実施日', '計画総括', '実績総括', '良かった点', '課題',
  '見積差異要因', 'スケジュール差異要因', '品質課題', 'リスク対応評価',
  '改善事項', '共有ナレッジ', '公開範囲',
] as const;

const VALID_VISIBILITIES = new Set(['draft', 'public']);
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// ============================================================
// CSV パース
// ============================================================

export function parseRetrospectiveSyncImportCsv(csvText: string): RetrospectiveSyncImportRow[] {
  const cleanText = csvText.replace(/^﻿/, '');
  const lines = cleanText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const dataLines = lines.slice(1);
  const rows: RetrospectiveSyncImportRow[] = [];

  for (let i = 0; i < dataLines.length; i++) {
    const fields = parseCsvLine(dataLines[i]);
    if (fields.length < 2) continue;

    const csvRowIndex = i + 2;

    const idRaw = (fields[0] ?? '').trim();
    const id = idRaw.length > 0 ? idRaw : null;

    const conductedDate = (fields[1] ?? '').trim();
    if (!conductedDate || !DATE_REGEX.test(conductedDate)) continue;

    const planSummary = (fields[2] ?? '').trim();
    const actualSummary = (fields[3] ?? '').trim();
    const goodPoints = (fields[4] ?? '').trim();
    const problems = (fields[5] ?? '').trim();
    const estimateGapFactors = (fields[6] ?? '').trim() || null;
    const scheduleGapFactors = (fields[7] ?? '').trim() || null;
    const qualityIssues = (fields[8] ?? '').trim() || null;
    const riskResponseEvaluation = (fields[9] ?? '').trim() || null;
    const improvements = (fields[10] ?? '').trim();
    const knowledgeToShare = (fields[11] ?? '').trim() || null;
    const visibilityRaw = (fields[12] ?? '').trim();
    const visibility = (VALID_VISIBILITIES.has(visibilityRaw) ? visibilityRaw : 'public') as 'draft' | 'public';

    rows.push({
      tempRowIndex: csvRowIndex,
      id, conductedDate, planSummary, actualSummary, goodPoints, problems,
      estimateGapFactors, scheduleGapFactors, qualityIssues, riskResponseEvaluation,
      improvements, knowledgeToShare, visibility,
    });
  }

  return rows;
}

// ============================================================
// computeDiff
// ============================================================

type DbRetroSnapshot = {
  id: string;
  projectId: string;
  conductedDate: Date;
  planSummary: string;
  actualSummary: string;
  goodPoints: string;
  problems: string;
  estimateGapFactors: string | null;
  scheduleGapFactors: string | null;
  qualityIssues: string | null;
  riskResponseEvaluation: string | null;
  improvements: string;
  knowledgeToShare: string | null;
  state: string;
  visibility: string;
};

function dateOnlyStr(d: Date | null): string | null {
  return d ? d.toISOString().split('T')[0] : null;
}

export async function computeRetrospectiveSyncDiff(
  projectId: string,
  csvRows: RetrospectiveSyncImportRow[],
): Promise<RetrospectiveSyncDiffResult> {
  const result: RetrospectiveSyncDiffResult = {
    summary: { added: 0, updated: 0, removed: 0, blockedErrors: 0, warnings: 0 },
    rows: [], canExecute: true, globalErrors: [],
  };

  if (csvRows.length === 0) {
    result.globalErrors.push('インポート可能な行がありません');
    result.canExecute = false;
    return result;
  }
  if (csvRows.length > 500) {
    result.globalErrors.push('1 回のインポートは 500 件までです');
    result.canExecute = false;
    return result;
  }

  const existingRetros = await prisma.retrospective.findMany({
    where: { projectId, deletedAt: null },
    select: {
      id: true, projectId: true, conductedDate: true,
      planSummary: true, actualSummary: true, goodPoints: true, problems: true,
      estimateGapFactors: true, scheduleGapFactors: true, qualityIssues: true,
      riskResponseEvaluation: true, improvements: true, knowledgeToShare: true,
      state: true, visibility: true,
    },
  });

  const existingById = new Map(existingRetros.map((r) => [r.id, r as DbRetroSnapshot]));
  const existingByDate = new Map<string, DbRetroSnapshot[]>();
  for (const r of existingRetros) {
    const key = dateOnlyStr(r.conductedDate)!;
    const arr = existingByDate.get(key) ?? [];
    arr.push(r as DbRetroSnapshot);
    existingByDate.set(key, arr);
  }

  const csvIdCounts = new Map<string, number>();
  const csvDateCounts = new Map<string, number>();
  for (const r of csvRows) {
    if (r.id) csvIdCounts.set(r.id, (csvIdCounts.get(r.id) ?? 0) + 1);
    csvDateCounts.set(r.conductedDate, (csvDateCounts.get(r.conductedDate) ?? 0) + 1);
  }
  const duplicateIds = new Set([...csvIdCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id));
  const duplicateDates = new Set([...csvDateCounts.entries()].filter(([, c]) => c > 1).map(([d]) => d));

  const csvKeptIds = new Set<string>();

  for (const row of csvRows) {
    const errors: string[] = [];
    const fieldChanges: SyncDiffFieldChange[] = [];

    if (row.id && duplicateIds.has(row.id)) {
      errors.push(`CSV 内で ID "${row.id}" が重複しています`);
    }
    if (duplicateDates.has(row.conductedDate)) {
      errors.push(`CSV 内で実施日 "${row.conductedDate}" が重複しています`);
    }

    let action: SyncDiffAction = 'CREATE';
    let dbRetro: DbRetroSnapshot | undefined;

    if (row.id) {
      dbRetro = existingById.get(row.id);
      if (!dbRetro) {
        errors.push(`ID "${row.id}" が DB に存在しません`);
      } else if (dbRetro.projectId !== projectId) {
        errors.push(`ID "${row.id}" は別プロジェクトの振り返りです`);
      } else {
        action = 'UPDATE';
        csvKeptIds.add(dbRetro.id);
      }
    } else {
      const sameDate = existingByDate.get(row.conductedDate);
      if (sameDate && sameDate.length > 0) {
        errors.push(
          `ID 空欄ですが同じ実施日 "${row.conductedDate}" の振り返りが既存にあります (新規作成すると重複)。意図的なら ID 列に既存 ID を貼り付けるか、CSV 上で実施日を変えてください`,
        );
      }
    }

    if (action === 'UPDATE' && dbRetro) {
      compareField(fieldChanges, 'conductedDate', dateOnlyStr(dbRetro.conductedDate), row.conductedDate);
      compareField(fieldChanges, 'planSummary', dbRetro.planSummary, row.planSummary);
      compareField(fieldChanges, 'actualSummary', dbRetro.actualSummary, row.actualSummary);
      compareField(fieldChanges, 'goodPoints', dbRetro.goodPoints, row.goodPoints);
      compareField(fieldChanges, 'problems', dbRetro.problems, row.problems);
      compareField(fieldChanges, 'estimateGapFactors', dbRetro.estimateGapFactors, row.estimateGapFactors);
      compareField(fieldChanges, 'scheduleGapFactors', dbRetro.scheduleGapFactors, row.scheduleGapFactors);
      compareField(fieldChanges, 'qualityIssues', dbRetro.qualityIssues, row.qualityIssues);
      compareField(fieldChanges, 'riskResponseEvaluation', dbRetro.riskResponseEvaluation, row.riskResponseEvaluation);
      compareField(fieldChanges, 'improvements', dbRetro.improvements, row.improvements);
      compareField(fieldChanges, 'knowledgeToShare', dbRetro.knowledgeToShare, row.knowledgeToShare);
      compareField(fieldChanges, 'visibility', dbRetro.visibility, row.visibility);
    }

    if (action === 'UPDATE' && fieldChanges.length === 0) action = 'NO_CHANGE';

    const errorCount = errors.length;
    result.rows.push({
      csvRow: row.tempRowIndex,
      id: dbRetro?.id ?? null,
      action,
      name: row.conductedDate,
      fieldChanges: fieldChanges.length > 0 ? fieldChanges : undefined,
      errors: errors.length > 0 ? errors : undefined,
      warningLevel: errorCount > 0 ? 'ERROR' : 'INFO',
    });

    if (action === 'CREATE' && errorCount === 0) result.summary.added++;
    if (action === 'UPDATE' && errorCount === 0) result.summary.updated++;
    result.summary.blockedErrors += errorCount;
  }

  for (const r of existingRetros) {
    if (!csvKeptIds.has(r.id)) {
      const hasProgress = r.state !== 'draft';
      result.rows.push({
        csvRow: null,
        id: r.id,
        action: 'REMOVE_CANDIDATE',
        name: dateOnlyStr(r.conductedDate)!,
        hasProgress,
        warningLevel: hasProgress ? 'ERROR' : 'WARN',
        warnings: hasProgress
          ? undefined
          : ['CSV にこの振り返りが含まれていません (削除モード次第で削除候補)'],
        errors: hasProgress
          ? ['CSV にこの振り返りが含まれていません。state が draft 以外 (進捗あり、削除モード=delete のとき blocker)']
          : undefined,
      });
      result.summary.removed++;
    }
  }

  if (result.summary.blockedErrors > 0) result.canExecute = false;
  return result;
}

function compareField(list: SyncDiffFieldChange[], field: string, before: unknown, after: unknown): void {
  if (!shallowEqual(before, after)) list.push({ field, before, after });
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

// ============================================================
// applySyncImport
// ============================================================

export type RetrospectiveSyncImportResult = {
  added: number;
  updated: number;
  removed: number;
};

export async function applyRetrospectiveSyncImport(
  projectId: string,
  csvRows: RetrospectiveSyncImportRow[],
  removeMode: RemoveMode,
  userId: string,
): Promise<RetrospectiveSyncImportResult> {
  const diff = await computeRetrospectiveSyncDiff(projectId, csvRows);
  if (!diff.canExecute) {
    const msgs = [
      ...diff.globalErrors,
      ...diff.rows.flatMap((r) => (r.errors ?? []).map((e) => `行 ${r.csvRow ?? '-'}: ${e}`)),
    ];
    throw new Error(`IMPORT_VALIDATION_ERROR:${msgs.join('; ')}`);
  }

  if (removeMode === 'delete') {
    const blocked = diff.rows.filter((r) => r.action === 'REMOVE_CANDIDATE' && r.hasProgress);
    if (blocked.length > 0) {
      throw new Error(
        `IMPORT_REMOVE_BLOCKED:state が draft 以外の振り返りは削除モード=delete では消せません: ${blocked.map((r) => `"${r.name}"`).join(', ')}`,
      );
    }
  }

  const snapshot = await prisma.retrospective.findMany({ where: { projectId, deletedAt: null } });
  const snapshotById = new Map(snapshot.map((r) => [r.id, r]));

  const createdIds: string[] = [];
  const updatedIds: string[] = [];
  const softDeletedIds: string[] = [];

  try {
    for (const row of csvRows) {
      const data = {
        projectId,
        conductedDate: new Date(row.conductedDate),
        planSummary: row.planSummary,
        actualSummary: row.actualSummary,
        goodPoints: row.goodPoints,
        problems: row.problems,
        estimateGapFactors: row.estimateGapFactors,
        scheduleGapFactors: row.scheduleGapFactors,
        qualityIssues: row.qualityIssues,
        riskResponseEvaluation: row.riskResponseEvaluation,
        improvements: row.improvements,
        knowledgeToShare: row.knowledgeToShare,
        visibility: row.visibility,
        updatedBy: userId,
      };

      if (row.id) {
        await prisma.retrospective.update({ where: { id: row.id }, data });
        updatedIds.push(row.id);
      } else {
        const created = await prisma.retrospective.create({
          data: { ...data, createdBy: userId },
        });
        createdIds.push(created.id);
      }
    }

    if (removeMode === 'delete') {
      for (const r of diff.rows) {
        if (r.action === 'REMOVE_CANDIDATE' && r.id && !r.hasProgress) {
          await prisma.retrospective.update({
            where: { id: r.id },
            data: { deletedAt: new Date(), updatedBy: userId },
          });
          softDeletedIds.push(r.id);
        }
      }
    }

    return { added: createdIds.length, updated: updatedIds.length, removed: softDeletedIds.length };
  } catch (e) {
    await rollbackToSnapshot(snapshot, snapshotById, createdIds, updatedIds, softDeletedIds, userId);
    throw e;
  }
}

async function rollbackToSnapshot(
  snapshot: Awaited<ReturnType<typeof prisma.retrospective.findMany>>,
  snapshotById: Map<string, (typeof snapshot)[number]>,
  createdIds: string[],
  updatedIds: string[],
  softDeletedIds: string[],
  userId: string,
): Promise<void> {
  if (createdIds.length > 0) {
    await prisma.retrospective.deleteMany({ where: { id: { in: createdIds } } });
  }
  for (const id of updatedIds) {
    const orig = snapshotById.get(id);
    if (!orig) continue;
    await prisma.retrospective.update({
      where: { id },
      data: {
        conductedDate: orig.conductedDate,
        planSummary: orig.planSummary,
        actualSummary: orig.actualSummary,
        goodPoints: orig.goodPoints,
        problems: orig.problems,
        estimateGapFactors: orig.estimateGapFactors,
        scheduleGapFactors: orig.scheduleGapFactors,
        qualityIssues: orig.qualityIssues,
        riskResponseEvaluation: orig.riskResponseEvaluation,
        improvements: orig.improvements,
        knowledgeToShare: orig.knowledgeToShare,
        state: orig.state,
        visibility: orig.visibility,
        updatedBy: userId,
      },
    });
  }
  if (softDeletedIds.length > 0) {
    await prisma.retrospective.updateMany({
      where: { id: { in: softDeletedIds } },
      data: { deletedAt: null, updatedBy: userId },
    });
  }
}

// ============================================================
// Sync 形式の CSV エクスポート
// ============================================================

function escapeCsv(v: string | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function exportRetrospectivesSync(
  projectId: string,
  viewerSystemRole: string,
): Promise<string> {
  const isAdmin = viewerSystemRole === 'admin';
  const visibilityWhere = isAdmin ? {} : { visibility: 'public' };

  const retros = await prisma.retrospective.findMany({
    where: { projectId, deletedAt: null, ...visibilityWhere },
    orderBy: { conductedDate: 'desc' },
  });

  const lines = [RETRO_CSV_HEADERS.join(',')];
  for (const r of retros) {
    const line = [
      r.id,
      r.conductedDate.toISOString().split('T')[0],
      escapeCsv(r.planSummary),
      escapeCsv(r.actualSummary),
      escapeCsv(r.goodPoints),
      escapeCsv(r.problems),
      escapeCsv(r.estimateGapFactors),
      escapeCsv(r.scheduleGapFactors),
      escapeCsv(r.qualityIssues),
      escapeCsv(r.riskResponseEvaluation),
      escapeCsv(r.improvements),
      escapeCsv(r.knowledgeToShare),
      r.visibility,
    ].join(',');
    lines.push(line);
  }
  return '﻿' + lines.join('\n');
}
