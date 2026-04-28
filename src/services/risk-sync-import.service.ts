/**
 * リスク/課題 上書きインポート (Sync by ID) サービス (T-22 Phase 22a)。
 *
 * 役割:
 *   既存リスク/課題を「export → Excel 編集 → re-import」の往復編集サイクルで管理する。
 *   T-19 で WBS に確立した sync-import パターンを flat entity (parent/child 階層なし) に
 *   適用した派生実装。
 *
 * 主な公開関数:
 *   - parseRiskSyncImportCsv : 16 列 CSV を RiskSyncImportRow[] に変換
 *   - computeRiskSyncDiff    : DB 既存と CSV を突合し、blocker / warning / 行ごとの差分を返す
 *                              (dry-run 用、副作用なし)
 *   - applyRiskSyncImport    : 確定実行。失敗時は事前スナップショットから完全復元
 *
 * CSV 列構成 (16 列、編集 dialog 完全網羅、§5.31 アクション充足チェック適用済):
 *   ID / type / title / content / cause / impact / likelihood /
 *   responsePolicy / responseDetail / assigneeName / deadline / state /
 *   result / lessonLearned / visibility / riskNature
 *
 *   priority は computePriority() で自動算出のため CSV 非対応。
 *
 * 設計判断:
 *   - Sync by ID: ID 列が空欄=新規作成、既存 ID と一致=UPDATE
 *   - 突合: ID 一致のみ。ID 不一致だが名称一致は誤コピー扱いで blocker
 *   - 削除候補: dry-run でユーザがモード選択 (keep / warn / delete)
 *   - type 切替 (risk↔issue): blocker (手動の削除→新規作成を促す)
 *   - 担当者: 氏名 → ProjectMember 経由で userId lookup、複数該当=blocker
 *   - トランザクション: 全 or 無 (PgBouncer 制約で $transaction 不可、事前 snapshot で復元)
 *   - 認可: PM/TL + admin (呼出側 API ルートで risk:update + risk:delete を確認済の前提)
 *
 * 関連:
 *   - DEVELOPER_GUIDE §11 T-22 Phase 22a
 *   - DEVELOPER_GUIDE §5.31 (枠数固定要件のアクション充足チェック)
 *   - src/services/task-sync-import.service.ts (パターンの起点)
 */

import { prisma } from '@/lib/db';
import { parseCsvLine } from './task.service';
import { computePriority } from './risk.service';

// ============================================================
// 型定義
// ============================================================

/**
 * 16 列 CSV から解析した 1 行。tempRowIndex は CSV 上の元の行番号 (1 始まり)。
 */
export type RiskSyncImportRow = {
  tempRowIndex: number;
  /** ID 列の値。空欄なら null (= 新規作成扱い)。 */
  id: string | null;
  type: 'risk' | 'issue';
  title: string;
  content: string;
  cause: string | null;
  impact: 'low' | 'medium' | 'high';
  likelihood: 'low' | 'medium' | 'high' | null;
  responsePolicy: string | null;
  responseDetail: string | null;
  /** 担当者氏名。空欄なら null。サービス層で ProjectMember と一意 lookup する。 */
  assigneeName: string | null;
  deadline: string | null;
  state: 'open' | 'in_progress' | 'monitoring' | 'resolved';
  result: string | null;
  lessonLearned: string | null;
  visibility: 'draft' | 'public';
  riskNature: 'threat' | 'opportunity' | null;
};

export type SyncDiffAction = 'CREATE' | 'UPDATE' | 'NO_CHANGE' | 'REMOVE_CANDIDATE';
export type SyncDiffWarningLevel = 'INFO' | 'WARN' | 'ERROR';
export type SyncDiffFieldChange = {
  field: string;
  before: unknown;
  after: unknown;
};

export type RiskSyncDiffRow = {
  csvRow: number | null;
  /** DB のリスク ID。CREATE の場合は null。 */
  id: string | null;
  action: SyncDiffAction;
  /** 行を識別する人間可読な名前 (= title) */
  name: string;
  fieldChanges?: SyncDiffFieldChange[];
  warnings?: string[];
  errors?: string[];
  /** REMOVE_CANDIDATE で進捗 (state != 'open') があるとき true */
  hasProgress?: boolean;
  warningLevel?: SyncDiffWarningLevel;
};

