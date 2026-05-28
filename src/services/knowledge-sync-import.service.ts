/**
 * ナレッジ 上書きインポート (Sync by ID) サービス (T-22 Phase 22c)。
 *
 * 役割:
 *   project-bound ナレッジを「export → Excel 編集 → re-import」で管理する。
 *   Phase 22a パターンの機械流用。
 *
 * CSV 列構成 (14 列、編集 dialog 主要項目を網羅):
 *   ID / title / knowledgeType / background / content / result /
 *   conclusion / recommendation / reusability / devMethod /
 *   techTags / processTags / businessDomainTags / visibility
 *
 *   tags 系 3 列はセミコロン区切り (例: "react;next.js;typescript")。
 *   projectIds (multi-binding) は CSV では URL projectId 単一に絞る (sync 対象外)。
 *
 * 認可: knowledge:create + knowledge:update (= PM/TL + admin)
 */

import { prisma } from '@/lib/db';
import { parseCsvText } from './task.service';

// ============================================================
// 型定義
// ============================================================

export type KnowledgeSyncImportRow = {
  tempRowIndex: number;
  id: string | null;
  title: string;
  knowledgeType: 'research' | 'verification' | 'incident' | 'decision' | 'lesson' | 'best_practice' | 'other';
  background: string;
  content: string;
  result: string;
  conclusion: string | null;
  recommendation: string | null;
  reusability: 'low' | 'medium' | 'high' | null;
  devMethod: 'scratch' | 'low_code_no_code' | 'package' | 'other' | null;
  techTags: string[];
  processTags: string[];
  businessDomainTags: string[];
  visibility: 'draft' | 'public';
};

export type SyncDiffAction = 'CREATE' | 'UPDATE' | 'NO_CHANGE' | 'REMOVE_CANDIDATE';
export type SyncDiffWarningLevel = 'INFO' | 'WARN' | 'ERROR';
export type SyncDiffFieldChange = { field: string; before: unknown; after: unknown };

export type KnowledgeSyncDiffRow = {
  csvRow: number | null;
  id: string | null;
  action: SyncDiffAction;
  name: string; // = title
  fieldChanges?: SyncDiffFieldChange[];
  warnings?: string[];
  errors?: string[];
  /** REMOVE_CANDIDATE で visibility=public のとき true */
  hasProgress?: boolean;
  warningLevel?: SyncDiffWarningLevel;
};

export type KnowledgeSyncDiffResult = {
  summary: { added: number; updated: number; removed: number; blockedErrors: number; warnings: number };
  rows: KnowledgeSyncDiffRow[];
  canExecute: boolean;
  globalErrors: string[];
};

export type RemoveMode = 'keep' | 'warn' | 'delete';

// ============================================================
// CSV ヘッダー (14 列)
// ============================================================

/** Knowledge CSV ヘッダー (7 列、編集 dialog 表示項目に整合)。
 *  fix/list-export-import-bugs (2026-05-26): UI から削除済の 7 列 (結論/推奨/再利用性/開発方式/
 *  3 種タグ) を CSV からも削除し、編集 dialog と 1:1 対応に統一。DB スキーマは温存。
 *  旧 14 列 CSV も後方互換で parse 可能 (parseKnowledgeSyncImportCsv で列数判定)。 */
export const KNOWLEDGE_CSV_HEADERS = [
  'ID', 'タイトル', 'ナレッジ種別', '背景', '内容', '結果', '公開範囲',
] as const;

/** 旧 14 列 CSV ヘッダー (互換読込用、新規 export は使わない)。 */
export const KNOWLEDGE_CSV_HEADERS_LEGACY_14 = [
  'ID', 'タイトル', 'ナレッジ種別', '背景', '内容', '結果',
  '結論', '推奨', '再利用性', '開発方式',
  '技術タグ (;区切り)', 'プロセスタグ (;区切り)', '業界ドメインタグ (;区切り)', '公開範囲',
] as const;

