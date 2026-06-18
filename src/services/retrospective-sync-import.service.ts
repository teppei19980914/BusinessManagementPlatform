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
import { parseCsvText } from './task.service';

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

/** Retrospective CSV ヘッダー (8 列、編集 dialog 表示項目に整合)。
 *  fix/list-export-import-bugs (2026-05-26): UI から削除済の 5 列 (見積差異要因/スケジュール差異要因/
 *  品質課題/リスク対応評価/共有ナレッジ) を CSV からも削除し、編集 dialog と 1:1 対応に統一。
 *  DB スキーマは温存。旧 13 列 CSV も後方互換で parse 可能 (parser で列数判定)。 */
export const RETRO_CSV_HEADERS = [
  'ID', '実施日', '計画総括', '実績総括', '良かった点', '課題',
  '改善事項', '公開範囲',
] as const;

/** 旧 13 列 CSV ヘッダー (互換読込用、新規 export は使わない)。 */
export const RETRO_CSV_HEADERS_LEGACY_13 = [
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
  // fix/csv-import-multiline-text-data-loss: 計画総括/実績総括/良かった点/課題/改善事項/共有ナレッジ
  //   は textarea 入力で改行を含むことが多く、旧 split 方式は 2 行目以降を欠落させていた。
  //   RFC 4180 準拠の parseCsvText で全文を一括パースする。
  const records = parseCsvText(csvText);
  if (records.length < 2) return [];

  // fix/list-export-import-bugs (2026-05-26): header 行で列数を判定し新旧 layout を切替。
  //   - 8 列 (新): ID/実施日/計画総括/実績総括/良かった点/課題/改善事項/公開範囲
  //   - 13 列 (旧): + 見積差異要因/スケジュール差異要因/品質課題/リスク対応評価/共有ナレッジ
  const headerFields = records[0];
  const isLegacyLayout = headerFields.length >= 13;
  const COL = isLegacyLayout
    ? {
        id: 0, conductedDate: 1, planSummary: 2, actualSummary: 3, goodPoints: 4, problems: 5,
        estimateGapFactors: 6, scheduleGapFactors: 7, qualityIssues: 8, riskResponseEvaluation: 9,
        improvements: 10, knowledgeToShare: 11, visibility: 12,
      }
    : {
        id: 0, conductedDate: 1, planSummary: 2, actualSummary: 3, goodPoints: 4, problems: 5,
        estimateGapFactors: -1, scheduleGapFactors: -1, qualityIssues: -1, riskResponseEvaluation: -1,
        improvements: 6, knowledgeToShare: -1, visibility: 7,
      };

  const dataRecords = records.slice(1);
  const rows: RetrospectiveSyncImportRow[] = [];

  for (let i = 0; i < dataRecords.length; i++) {
    const fields = dataRecords[i];
    if (fields.length < 2) continue;

    const csvRowIndex = i + 2;

    const idRaw = (fields[COL.id] ?? '').trim();
    const id = idRaw.length > 0 ? idRaw : null;

    const conductedDate = (fields[COL.conductedDate] ?? '').trim();
    if (!conductedDate || !DATE_REGEX.test(conductedDate)) continue;

    const planSummary = (fields[COL.planSummary] ?? '').trim();
    const actualSummary = (fields[COL.actualSummary] ?? '').trim();
    const goodPoints = (fields[COL.goodPoints] ?? '').trim();
    const problems = (fields[COL.problems] ?? '').trim();
    const estimateGapFactors = COL.estimateGapFactors >= 0 ? ((fields[COL.estimateGapFactors] ?? '').trim() || null) : null;
    const scheduleGapFactors = COL.scheduleGapFactors >= 0 ? ((fields[COL.scheduleGapFactors] ?? '').trim() || null) : null;
    const qualityIssues = COL.qualityIssues >= 0 ? ((fields[COL.qualityIssues] ?? '').trim() || null) : null;
    const riskResponseEvaluation = COL.riskResponseEvaluation >= 0 ? ((fields[COL.riskResponseEvaluation] ?? '').trim() || null) : null;
    const improvements = (fields[COL.improvements] ?? '').trim();
    const knowledgeToShare = COL.knowledgeToShare >= 0 ? ((fields[COL.knowledgeToShare] ?? '').trim() || null) : null;
    const visibilityRaw = (fields[COL.visibility] ?? '').trim();
    let visibility = (VALID_VISIBILITIES.has(visibilityRaw) ? visibilityRaw : 'public') as 'draft' | 'public';
    // v1.3.0 軽量入力 (2026-06-19): 5 セクションが全て空の public は draft へ降格する (空資産の公開防止)。
    //   UI 作成/更新は全必須だが、import は過去資産を救うため「本文が全く無い public のみ降格」の緩和ルール。
    if (visibility === 'public' && !planSummary && !actualSummary && !goodPoints && !problems && !improvements) {
      visibility = 'draft';
    }

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
  viewerTenantId: string,
): Promise<RetrospectiveSyncDiffResult> {
  const result: RetrospectiveSyncDiffResult = {
    summary: { added: 0, updated: 0, removed: 0, blockedErrors: 0, warnings: 0 },
    rows: [], canExecute: true, globalErrors: [],
  };

  // 2026-05-10 feedback Phase 2-8: 越境 sync-import を遮断するため projectId のテナント検証。
  const projectOk = await prisma.project.findFirst({
    where: { id: projectId, tenantId: viewerTenantId, deletedAt: null },
    select: { id: true },
  });
  if (!projectOk) {
    result.globalErrors.push('プロジェクトが見つかりません');
    result.canExecute = false;
    return result;
  }

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

  // PR feat/asset-multi-project-linking: M:N 化により「このプロジェクトに紐付け済」を取得
  // 2026-05-10 Phase 2-8: tenantId 二重防御
  const existingRetros = await prisma.retrospective.findMany({
    where: {
      deletedAt: null,
      tenantId: viewerTenantId,
      retrospectiveProjects: { some: { projectId } },
    },
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
    const warnings: string[] = [];
    const fieldChanges: SyncDiffFieldChange[] = [];

    if (row.id && duplicateIds.has(row.id)) {
      errors.push(`CSV 内で ID "${row.id}" が重複しています`);
    }
    // fix/list-export-import-bugs (2026-05-26): 実施日重複は ID が一意なら別エンティティとして
    //   許容できるため、error → warning にダウングレード。
    if (duplicateDates.has(row.conductedDate)) {
      warnings.push(`CSV 内で実施日 "${row.conductedDate}" が重複しています (ID が異なれば別エンティティとして取り込まれます)`);
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
      // fix/list-export-import-bugs (2026-05-26): DB に同実施日存在は warning にダウングレード。
      const sameDate = existingByDate.get(row.conductedDate);
      if (sameDate && sameDate.length > 0) {
        warnings.push(
          `実施日 "${row.conductedDate}" の振り返りが既存にあります。ID 空欄のため新規 ID で作成されます (同実施日の別振り返りが追加で作成されます)`,
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
    const warnCount = warnings.length;
    result.rows.push({
      csvRow: row.tempRowIndex,
      id: dbRetro?.id ?? null,
      action,
      name: row.conductedDate,
      fieldChanges: fieldChanges.length > 0 ? fieldChanges : undefined,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      warningLevel: errorCount > 0 ? 'ERROR' : warnCount > 0 ? 'WARN' : 'INFO',
    });

    if (action === 'CREATE' && errorCount === 0) result.summary.added++;
    if (action === 'UPDATE' && errorCount === 0) result.summary.updated++;
    result.summary.blockedErrors += errorCount;
    result.summary.warnings += warnCount;
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
  /** feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S2-C1-UX): 他人作成のため silent skip された件数 */
  skippedNotOwned: number;
};

export async function applyRetrospectiveSyncImport(
  projectId: string,
  csvRows: RetrospectiveSyncImportRow[],
  removeMode: RemoveMode,
  userId: string,
  viewerTenantId: string,
): Promise<RetrospectiveSyncImportResult> {
  const diff = await computeRetrospectiveSyncDiff(projectId, csvRows, viewerTenantId);
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

  // PR feat/asset-multi-project-linking: M:N 紐付け済のスナップショット
  // 2026-05-10 Phase 2-8: tenantId 二重防御
  const snapshot = await prisma.retrospective.findMany({
    where: {
      deletedAt: null,
      tenantId: viewerTenantId,
      retrospectiveProjects: { some: { projectId } },
    },
  });
  const snapshotById = new Map(snapshot.map((r) => [r.id, r]));

  const createdIds: string[] = [];
  const updatedIds: string[] = [];
  const softDeletedIds: string[] = [];
  // feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S2-C1-UX)
  let skippedNotOwned = 0;

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
        // 2026-05-10 Phase 2-8: 二重防御 - 自テナント所有確認後に update
        // feat/crud-permission-redesign (2026-05-20): 作成者本人のみ update 可。他人作成は silent skip。
        const owned = await prisma.retrospective.findFirst({
          where: { id: row.id, tenantId: viewerTenantId },
          select: { id: true, createdBy: true },
        });
        if (!owned) throw new Error(`IMPORT_VALIDATION_ERROR:ID "${row.id}" が見つかりません`);
        if (owned.createdBy !== userId) {
          skippedNotOwned += 1;
          continue;
        }
        await prisma.retrospective.update({ where: { id: row.id }, data });
        updatedIds.push(row.id);
      } else {
        // PR feat/asset-multi-project-linking: M:N 紐付けも create で同時に作成
        const created = await prisma.retrospective.create({
          data: {
            ...data,
            tenantId: viewerTenantId,
            createdBy: userId,
            retrospectiveProjects: { create: [{ projectId }] },
          },
        });
        createdIds.push(created.id);
      }
    }

    if (removeMode === 'delete') {
      for (const r of diff.rows) {
        if (r.action === 'REMOVE_CANDIDATE' && r.id && !r.hasProgress) {
          // 2026-05-10 Phase 2-8: tenantId フィルタ付き update で二重防御
          // feat/crud-permission-redesign (2026-05-20): 作成者本人のみ soft-delete 可。
          const updated = await prisma.retrospective.updateMany({
            where: { id: r.id, tenantId: viewerTenantId, createdBy: userId },
            data: { deletedAt: new Date(), updatedBy: userId },
          });
          if (updated.count === 1) {
            softDeletedIds.push(r.id);
          } else {
            skippedNotOwned += 1;
          }
        }
      }
    }

    return {
      added: createdIds.length,
      updated: updatedIds.length,
      removed: softDeletedIds.length,
      skippedNotOwned,
    };
  } catch (e) {
    // 2026-05-12 severity-1 防御: rollback 経路にも viewerTenantId を渡す
    await rollbackToSnapshot(
      snapshot,
      snapshotById,
      createdIds,
      updatedIds,
      softDeletedIds,
      userId,
      viewerTenantId,
    );
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
  // 2026-05-12 severity-1 防御: rollback の write 経路にも tenantId 必須化
  viewerTenantId: string,
): Promise<void> {
  if (createdIds.length > 0) {
    await prisma.retrospective.deleteMany({
      where: { id: { in: createdIds }, tenantId: viewerTenantId },
    });
  }
  for (const id of updatedIds) {
    const orig = snapshotById.get(id);
    if (!orig) continue;
    await prisma.retrospective.updateMany({
      where: { id, tenantId: viewerTenantId },
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
      where: { id: { in: softDeletedIds }, tenantId: viewerTenantId },
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
  viewerTenantId: string,
  /** fix/list-export-import-bugs (2026-05-26): 指定された ID のみ export。未指定なら全件。 */
  ids?: string[],
): Promise<string> {
  const isAdmin = viewerSystemRole === 'admin';
  const visibilityWhere = isAdmin ? {} : { visibility: 'public' };

  // PR feat/asset-multi-project-linking: 「このプロジェクトに紐付け済」を export
  // 2026-05-10 Phase 2-8: tenantId 二重防御 (越境 export を遮断)
  const retros = await prisma.retrospective.findMany({
    where: {
      deletedAt: null,
      tenantId: viewerTenantId,
      ...visibilityWhere,
      retrospectiveProjects: { some: { projectId } },
      ...(ids && ids.length > 0 ? { id: { in: ids } } : {}),
    },
    orderBy: { conductedDate: 'desc' },
  });

  // fix/list-export-import-bugs (2026-05-26): 編集 dialog で扱う 8 列のみ出力。
  //   見積差異要因/スケジュール差異要因/品質課題/リスク対応評価/共有ナレッジは UI 撤去済のため CSV にも含めない。
  const lines = [RETRO_CSV_HEADERS.join(',')];
  for (const r of retros) {
    const line = [
      r.id,
      r.conductedDate.toISOString().split('T')[0],
      escapeCsv(r.planSummary),
      escapeCsv(r.actualSummary),
      escapeCsv(r.goodPoints),
      escapeCsv(r.problems),
      escapeCsv(r.improvements),
      r.visibility,
    ].join(',');
    lines.push(line);
  }
  return '﻿' + lines.join('\n');
}