export type RiskSyncDiffResult = {
  summary: {
    added: number;
    updated: number;
    removed: number;
    blockedErrors: number;
    warnings: number;
  };
  rows: RiskSyncDiffRow[];
  canExecute: boolean;
  globalErrors: string[];
};

export type RemoveMode = 'keep' | 'warn' | 'delete';

// ============================================================
// CSV ヘッダー
// ============================================================

/** Risk CSV ヘッダー (16 列、編集 dialog 完全網羅) */
export const RISK_CSV_HEADERS = [
  'ID', '種別', '件名', '内容', '原因', '影響度', '発生確率',
  '対応方針', '対応詳細', '担当者氏名', '期限', '状態',
  '結果', '教訓', '公開範囲', 'リスク性質',
] as const;

// ============================================================
// CSV パース
// ============================================================

const VALID_TYPES = new Set(['risk', 'issue']);
const VALID_IMPACTS = new Set(['low', 'medium', 'high']);
const VALID_STATES = new Set(['open', 'in_progress', 'monitoring', 'resolved']);
const VALID_VISIBILITIES = new Set(['draft', 'public']);
const VALID_NATURES = new Set(['threat', 'opportunity']);

/**
 * 16 列 CSV を解析して RiskSyncImportRow[] を返す。
 * 列順は RISK_CSV_HEADERS と同じ。厳格 validation は computeRiskSyncDiff 側で行う。
 */
export function parseRiskSyncImportCsv(csvText: string): RiskSyncImportRow[] {
  const cleanText = csvText.replace(/^﻿/, '');
  const lines = cleanText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const dataLines = lines.slice(1);
  const rows: RiskSyncImportRow[] = [];

  for (let i = 0; i < dataLines.length; i++) {
    const fields = parseCsvLine(dataLines[i]);
    // ID + type + title + impact (= 6 列目まで) は最低限必要
    if (fields.length < 6) continue;

    const csvRowIndex = i + 2;

    const idRaw = (fields[0] ?? '').trim();
    const id = idRaw.length > 0 ? idRaw : null;

    const typeRaw = (fields[1] ?? '').trim();
    const type = (VALID_TYPES.has(typeRaw) ? typeRaw : 'risk') as 'risk' | 'issue';

    const title = (fields[2] ?? '').trim();
    if (!title) continue;

    const content = (fields[3] ?? '').trim();
    const cause = (fields[4] ?? '').trim() || null;
    const impactRaw = (fields[5] ?? '').trim();
    const impact = (VALID_IMPACTS.has(impactRaw) ? impactRaw : 'medium') as 'low' | 'medium' | 'high';
    const likelihoodRaw = (fields[6] ?? '').trim();
    const likelihood = VALID_IMPACTS.has(likelihoodRaw) ? (likelihoodRaw as 'low' | 'medium' | 'high') : null;
    const responsePolicy = (fields[7] ?? '').trim() || null;
    const responseDetail = (fields[8] ?? '').trim() || null;
    const assigneeName = (fields[9] ?? '').trim() || null;
    const deadline = (fields[10] ?? '').trim() || null;
    const stateRaw = (fields[11] ?? '').trim();
    const state = (VALID_STATES.has(stateRaw) ? stateRaw : 'open') as 'open' | 'in_progress' | 'monitoring' | 'resolved';
    const result = (fields[12] ?? '').trim() || null;
    const lessonLearned = (fields[13] ?? '').trim() || null;
    const visibilityRaw = (fields[14] ?? '').trim();
    const visibility = (VALID_VISIBILITIES.has(visibilityRaw) ? visibilityRaw : 'public') as 'draft' | 'public';
    const natureRaw = (fields[15] ?? '').trim();
    const riskNature = VALID_NATURES.has(natureRaw) ? (natureRaw as 'threat' | 'opportunity') : null;

    rows.push({
      tempRowIndex: csvRowIndex,
      id, type, title, content, cause, impact, likelihood,
      responsePolicy, responseDetail, assigneeName, deadline, state,
      result, lessonLearned, visibility, riskNature,
    });
  }

  return rows;
}

// ============================================================
// 内部: DB 既存リスクのスナップショット型
// ============================================================