const VALID_KNOWLEDGE_TYPES = new Set(['research', 'verification', 'incident', 'decision', 'lesson', 'best_practice', 'other']);
const VALID_REUSABILITIES = new Set(['low', 'medium', 'high']);
const VALID_DEV_METHODS = new Set(['scratch', 'low_code_no_code', 'package', 'other']);
const VALID_VISIBILITIES = new Set(['draft', 'public']);

function parseTags(s: string | undefined | null): string[] {
  if (!s) return [];
  return s.split(';').map((t) => t.trim()).filter((t) => t.length > 0);
}

function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// ============================================================
// CSV パース
// ============================================================

export function parseKnowledgeSyncImportCsv(csvText: string): KnowledgeSyncImportRow[] {
  // fix/csv-import-multiline-text-data-loss: 旧実装は `split(/\r?\n/)` + 行ごとの
  //   parseCsvLine だったため、`"line1\nline2"` のような quoted multi-line cell が分断され、
  //   背景/内容/結果 (textarea 入力可) の 2 行目以降が silent に欠落していた。
  //   RFC 4180 準拠の parseCsvText で全文を一括パースする。
  const records = parseCsvText(csvText);
  if (records.length < 2) return [];

  // fix/list-export-import-bugs (2026-05-26): header 行で列数を判定し新旧 layout を切替。
  //   - 7 列 (新): ID/タイトル/種別/背景/内容/結果/公開範囲
  //   - 14 列 (旧): + 結論/推奨/再利用性/開発方式/3 種タグ
  //   旧 layout は parser 経路では値を読み取るが、UI から削除済の項目のため新規 export では出ない。
  const headerFields = records[0];
  const isLegacyLayout = headerFields.length >= 14;
  const COL = isLegacyLayout
    ? {
        id: 0, title: 1, knowledgeType: 2, background: 3, content: 4, result: 5,
        conclusion: 6, recommendation: 7, reusability: 8, devMethod: 9,
        techTags: 10, processTags: 11, businessDomainTags: 12, visibility: 13,
      }
    : {
        id: 0, title: 1, knowledgeType: 2, background: 3, content: 4, result: 5,
        conclusion: -1, recommendation: -1, reusability: -1, devMethod: -1,
        techTags: -1, processTags: -1, businessDomainTags: -1, visibility: 6,
      };

  const dataRecords = records.slice(1);
  const rows: KnowledgeSyncImportRow[] = [];

  for (let i = 0; i < dataRecords.length; i++) {
    const fields = dataRecords[i];
    if (fields.length < 3) continue;

    const csvRowIndex = i + 2;

    const idRaw = (fields[COL.id] ?? '').trim();
    const id = idRaw.length > 0 ? idRaw : null;

    const title = (fields[COL.title] ?? '').trim();
    if (!title) continue;

    const ktRaw = (fields[COL.knowledgeType] ?? '').trim();
    const knowledgeType = (VALID_KNOWLEDGE_TYPES.has(ktRaw) ? ktRaw : 'other') as KnowledgeSyncImportRow['knowledgeType'];

    const background = (fields[COL.background] ?? '').trim();
    const content = (fields[COL.content] ?? '').trim();
    const result = (fields[COL.result] ?? '').trim();
    const conclusion = COL.conclusion >= 0 ? ((fields[COL.conclusion] ?? '').trim() || null) : null;
    const recommendation = COL.recommendation >= 0 ? ((fields[COL.recommendation] ?? '').trim() || null) : null;
    const reusabilityRaw = COL.reusability >= 0 ? (fields[COL.reusability] ?? '').trim() : '';
    const reusability = VALID_REUSABILITIES.has(reusabilityRaw) ? (reusabilityRaw as 'low' | 'medium' | 'high') : null;
    const devMethodRaw = COL.devMethod >= 0 ? (fields[COL.devMethod] ?? '').trim() : '';
    const devMethod = VALID_DEV_METHODS.has(devMethodRaw) ? (devMethodRaw as KnowledgeSyncImportRow['devMethod']) : null;
    const techTags = COL.techTags >= 0 ? parseTags(fields[COL.techTags]) : [];
    const processTags = COL.processTags >= 0 ? parseTags(fields[COL.processTags]) : [];
    const businessDomainTags = COL.businessDomainTags >= 0 ? parseTags(fields[COL.businessDomainTags]) : [];
    const visibilityRaw = (fields[COL.visibility] ?? '').trim();
    const visibility = (VALID_VISIBILITIES.has(visibilityRaw) ? visibilityRaw : 'public') as 'draft' | 'public';

    rows.push({
      tempRowIndex: csvRowIndex,
      id, title, knowledgeType, background, content, result,
      conclusion, recommendation, reusability, devMethod,
      techTags, processTags, businessDomainTags, visibility,
    });
  }

  return rows;
}

