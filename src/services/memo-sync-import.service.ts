/**
 * メモ 上書きインポート (Sync by ID) サービス (T-22 Phase 22d)。
 *
 * 役割:
 *   ユーザ自身のメモを「export → Excel 編集 → re-import」で管理する。
 *   メモは user-scoped (project 紐付けなし) のため、認可は self only。
 *
 * CSV 列構成 (4 列、編集 dialog 完全網羅):
 *   ID / title / content / visibility
 */

import { prisma } from '@/lib/db';
import { parseCsvLine } from './task.service';

// ============================================================
// 型定義
// ============================================================

export type MemoSyncImportRow = {
  tempRowIndex: number;
  id: string | null;
  title: string;
  content: string;
  visibility: 'private' | 'public';
};

export type SyncDiffAction = 'CREATE' | 'UPDATE' | 'NO_CHANGE' | 'REMOVE_CANDIDATE';
export type SyncDiffWarningLevel = 'INFO' | 'WARN' | 'ERROR';
export type SyncDiffFieldChange = { field: string; before: unknown; after: unknown };

export type MemoSyncDiffRow = {
  csvRow: number | null;
  id: string | null;
  action: SyncDiffAction;
  name: string;
  fieldChanges?: SyncDiffFieldChange[];
  warnings?: string[];
  errors?: string[];
  /** REMOVE_CANDIDATE で visibility=public のとき true (公開済は他者参照あり) */
  hasProgress?: boolean;
  warningLevel?: SyncDiffWarningLevel;
};

export type MemoSyncDiffResult = {
  summary: { added: number; updated: number; removed: number; blockedErrors: number; warnings: number };
  rows: MemoSyncDiffRow[];
  canExecute: boolean;
  globalErrors: string[];
};

export type RemoveMode = 'keep' | 'warn' | 'delete';

// ============================================================
// CSV ヘッダー (4 列)
// ============================================================

export const MEMO_CSV_HEADERS = ['ID', 'タイトル', '本文', '公開範囲'] as const;

const VALID_VISIBILITIES = new Set(['private', 'public']);

// ============================================================
// CSV パース
// ============================================================

export function parseMemoSyncImportCsv(csvText: string): MemoSyncImportRow[] {
  const cleanText = csvText.replace(/^﻿/, '');
  const lines = cleanText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const dataLines = lines.slice(1);
  const rows: MemoSyncImportRow[] = [];

  for (let i = 0; i < dataLines.length; i++) {
    const fields = parseCsvLine(dataLines[i]);
    if (fields.length < 2) continue;

    const csvRowIndex = i + 2;

    const idRaw = (fields[0] ?? '').trim();
    const id = idRaw.length > 0 ? idRaw : null;

    const title = (fields[1] ?? '').trim();
    if (!title) continue;

    const content = (fields[2] ?? '').trim();
    const visibilityRaw = (fields[3] ?? '').trim();
    const visibility = (VALID_VISIBILITIES.has(visibilityRaw) ? visibilityRaw : 'private') as 'private' | 'public';

    rows.push({ tempRowIndex: csvRowIndex, id, title, content, visibility });
  }

  return rows;
}

// ============================================================
// computeDiff (user-scoped)
// ============================================================

type DbMemoSnapshot = {
  id: string;
  userId: string;
  title: string;
  content: string;
  visibility: string;
};

