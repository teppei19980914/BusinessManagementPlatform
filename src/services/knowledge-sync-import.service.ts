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
import { parseCsvLine } from './task.service';

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

export const KNOWLEDGE_CSV_HEADERS = [
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
  const cleanText = csvText.replace(/^﻿/, '');
  const lines = cleanText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const dataLines = lines.slice(1);
  const rows: KnowledgeSyncImportRow[] = [];

  for (let i = 0; i < dataLines.length; i++) {
    const fields = parseCsvLine(dataLines[i]);
    if (fields.length < 3) continue;

    const csvRowIndex = i + 2;

    const idRaw = (fields[0] ?? '').trim();
    const id = idRaw.length > 0 ? idRaw : null;

    const title = (fields[1] ?? '').trim();
    if (!title) continue;

    const ktRaw = (fields[2] ?? '').trim();
    const knowledgeType = (VALID_KNOWLEDGE_TYPES.has(ktRaw) ? ktRaw : 'other') as KnowledgeSyncImportRow['knowledgeType'];

    const background = (fields[3] ?? '').trim();
    const content = (fields[4] ?? '').trim();
    const result = (fields[5] ?? '').trim();
    const conclusion = (fields[6] ?? '').trim() || null;
    const recommendation = (fields[7] ?? '').trim() || null;
    const reusabilityRaw = (fields[8] ?? '').trim();
    const reusability = VALID_REUSABILITIES.has(reusabilityRaw) ? (reusabilityRaw as 'low' | 'medium' | 'high') : null;
    const devMethodRaw = (fields[9] ?? '').trim();
    const devMethod = VALID_DEV_METHODS.has(devMethodRaw) ? (devMethodRaw as KnowledgeSyncImportRow['devMethod']) : null;
    const techTags = parseTags(fields[10]);
    const processTags = parseTags(fields[11]);
    const businessDomainTags = parseTags(fields[12]);
    const visibilityRaw = (fields[13] ?? '').trim();
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
): Promise<KnowledgeSyncDiffResult> {
  const result: KnowledgeSyncDiffResult = {
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

  // 当該プロジェクトに紐付いた knowledge のみを対象
  const existingKnowledges = await prisma.knowledge.findMany({
    where: {
      deletedAt: null,
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
    const fieldChanges: SyncDiffFieldChange[] = [];

    if (row.id && duplicateIds.has(row.id)) {
      errors.push(`CSV 内で ID "${row.id}" が重複しています`);
    }
    if (duplicateTitles.has(row.title)) {
      errors.push(`CSV 内でタイトル "${row.title}" が重複しています`);
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
      const sameTitle = existingByTitle.get(row.title);
      if (sameTitle && sameTitle.length > 0) {
        errors.push(
          `ID 空欄ですが同じタイトル "${row.title}" のナレッジが既存にあります (新規作成すると重複)。意図的なら ID 列に既存 ID を貼り付けるか、CSV 上でタイトルを変えてください`,
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
    result.rows.push({
      csvRow: row.tempRowIndex,
      id: dbK?.id ?? null,
      action,
      name: row.title,
      fieldChanges: fieldChanges.length > 0 ? fieldChanges : undefined,
      errors: errors.length > 0 ? errors : undefined,
      warningLevel: errorCount > 0 ? 'ERROR' : 'INFO',
    });

    if (action === 'CREATE' && errorCount === 0) result.summary.added++;
    if (action === 'UPDATE' && errorCount === 0) result.summary.updated++;
    result.summary.blockedErrors += errorCount;
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

export type KnowledgeSyncImportResult = { added: number; updated: number; removed: number };

export async function applyKnowledgeSyncImport(
  projectId: string,
  csvRows: KnowledgeSyncImportRow[],
  removeMode: RemoveMode,
  userId: string,
): Promise<KnowledgeSyncImportResult> {
  const diff = await computeKnowledgeSyncDiff(projectId, csvRows);
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
    where: { deletedAt: null, knowledgeProjects: { some: { projectId } } },
  });
  const snapshotById = new Map(snapshot.map((k) => [k.id, k]));

  const createdIds: string[] = [];
  const updatedIds: string[] = [];
  const softDeletedIds: string[] = [];

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
        await prisma.knowledge.update({ where: { id: row.id }, data });
        updatedIds.push(row.id);
      } else {
        const created = await prisma.knowledge.create({
          data: {
            ...data,
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
          await prisma.knowledge.update({
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
  snapshot: Awaited<ReturnType<typeof prisma.knowledge.findMany>>,
  snapshotById: Map<string, (typeof snapshot)[number]>,
  createdIds: string[],
  updatedIds: string[],
  softDeletedIds: string[],
  userId: string,
): Promise<void> {
  if (createdIds.length > 0) {
    // 作成された knowledge_projects junction も cascade で消える想定
    await prisma.knowledge.deleteMany({ where: { id: { in: createdIds } } });
  }
  for (const id of updatedIds) {
    const orig = snapshotById.get(id);
    if (!orig) continue;
    await prisma.knowledge.update({
      where: { id },
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

export async function exportKnowledgeSync(projectId: string): Promise<string> {
  const knowledges = await prisma.knowledge.findMany({
    where: { deletedAt: null, knowledgeProjects: { some: { projectId } } },
    orderBy: { createdAt: 'desc' },
  });

  const lines = [KNOWLEDGE_CSV_HEADERS.join(',')];
  for (const k of knowledges) {
    const line = [
      k.id,
      escapeCsv(k.title),
      k.knowledgeType,
      escapeCsv(k.background),
      escapeCsv(k.content),
      escapeCsv(k.result),
      escapeCsv(k.conclusion),
      escapeCsv(k.recommendation),
      k.reusability ?? '',
      k.devMethod ?? '',
      escapeCsv((k.techTags as string[]).join(';')),
      escapeCsv((k.processTags as string[]).join(';')),
      escapeCsv((k.businessDomainTags as string[]).join(';')),
      k.visibility,
    ].join(',');
    lines.push(line);
  }
  return '﻿' + lines.join('\n');
}