// ============================================================
// computeDiff
// ============================================================

type DbKnowledgeSnapshot = {
  id: string;
  title: string;
  knowledgeType: string;
  background: string;
  content: string;
  result: string;
  conclusion: string | null;
  recommendation: string | null;
  reusability: string | null;
  devMethod: string | null;
  techTags: string[];
  processTags: string[];
  businessDomainTags: string[];
  visibility: string;
  createdBy: string;
};

export async function computeKnowledgeSyncDiff(
  projectId: string,
  csvRows: KnowledgeSyncImportRow[],
  viewerTenantId: string,
): Promise<KnowledgeSyncDiffResult> {
  const result: KnowledgeSyncDiffResult = {
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

  // 当該プロジェクトに紐付いた knowledge のみを対象 + tenantId 二重防御
  const existingKnowledges = await prisma.knowledge.findMany({
    where: {
      deletedAt: null,
      tenantId: viewerTenantId,
      knowledgeProjects: { some: { projectId } },
    },
    select: {
      id: true, title: true, knowledgeType: true, background: true, content: true, result: true,
      conclusion: true, recommendation: true, reusability: true, devMethod: true,
      techTags: true, processTags: true, businessDomainTags: true, visibility: true,
      createdBy: true,
    },
  });

  const existingById = new Map(existingKnowledges.map((k) => [k.id, k as DbKnowledgeSnapshot]));
  const existingByTitle = new Map<string, DbKnowledgeSnapshot[]>();
  for (const k of existingKnowledges) {
    const arr = existingByTitle.get(k.title) ?? [];
    arr.push(k as DbKnowledgeSnapshot);
    existingByTitle.set(k.title, arr);
  }

  const csvIdCounts = new Map<string, number>();
  const csvTitleCounts = new Map<string, number>();
  for (const r of csvRows) {
    if (r.id) csvIdCounts.set(r.id, (csvIdCounts.get(r.id) ?? 0) + 1);
    csvTitleCounts.set(r.title, (csvTitleCounts.get(r.title) ?? 0) + 1);
  }
  const duplicateIds = new Set([...csvIdCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id));
  const duplicateTitles = new Set([...csvTitleCounts.entries()].filter(([, c]) => c > 1).map(([t]) => t));

  const csvKeptIds = new Set<string>();

  for (const row of csvRows) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const fieldChanges: SyncDiffFieldChange[] = [];

    if (row.id && duplicateIds.has(row.id)) {
      errors.push(`CSV 内で ID "${row.id}" が重複しています`);
    }
    // fix/list-export-import-bugs (2026-05-26): title 重複は ID が一意なら別エンティティとして
    //   許容できるため、error → warning にダウングレード (canExecute をブロックしない)。
    if (duplicateTitles.has(row.title)) {
      warnings.push(`CSV 内でタイトル "${row.title}" が重複しています (ID が異なれば別エンティティとして取り込まれます)`);
    }

    let action: SyncDiffAction = 'CREATE';
    let dbK: DbKnowledgeSnapshot | undefined;

    if (row.id) {
      dbK = existingById.get(row.id);
      if (!dbK) {
        errors.push(`ID "${row.id}" が DB に存在しないか、本プロジェクトに紐付いていません`);
      } else {
        action = 'UPDATE';
        csvKeptIds.add(dbK.id);
      }
    } else {
      // fix/list-export-import-bugs (2026-05-26): DB に同タイトル存在は warning にダウングレード。
      //   新規 ID で採番されれば重複 title でも問題なし。
      const sameTitle = existingByTitle.get(row.title);
      if (sameTitle && sameTitle.length > 0) {
        warnings.push(
          `タイトル "${row.title}" のナレッジが既存にあります。ID 空欄のため新規 ID で作成されます (同タイトルの別エンティティが追加で作成されます)`,
        );
      }
    }

    if (action === 'UPDATE' && dbK) {
      compareField(fieldChanges, 'title', dbK.title, row.title);
      compareField(fieldChanges, 'knowledgeType', dbK.knowledgeType, row.knowledgeType);
      compareField(fieldChanges, 'background', dbK.background, row.background);
      compareField(fieldChanges, 'content', dbK.content, row.content);
      compareField(fieldChanges, 'result', dbK.result, row.result);
      compareField(fieldChanges, 'conclusion', dbK.conclusion, row.conclusion);
      compareField(fieldChanges, 'recommendation', dbK.recommendation, row.recommendation);
      compareField(fieldChanges, 'reusability', dbK.reusability, row.reusability);
      compareField(fieldChanges, 'devMethod', dbK.devMethod, row.devMethod);
      if (!tagsEqual(dbK.techTags, row.techTags)) {
        fieldChanges.push({ field: 'techTags', before: dbK.techTags.join(';'), after: row.techTags.join(';') });
      }
      if (!tagsEqual(dbK.processTags, row.processTags)) {
        fieldChanges.push({ field: 'processTags', before: dbK.processTags.join(';'), after: row.processTags.join(';') });
      }
      if (!tagsEqual(dbK.businessDomainTags, row.businessDomainTags)) {
        fieldChanges.push({ field: 'businessDomainTags', before: dbK.businessDomainTags.join(';'), after: row.businessDomainTags.join(';') });
      }
      compareField(fieldChanges, 'visibility', dbK.visibility, row.visibility);
    }

    if (action === 'UPDATE' && fieldChanges.length === 0) action = 'NO_CHANGE';

    const errorCount = errors.length;
    const warnCount = warnings.length;
    result.rows.push({
      csvRow: row.tempRowIndex,
      id: dbK?.id ?? null,
      action,
      name: row.title,
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

  for (const k of existingKnowledges) {
    if (!csvKeptIds.has(k.id)) {
      // 進捗あり = visibility=public (公開済は他者参照あり、削除リスク高)
      const hasProgress = k.visibility === 'public';
      result.rows.push({
        csvRow: null,
        id: k.id,
        action: 'REMOVE_CANDIDATE',
        name: k.title,
        hasProgress,
        warningLevel: hasProgress ? 'ERROR' : 'WARN',
        warnings: hasProgress
          ? undefined
          : ['CSV にこのナレッジが含まれていません (削除モード次第で削除候補)'],
        errors: hasProgress
          ? ['CSV にこのナレッジが含まれていません。visibility=public のため削除モード=delete でブロック']
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

export type KnowledgeSyncImportResult = {
  added: number;
  updated: number;
  removed: number;
  /** feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S2-C1-UX): 他人作成のため silent skip された件数 */
  skippedNotOwned: number;
};

export async function applyKnowledgeSyncImport(
  projectId: string,
  csvRows: KnowledgeSyncImportRow[],
  removeMode: RemoveMode,
  userId: string,
  viewerTenantId: string,
): Promise<KnowledgeSyncImportResult> {
  const diff = await computeKnowledgeSyncDiff(projectId, csvRows, viewerTenantId);
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
        `IMPORT_REMOVE_BLOCKED:visibility=public のナレッジは削除モード=delete では消せません: ${blocked.map((r) => `"${r.name}"`).join(', ')}`,
      );
    }
  }

  const snapshot = await prisma.knowledge.findMany({
    where: { deletedAt: null, tenantId: viewerTenantId, knowledgeProjects: { some: { projectId } } },
  });
  const snapshotById = new Map(snapshot.map((k) => [k.id, k]));

  const createdIds: string[] = [];
  const updatedIds: string[] = [];
  const softDeletedIds: string[] = [];
  // feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S2-C1-UX): silent skip された件数を
  //   呼出元に返して UI で表示可能にする (旧実装は silent skip でも updated カウンタが下振れする
  //   だけで「成功 5 件」と表示されていた)。
  let skippedNotOwned = 0;

  try {
    for (const row of csvRows) {
      const data = {
        title: row.title,
        knowledgeType: row.knowledgeType,
        background: row.background,
        content: row.content,
        result: row.result,
        conclusion: row.conclusion,
        recommendation: row.recommendation,
        reusability: row.reusability,
        devMethod: row.devMethod,
        techTags: row.techTags,
        processTags: row.processTags,
        businessDomainTags: row.businessDomainTags,
        visibility: row.visibility,
        updatedBy: userId,
      };

      if (row.id) {
        // 2026-05-10 Phase 2-8: 二重防御 - 自テナント所有確認後に update
        // feat/crud-permission-redesign (2026-05-20): 作成者本人のみ update 可。
        //   旧実装は同テナント所有のみで他人作成も上書きできた (PM/TL の bulk 編集経路の認可ホール)。
        //   project 経路 PATCH と整合させるため createdBy 一致を必須化、不一致は silent skip。
        const owned = await prisma.knowledge.findFirst({
          where: { id: row.id, tenantId: viewerTenantId },
          select: { id: true, createdBy: true },
        });
        if (!owned) throw new Error(`IMPORT_VALIDATION_ERROR:ID "${row.id}" が見つかりません`);
        if (owned.createdBy !== userId) {
          // 他人作成は silent skip (bulk update と同じパターン)
          skippedNotOwned += 1;
          continue;
        }
        await prisma.knowledge.update({ where: { id: row.id }, data });
        updatedIds.push(row.id);
      } else {
        const created = await prisma.knowledge.create({
          data: {
            ...data,
            tenantId: viewerTenantId,
            createdBy: userId,
            knowledgeProjects: { create: { projectId } },
          },
        });
        createdIds.push(created.id);
      }
    }

    if (removeMode === 'delete') {
      for (const r of diff.rows) {
        if (r.action === 'REMOVE_CANDIDATE' && r.id && !r.hasProgress) {
          // 2026-05-10 Phase 2-8: 二重防御 - tenantId フィルタ付きで update
          // feat/crud-permission-redesign (2026-05-20): 作成者本人のみ soft-delete 可。
          //   project 経路 DELETE (context='project') と整合させ、他人作成は silent skip。
          const updated = await prisma.knowledge.updateMany({
            where: { id: r.id, tenantId: viewerTenantId, createdBy: userId },
            data: { deletedAt: new Date(), updatedBy: userId },
          });
          if (updated.count === 1) {
            softDeletedIds.push(r.id);
          } else {
            // 他人作成 (createdBy !== userId) は updateMany 0 件で silent skip
            skippedNotOwned += 1;
          }
        }
      }
    }

    return {
      added: createdIds.length,
      updated: updatedIds.length,
      removed: softDeletedIds.length,
      // S2-C1-UX: 他人作成行が skip された件数 (UI で「N 件は他人作成のためスキップしました」を表示)
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
  snapshot: Awaited<ReturnType<typeof prisma.knowledge.findMany>>,
  snapshotById: Map<string, (typeof snapshot)[number]>,
  createdIds: string[],
  updatedIds: string[],
  softDeletedIds: string[],
  userId: string,
  // 2026-05-12 severity-1 防御: rollback の write 経路にも tenantId 必須化。
  //   sync-import 本体は tenantId 検証済みだが、rollback 関数の引数は ID 配列だけで
  //   tenant 文脈が消えていた。万一バグで他テナントの ID が混入してもロールバック対象外にする。
  viewerTenantId: string,
): Promise<void> {
  if (createdIds.length > 0) {
    // 作成された knowledge_projects junction も cascade で消える想定
    await prisma.knowledge.deleteMany({
      where: { id: { in: createdIds }, tenantId: viewerTenantId },
    });
  }
  for (const id of updatedIds) {
    const orig = snapshotById.get(id);
    if (!orig) continue;
    // update where に tenantId 併記して越境を遮断
    await prisma.knowledge.updateMany({
      where: { id, tenantId: viewerTenantId },
      data: {
        title: orig.title,
        knowledgeType: orig.knowledgeType,
        background: orig.background,
        content: orig.content,
        result: orig.result,
        conclusion: orig.conclusion,
        recommendation: orig.recommendation,
        reusability: orig.reusability,
        devMethod: orig.devMethod,
        techTags: orig.techTags as string[],
        processTags: orig.processTags as string[],
        businessDomainTags: orig.businessDomainTags as string[],
        visibility: orig.visibility,
        updatedBy: userId,
      },
    });
  }
  if (softDeletedIds.length > 0) {
    await prisma.knowledge.updateMany({
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

export async function exportKnowledgeSync(
  projectId: string,
  viewerTenantId: string,
  viewerUserId: string,
  viewerSystemRole: string,
  /** fix/list-export-import-bugs (2026-05-26): 指定された ID のみ export。
   *  未指定/空配列ならプロジェクト全件 (従来挙動)。 */
  ids?: string[],
): Promise<string> {
  // 2026-05-10 Phase 2-8: 越境 export を遮断するため tenantId 二重防御
  // feat/crud-permission-redesign (2026-05-20): severity-1 漏洩修正。
  //   旧実装は visibility フィルタ無しで他人 draft の機微情報 (タイトル/本文/結論/推奨事項) を
  //   CSV ダウンロード可能だった。非 admin には「自分の draft + public」のみに絞る。
  //   risk/retrospective の sync export と同じ filter パターン (exportRisksSync 等を参照)。
  const isAdmin = viewerSystemRole === 'admin';
  const visibilityWhere = isAdmin
    ? {}
    : { OR: [{ visibility: 'public' }, { visibility: 'draft', createdBy: viewerUserId }] };

  const knowledges = await prisma.knowledge.findMany({
    where: {
      deletedAt: null,
      tenantId: viewerTenantId,
      knowledgeProjects: { some: { projectId } },
      ...(ids && ids.length > 0 ? { id: { in: ids } } : {}),
      ...visibilityWhere,
    },
    orderBy: { createdAt: 'desc' },
  });

  // fix/list-export-import-bugs (2026-05-26): 編集 dialog で扱う 7 列のみ出力。
  //   結論/推奨/再利用性/開発方式/3 種タグは UI 撤去済のため CSV にも含めない。
  const lines = [KNOWLEDGE_CSV_HEADERS.join(',')];
  for (const k of knowledges) {
    const line = [
      k.id,
      escapeCsv(k.title),
      k.knowledgeType,
      escapeCsv(k.background),
      escapeCsv(k.content),
      escapeCsv(k.result),
      k.visibility,
    ].join(',');
    lines.push(line);
  }
  return '﻿' + lines.join('\n');
}