export async function computeMemoSyncDiff(
  userId: string,
  csvRows: MemoSyncImportRow[],
): Promise<MemoSyncDiffResult> {
  const result: MemoSyncDiffResult = {
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

  // 自分のメモのみを対象 (user-scoped)
  const existingMemos = await prisma.memo.findMany({
    where: { userId, deletedAt: null },
    select: { id: true, userId: true, title: true, content: true, visibility: true },
  });

  const existingById = new Map(existingMemos.map((m) => [m.id, m as DbMemoSnapshot]));
  const existingByTitle = new Map<string, DbMemoSnapshot[]>();
  for (const m of existingMemos) {
    const arr = existingByTitle.get(m.title) ?? [];
    arr.push(m as DbMemoSnapshot);
    existingByTitle.set(m.title, arr);
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
    let dbM: DbMemoSnapshot | undefined;

    if (row.id) {
      dbM = existingById.get(row.id);
      if (!dbM) {
        errors.push(`ID "${row.id}" が見つかりません (自分のメモ以外は同期できません)`);
      } else {
        action = 'UPDATE';
        csvKeptIds.add(dbM.id);
      }
    } else {
      const sameTitle = existingByTitle.get(row.title);
      if (sameTitle && sameTitle.length > 0) {
        errors.push(
          `ID 空欄ですが同じタイトル "${row.title}" のメモが既存にあります (新規作成すると重複)。意図的なら ID 列に既存 ID を貼り付けるか、CSV 上でタイトルを変えてください`,
        );
      }
    }

    if (action === 'UPDATE' && dbM) {
      compareField(fieldChanges, 'title', dbM.title, row.title);
      compareField(fieldChanges, 'content', dbM.content, row.content);
      compareField(fieldChanges, 'visibility', dbM.visibility, row.visibility);
    }

    if (action === 'UPDATE' && fieldChanges.length === 0) action = 'NO_CHANGE';

    const errorCount = errors.length;
    result.rows.push({
      csvRow: row.tempRowIndex,
      id: dbM?.id ?? null,
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

  for (const m of existingMemos) {
    if (!csvKeptIds.has(m.id)) {
      const hasProgress = m.visibility === 'public';
      result.rows.push({
        csvRow: null,
        id: m.id,
        action: 'REMOVE_CANDIDATE',
        name: m.title,
        hasProgress,
        warningLevel: hasProgress ? 'ERROR' : 'WARN',
        warnings: hasProgress
          ? undefined
          : ['CSV にこのメモが含まれていません (削除モード次第で削除候補)'],
        errors: hasProgress
          ? ['CSV にこのメモが含まれていません。visibility=public のため削除モード=delete でブロック']
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

export type MemoSyncImportResult = { added: number; updated: number; removed: number };

export async function applyMemoSyncImport(
  userId: string,
  csvRows: MemoSyncImportRow[],
  removeMode: RemoveMode,
): Promise<MemoSyncImportResult> {
  const diff = await computeMemoSyncDiff(userId, csvRows);
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
        `IMPORT_REMOVE_BLOCKED:visibility=public のメモは削除モード=delete では消せません: ${blocked.map((r) => `"${r.name}"`).join(', ')}`,
      );
    }
  }

  const snapshot = await prisma.memo.findMany({ where: { userId, deletedAt: null } });
  const snapshotById = new Map(snapshot.map((m) => [m.id, m]));

  const createdIds: string[] = [];
  const updatedIds: string[] = [];
  const softDeletedIds: string[] = [];

  try {
    for (const row of csvRows) {
      const data = {
        title: row.title,
        content: row.content,
        visibility: row.visibility,
      };

      if (row.id) {
        await prisma.memo.update({ where: { id: row.id }, data });
        updatedIds.push(row.id);
      } else {
        const created = await prisma.memo.create({
          data: { ...data, userId },
        });
        createdIds.push(created.id);
      }
    }

    if (removeMode === 'delete') {
      for (const r of diff.rows) {
        if (r.action === 'REMOVE_CANDIDATE' && r.id && !r.hasProgress) {
          await prisma.memo.update({
            where: { id: r.id },
            data: { deletedAt: new Date() },
          });
          softDeletedIds.push(r.id);
        }
      }
    }

    return { added: createdIds.length, updated: updatedIds.length, removed: softDeletedIds.length };
  } catch (e) {
    await rollbackToSnapshot(snapshot, snapshotById, createdIds, updatedIds, softDeletedIds);
    throw e;
  }
}

async function rollbackToSnapshot(
  snapshot: Awaited<ReturnType<typeof prisma.memo.findMany>>,
  snapshotById: Map<string, (typeof snapshot)[number]>,
  createdIds: string[],
  updatedIds: string[],
  softDeletedIds: string[],
): Promise<void> {
  if (createdIds.length > 0) {
    await prisma.memo.deleteMany({ where: { id: { in: createdIds } } });
  }
  for (const id of updatedIds) {
    const orig = snapshotById.get(id);
    if (!orig) continue;
    await prisma.memo.update({
      where: { id },
      data: { title: orig.title, content: orig.content, visibility: orig.visibility },
    });
  }
  if (softDeletedIds.length > 0) {
    await prisma.memo.updateMany({
      where: { id: { in: softDeletedIds } },
      data: { deletedAt: null },
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

export async function exportMemosSync(userId: string): Promise<string> {
  const memos = await prisma.memo.findMany({
    where: { userId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  const lines = [MEMO_CSV_HEADERS.join(',')];
  for (const m of memos) {
    const line = [m.id, escapeCsv(m.title), escapeCsv(m.content), m.visibility].join(',');
    lines.push(line);
  }
  return '﻿' + lines.join('\n');
}