type DbRiskSnapshot = {
  id: string;
  projectId: string;
  type: string;
  title: string;
  content: string;
  cause: string | null;
  impact: string;
  likelihood: string | null;
  priority: string;
  responsePolicy: string | null;
  responseDetail: string | null;
  reporterId: string;
  assigneeId: string | null;
  deadline: Date | null;
  state: string;
  result: string | null;
  lessonLearned: string | null;
  visibility: string;
  riskNature: string | null;
  createdBy: string;
  updatedBy: string;
};

function dateOnlyStr(d: Date | null): string | null {
  return d ? d.toISOString().split('T')[0] : null;
}

// ============================================================
// computeRiskSyncDiff (dry-run 本体)
// ============================================================

/**
 * CSV 内容と DB 既存リスクを突合し、行ごとの差分 + サマリ + ブロッカーを返す。
 * 副作用なし。
 *
 * 検証項目 (blocker):
 *   - title / type / impact / state / visibility の必須・形式 (parser で型保証済)
 *   - type 切替 (risk↔issue): blocker
 *   - ID 不一致だが title 一致 (誤コピー検知)
 *   - 担当者氏名がプロジェクトメンバーに無し or 複数該当
 *   - CSV 内 ID 重複 / title 重複
 *   - DB に存在しない ID を指定
 */
export async function computeRiskSyncDiff(
  projectId: string,
  csvRows: RiskSyncImportRow[],
): Promise<RiskSyncDiffResult> {
  const result: RiskSyncDiffResult = {
    summary: { added: 0, updated: 0, removed: 0, blockedErrors: 0, warnings: 0 },
    rows: [],
    canExecute: true,
    globalErrors: [],
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

  const [existingRisks, members] = await Promise.all([
    prisma.riskIssue.findMany({
      where: { projectId, deletedAt: null },
      select: {
        id: true, projectId: true, type: true, title: true, content: true,
        cause: true, impact: true, likelihood: true, priority: true,
        responsePolicy: true, responseDetail: true,
        reporterId: true, assigneeId: true, deadline: true, state: true,
        result: true, lessonLearned: true, visibility: true, riskNature: true,
        createdBy: true, updatedBy: true,
      },
    }),
    prisma.projectMember.findMany({
      where: { projectId },
      include: { user: { select: { id: true, name: true } } },
    }),
  ]);

  const existingById = new Map(existingRisks.map((r) => [r.id, r as DbRiskSnapshot]));
  const existingByTitle = new Map<string, DbRiskSnapshot[]>();
  for (const r of existingRisks) {
    const arr = existingByTitle.get(r.title) ?? [];
    arr.push(r as DbRiskSnapshot);
    existingByTitle.set(r.title, arr);
  }

  const membersByName = new Map<string, { id: string; name: string }[]>();
  for (const m of members) {
    if (!m.user) continue;
    const arr = membersByName.get(m.user.name) ?? [];
    arr.push({ id: m.user.id, name: m.user.name });
    membersByName.set(m.user.name, arr);
  }

  // CSV 内重複検知
  const csvIdCounts = new Map<string, number>();
  const csvTitleCounts = new Map<string, number>();
  for (const r of csvRows) {
    if (r.id) csvIdCounts.set(r.id, (csvIdCounts.get(r.id) ?? 0) + 1);
    csvTitleCounts.set(r.title, (csvTitleCounts.get(r.title) ?? 0) + 1);
  }
  const duplicateIds = new Set([...csvIdCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id));
  const duplicateTitles = new Set([...csvTitleCounts.entries()].filter(([, c]) => c > 1).map(([t]) => t));

  const csvKeptIds = new Set<string>();

  for (let i = 0; i < csvRows.length; i++) {
    const row = csvRows[i];
    const errors: string[] = [];
    const fieldChanges: SyncDiffFieldChange[] = [];

    if (row.id && duplicateIds.has(row.id)) {
      errors.push(`CSV 内で ID "${row.id}" が重複しています`);
    }
    if (duplicateTitles.has(row.title)) {
      errors.push(`CSV 内で件名 "${row.title}" が重複しています`);
    }

    // 担当者 lookup
    let resolvedAssigneeId: string | null = null;
    if (row.assigneeName) {
      const candidates = membersByName.get(row.assigneeName);
      if (!candidates || candidates.length === 0) {
        errors.push(`担当者 "${row.assigneeName}" がプロジェクトメンバーに見つかりません`);
      } else if (candidates.length > 1) {
        errors.push(`担当者 "${row.assigneeName}" がプロジェクトメンバー内で複数該当します`);
      } else {
        resolvedAssigneeId = candidates[0].id;
      }
    }

    let action: SyncDiffAction = 'CREATE';
    let dbRisk: DbRiskSnapshot | undefined;

    if (row.id) {
      dbRisk = existingById.get(row.id);
      if (!dbRisk) {
        errors.push(`ID "${row.id}" が DB に存在しません`);
      } else if (dbRisk.projectId !== projectId) {
        errors.push(`ID "${row.id}" は別プロジェクトのリスク/課題です`);
      } else {
        action = 'UPDATE';
        csvKeptIds.add(dbRisk.id);

        if (dbRisk.type !== row.type) {
          errors.push(
            `種別を ${dbRisk.type === 'risk' ? 'リスク' : '課題'} → ${row.type === 'risk' ? 'リスク' : '課題'} へ変更できません (削除→新規作成してください)`,
          );
        }
      }
    } else {
      const sameTitle = existingByTitle.get(row.title);
      if (sameTitle && sameTitle.length > 0) {
        errors.push(
          `ID 空欄ですが同じ件名のリスク/課題が既存にあります (新規作成すると重複)。意図的なら ID 列に既存 ID を貼り付けるか、CSV 上で件名を変えてください`,
        );
      }
    }

    if (action === 'UPDATE' && dbRisk) {
      compareField(fieldChanges, 'title', dbRisk.title, row.title);
      compareField(fieldChanges, 'content', dbRisk.content, row.content);
      compareField(fieldChanges, 'cause', dbRisk.cause, row.cause);
      compareField(fieldChanges, 'impact', dbRisk.impact, row.impact);
      compareField(fieldChanges, 'likelihood', dbRisk.likelihood, row.likelihood);
      compareField(fieldChanges, 'responsePolicy', dbRisk.responsePolicy, row.responsePolicy);
      compareField(fieldChanges, 'responseDetail', dbRisk.responseDetail, row.responseDetail);
      compareField(fieldChanges, 'assigneeId', dbRisk.assigneeId, resolvedAssigneeId);
      compareField(fieldChanges, 'deadline', dateOnlyStr(dbRisk.deadline), row.deadline);
      compareField(fieldChanges, 'state', dbRisk.state, row.state);
      compareField(fieldChanges, 'result', dbRisk.result, row.result);
      compareField(fieldChanges, 'lessonLearned', dbRisk.lessonLearned, row.lessonLearned);
      compareField(fieldChanges, 'visibility', dbRisk.visibility, row.visibility);
      compareField(fieldChanges, 'riskNature', dbRisk.riskNature, row.riskNature);
    }

    if (action === 'UPDATE' && fieldChanges.length === 0) {
      action = 'NO_CHANGE';
    }

    const errorCount = errors.length;
    const warningLevel: SyncDiffWarningLevel = errorCount > 0 ? 'ERROR' : 'INFO';

    result.rows.push({
      csvRow: row.tempRowIndex,
      id: dbRisk?.id ?? null,
      action,
      name: row.title,
      fieldChanges: fieldChanges.length > 0 ? fieldChanges : undefined,
      errors: errors.length > 0 ? errors : undefined,
      warningLevel,
    });

    if (action === 'CREATE' && errorCount === 0) result.summary.added++;
    if (action === 'UPDATE' && errorCount === 0) result.summary.updated++;
    result.summary.blockedErrors += errorCount;
  }

  // 削除候補 (DB に存在するが CSV に出てこない ID)
  for (const r of existingRisks) {
    if (!csvKeptIds.has(r.id)) {
      // 進捗あり = state が 'open' 以外
      const hasProgress = r.state !== 'open';
      result.rows.push({
        csvRow: null,
        id: r.id,
        action: 'REMOVE_CANDIDATE',
        name: r.title,
        hasProgress,
        warningLevel: hasProgress ? 'ERROR' : 'WARN',
        warnings: hasProgress
          ? undefined
          : ['CSV にこのリスク/課題が含まれていません (削除モード次第で削除候補)'],
        errors: hasProgress
          ? ['CSV にこのリスク/課題が含まれていません。state が open 以外 (進捗あり、削除モード=delete のとき blocker)']
          : undefined,
      });
      result.summary.removed++;
    }
  }

  if (result.summary.blockedErrors > 0) {
    result.canExecute = false;
  }

  return result;
}

function compareField(
  list: SyncDiffFieldChange[],
  field: string,
  before: unknown,
  after: unknown,
): void {
  if (!shallowEqual(before, after)) {
    list.push({ field, before, after });
  }
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

// ============================================================
// applyRiskSyncImport (本実行 + rollback)
// ============================================================

export type RiskSyncImportResult = {
  added: number;
  updated: number;
  removed: number;
};

/**
 * dry-run 結果を踏まえて確定実行する。
 *
 * 流れ:
 *   1. computeRiskSyncDiff を再実行して再 validation
 *   2. ブロッカーがあれば即エラー
 *   3. 削除候補のうち進捗ありは removeMode='delete' でブロック
 *   4. 影響リスクの完全スナップショットを取得 (rollback 用)
 *   5. CREATE/UPDATE/DELETE を逐次実行
 *   6. 失敗時は 4 のスナップショットから復元
 *
 * @throws {Error} 'IMPORT_VALIDATION_ERROR:<msgs>' — 再 validation で blocker
 * @throws {Error} 'IMPORT_REMOVE_BLOCKED:<msgs>' — 進捗ありリスクの削除を要求された
 */
export async function applyRiskSyncImport(
  projectId: string,
  csvRows: RiskSyncImportRow[],
  removeMode: RemoveMode,
  userId: string,
): Promise<RiskSyncImportResult> {
  // 1. 再 validation
  const diff = await computeRiskSyncDiff(projectId, csvRows);
  if (!diff.canExecute) {
    const msgs = [
      ...diff.globalErrors,
      ...diff.rows.flatMap((r) => (r.errors ?? []).map((e) => `行 ${r.csvRow ?? '-'}: ${e}`)),
    ];
    throw new Error(`IMPORT_VALIDATION_ERROR:${msgs.join('; ')}`);
  }

  // 2. 削除候補のうち進捗ありは removeMode='delete' でブロック
  if (removeMode === 'delete') {
    const blockedRemovals = diff.rows.filter(
      (r) => r.action === 'REMOVE_CANDIDATE' && r.hasProgress,
    );
    if (blockedRemovals.length > 0) {
      throw new Error(
        `IMPORT_REMOVE_BLOCKED:state が open 以外のリスク/課題は削除モード=delete では消せません: ${blockedRemovals.map((r) => `"${r.name}"`).join(', ')}`,
      );
    }
  }

  // 3. snapshot
  const snapshot = await prisma.riskIssue.findMany({
    where: { projectId, deletedAt: null },
  });
  const snapshotById = new Map(snapshot.map((r) => [r.id, r]));

  const createdIds: string[] = [];
  const updatedIds: string[] = [];
  const softDeletedIds: string[] = [];

  try {
    // members lookup
    const members = await prisma.projectMember.findMany({
      where: { projectId },
      include: { user: { select: { id: true, name: true } } },
    });
    const membersByName = new Map<string, string>();
    for (const m of members) {
      if (m.user) membersByName.set(m.user.name, m.user.id);
    }

    for (const row of csvRows) {
      const resolvedAssigneeId = row.assigneeName ? membersByName.get(row.assigneeName) ?? null : null;
      const computedPriority = computePriority(row.type, row.impact, row.likelihood ?? 'low');

      const data = {
        projectId,
        type: row.type,
        title: row.title,
        content: row.content,
        cause: row.cause,
        impact: row.impact,
        likelihood: row.likelihood,
        priority: computedPriority,
        responsePolicy: row.responsePolicy,
        responseDetail: row.responseDetail,
        assigneeId: resolvedAssigneeId,
        deadline: row.deadline ? new Date(row.deadline) : null,
        state: row.state,
        result: row.result,
        lessonLearned: row.lessonLearned,
        visibility: row.visibility,
        riskNature: row.riskNature,
        updatedBy: userId,
      };

      if (row.id) {
        await prisma.riskIssue.update({
          where: { id: row.id },
          data,
        });
        updatedIds.push(row.id);
      } else {
        const created = await prisma.riskIssue.create({
          data: {
            ...data,
            reporterId: userId,
            createdBy: userId,
          },
        });
        createdIds.push(created.id);
      }
    }

    // 削除モード処理
    if (removeMode === 'delete') {
      for (const r of diff.rows) {
        if (r.action === 'REMOVE_CANDIDATE' && r.id && !r.hasProgress) {
          await prisma.riskIssue.update({
            where: { id: r.id },
            data: { deletedAt: new Date(), updatedBy: userId },
          });
          softDeletedIds.push(r.id);
        }
      }
    }

    return {
      added: createdIds.length,
      updated: updatedIds.length,
      removed: softDeletedIds.length,
    };
  } catch (e) {
    // rollback
    await rollbackToSnapshot(snapshot, snapshotById, createdIds, updatedIds, softDeletedIds, userId);
    throw e;
  }
}

async function rollbackToSnapshot(
  snapshot: Awaited<ReturnType<typeof prisma.riskIssue.findMany>>,
  snapshotById: Map<string, (typeof snapshot)[number]>,
  createdIds: string[],
  updatedIds: string[],
  softDeletedIds: string[],
  userId: string,
): Promise<void> {
  if (createdIds.length > 0) {
    await prisma.riskIssue.deleteMany({ where: { id: { in: createdIds } } });
  }
  for (const id of updatedIds) {
    const orig = snapshotById.get(id);
    if (!orig) continue;
    await prisma.riskIssue.update({
      where: { id },
      data: {
        type: orig.type,
        title: orig.title,
        content: orig.content,
        cause: orig.cause,
        impact: orig.impact,
        likelihood: orig.likelihood,
        priority: orig.priority,
        responsePolicy: orig.responsePolicy,
        responseDetail: orig.responseDetail,
        assigneeId: orig.assigneeId,
        deadline: orig.deadline,
        state: orig.state,
        result: orig.result,
        lessonLearned: orig.lessonLearned,
        visibility: orig.visibility,
        riskNature: orig.riskNature,
        updatedBy: userId,
      },
    });
  }
  if (softDeletedIds.length > 0) {
    await prisma.riskIssue.updateMany({
      where: { id: { in: softDeletedIds } },
      data: { deletedAt: null, updatedBy: userId },
    });
  }
}

// ============================================================
// Sync 形式の CSV エクスポート (16 列、編集 dialog 完全網羅)
// ============================================================

/** CSV フィールドエスケープ */
function escapeCsv(v: string | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * リスク/課題の sync 用 CSV エクスポート (16 列、編集 dialog 完全網羅)。
 *
 * 既存の `risksToCSV` (PMO 報告用 8 列サマリ) とは別用途で、
 * sync-import の往復編集に使う full-fidelity 形式を出力する。
 */
export async function exportRisksSync(
  projectId: string,
  viewerUserId: string,
  viewerSystemRole: string,
): Promise<string> {
  const isAdmin = viewerSystemRole === 'admin';
  const visibilityWhere = isAdmin ? {} : { visibility: 'public' };

  const risks = await prisma.riskIssue.findMany({
    where: { projectId, deletedAt: null, ...visibilityWhere },
    include: { assignee: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });

  const lines = [RISK_CSV_HEADERS.join(',')];
  for (const r of risks) {
    const line = [
      r.id,
      r.type,
      escapeCsv(r.title),
      escapeCsv(r.content),
      escapeCsv(r.cause),
      r.impact,
      r.likelihood ?? '',
      escapeCsv(r.responsePolicy),
      escapeCsv(r.responseDetail),
      escapeCsv(r.assignee?.name ?? null),
      r.deadline ? r.deadline.toISOString().split('T')[0] : '',
      r.state,
      escapeCsv(r.result),
      escapeCsv(r.lessonLearned),
      r.visibility,
      r.riskNature ?? '',
    ].join(',');
    lines.push(line);
  }
  // viewerUserId は将来の権限フィルタ拡張用に予約 (現状未使用、admin/non-admin 切替は visibilityWhere)
  void viewerUserId;
  // BOM 付き UTF-8 (Excel 対応)
  return '﻿' + lines.join('\n');
}
