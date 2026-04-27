/**
 * WBS 上書きインポート (Sync by ID) サービス (feat/wbs-overwrite-import)。
 *
 * 役割:
 *   既存 WBS を「export → Excel 編集 → re-import」の往復編集サイクルで管理する。
 *   旧テンプレートインポート (task.service.ts#importWbsTemplate) は別プロジェクトへの
 *   雛形流用用途で残し、本サービスは同一プロジェクト内の上書き編集に特化。
 *
 * 主な公開関数:
 *   - parseSyncImportCsv : CSV テキストを 17 列の TemplateRow に変換
 *   - computeSyncDiff    : DB 既存と CSV を突合し、blocker / warning / 行ごとの差分を返す
 *                          (dry-run 用、副作用なし)
 *   - applySyncImport    : 確定実行。失敗時は事前スナップショットから完全復元
 *
 * 設計判断 (DESIGN.md §33 準拠):
 *   - Sync by ID: ID 列が空欄=新規作成、既存 ID と一致=UPDATE
 *   - 進捗・実績の保全: CSV にあっても進捗系列は無視 (read-only 列)
 *   - 突合: ID 一致のみ。ID 不一致だが名称一致は誤コピー扱いで blocker
 *   - 削除候補: dry-run でユーザがモード選択 (keep / warn / delete)
 *   - WP↔ACT 切替: blocker (手動の削除→新規作成を促す)
 *   - トランザクション: 全 or 無 (PgBouncer 制約で $transaction 不可、事前 snapshot で復元)
 *   - 認可: PM/TL + admin (呼出側 API ルートで task:update + task:delete を確認済の前提)
 */

import { prisma } from '@/lib/db';
import { parseCsvLine, recalculateAncestorsPublic } from './task.service';

// ============================================================
// 型定義
// ============================================================

/** CSV から解析した 1 行 (17 列に対応)。tempRowIndex は CSV 上の元の行番号 (1 始まり)。 */
export type SyncImportRow = {
  tempRowIndex: number;
  /** ID 列の値。空欄なら null (= 新規作成扱い)。 */
  id: string | null;
  level: number;
  type: 'work_package' | 'activity';
  name: string;
  wbsNumber: string | null;
  /** 担当者氏名。空欄なら null。サービス層で ProjectMember と一意 lookup する。 */
  assigneeName: string | null;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  plannedEffort: number | null;
  priority: 'low' | 'medium' | 'high' | null;
  isMilestone: boolean;
  notes: string | null;
  // 以下は read-only 参考情報。validation で DB と異なれば warning に含める。
  csvStatus: string | null;
  csvProgressRate: number | null;
  csvActualStartDate: string | null;
  csvActualEndDate: string | null;
};

export type SyncDiffAction = 'CREATE' | 'UPDATE' | 'NO_CHANGE' | 'REMOVE_CANDIDATE';

export type SyncDiffWarningLevel = 'INFO' | 'WARN' | 'ERROR';

export type SyncDiffFieldChange = {
  field: string;
  before: unknown;
  after: unknown;
};

export type SyncDiffRow = {
  /** CSV 行番号 (REMOVE_CANDIDATE は null) */
  csvRow: number | null;
  /** DB のタスク ID。CREATE の場合は null。 */
  id: string | null;
  /** 内部突合用の一時 ID (parent 参照を再構築するために使用) */
  tempId: string | null;
  action: SyncDiffAction;
  name: string;
  /** UPDATE 時に変化のあったフィールドの before/after */
  fieldChanges?: SyncDiffFieldChange[];
  warnings?: string[];
  errors?: string[];
  /** REMOVE_CANDIDATE で進捗を持つタスクのとき true (削除モード時にエラー化) */
  hasProgress?: boolean;
  /** UI でハイライトする最大重大度 */
  warningLevel?: SyncDiffWarningLevel;
};

export type SyncDiffResult = {
  summary: {
    added: number;
    updated: number;
    removed: number;
    blockedErrors: number;
    warnings: number;
  };
  rows: SyncDiffRow[];
  /** ブロッカー 0 件なら true (dry-run 結果に基づく) */
  canExecute: boolean;
  /** 行に紐付かないグローバルなエラー (ヘッダー不正など) */
  globalErrors: string[];
};

export type RemoveMode = 'keep' | 'warn' | 'delete';

// ============================================================
// CSV パース
// ============================================================

/**
 * 17 列 CSV を解析して SyncImportRow[] を返す。
 *
 * - 1 行目はヘッダー。スキップする。
 * - 列数チェックは緩め (短い行はスキップ、長い行は余分列を無視) で実用優先。
 * - 厳格 validation は computeSyncDiff 側で行う。
 */
export function parseSyncImportCsv(csvText: string): SyncImportRow[] {
  // BOM 除去
  const cleanText = csvText.replace(/^﻿/, '');
  const lines = cleanText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return []; // ヘッダーのみ

  const dataLines = lines.slice(1);
  const rows: SyncImportRow[] = [];

  for (let i = 0; i < dataLines.length; i++) {
    const fields = parseCsvLine(dataLines[i]);
    // ID + レベル + 種別 + 名称 (= 4 列) は最低限必要
    if (fields.length < 4) continue;

    const csvRowIndex = i + 2; // ヘッダー行 + 0 始まり補正

    const idRaw = (fields[0] ?? '').trim();
    const id = idRaw.length > 0 ? idRaw : null;

    const level = parseInt(fields[1], 10);
    if (isNaN(level) || level < 1) continue;

    const typeRaw = (fields[2] ?? '').trim();
    const type = typeRaw === 'WP' ? 'work_package' : 'activity';

    const name = (fields[3] ?? '').trim();
    if (!name) continue;

    const wbsNumber = (fields[4] ?? '').trim() || null;
    const assigneeName = (fields[5] ?? '').trim() || null;
    const plannedStartDate = (fields[6] ?? '').trim() || null;
    const plannedEndDate = (fields[7] ?? '').trim() || null;
    const plannedEffortStr = (fields[8] ?? '').trim();
    const plannedEffort = plannedEffortStr ? parseFloat(plannedEffortStr) : null;
    const priorityRaw = (fields[9] ?? '').trim();
    const priority = (['low', 'medium', 'high'].includes(priorityRaw) ? priorityRaw : null) as
      | 'low'
      | 'medium'
      | 'high'
      | null;
    const isMilestone = (fields[10] ?? '').trim() === '○';
    const notes = (fields[11] ?? '').trim() || null;

    // 進捗系 (read-only、無視するが warning 用に保持)
    const csvStatus = (fields[12] ?? '').trim() || null;
    const csvProgressStr = (fields[13] ?? '').trim();
    const csvProgressRate = csvProgressStr ? parseInt(csvProgressStr, 10) : null;
    // 実績工数列 (14) は本 PR 範囲外なので無視
    const csvActualStartDate = (fields[15] ?? '').trim() || null;
    const csvActualEndDate = (fields[16] ?? '').trim() || null;

    rows.push({
      tempRowIndex: csvRowIndex,
      id,
      level,
      type,
      name,
      wbsNumber,
      assigneeName,
      plannedStartDate,
      plannedEndDate,
      plannedEffort: plannedEffort != null && !isNaN(plannedEffort) ? plannedEffort : null,
      priority,
      isMilestone,
      notes,
      csvStatus,
      csvProgressRate: csvProgressRate != null && !isNaN(csvProgressRate) ? csvProgressRate : null,
      csvActualStartDate,
      csvActualEndDate,
    });
  }

  return rows;
}

// ============================================================
// 内部: DB 既存タスクのスナップショット型
// ============================================================

type DbTaskSnapshot = {
  id: string;
  projectId: string;
  parentTaskId: string | null;
  type: string;
  wbsNumber: string | null;
  name: string;
  description: string | null;
  category: string;
  assigneeId: string | null;
  plannedStartDate: Date | null;
  plannedEndDate: Date | null;
  actualStartDate: Date | null;
  actualEndDate: Date | null;
  // Prisma Decimal を扱うため unknown とし、利用箇所で Number() に通す
  plannedEffort: unknown;
  priority: string | null;
  status: string;
  progressRate: number;
  isMilestone: boolean;
  notes: string | null;
  createdBy: string;
  updatedBy: string;
};

function dateOnlyStr(d: Date | null): string | null {
  return d ? d.toISOString().split('T')[0] : null;
}

// ============================================================
// computeSyncDiff (dry-run 本体)
// ============================================================

/**
 * CSV 内容と DB 既存タスクを突合し、行ごとの差分 + サマリ + ブロッカーを返す。
 * 副作用なし (DB 変更しない)。本実行は applySyncImport が同じ突合ロジックを再実行する。
 *
 * 検証項目 (blocker):
 *   - level / 名称 / 種別の必須・形式
 *   - 親不在 (level=N の親が直前のスタックに無い)
 *   - WP↔ACT 切替 (既存 type と CSV type の不一致)
 *   - ID 不一致だが名称一致 (誤コピー検知)
 *   - 担当者氏名がプロジェクトメンバーに無し or 複数該当
 *   - CSV 内 ID 重複 / 同階層名称重複
 *   - DB に存在しない ID を指定 (typo 等)
 */
export async function computeSyncDiff(
  projectId: string,
  csvRows: SyncImportRow[],
): Promise<SyncDiffResult> {
  const result: SyncDiffResult = {
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

  // DB 既存タスク + プロジェクトメンバーを取得
  const [existingTasks, members] = await Promise.all([
    prisma.task.findMany({
      where: { projectId, deletedAt: null },
      select: {
        id: true,
        projectId: true,
        parentTaskId: true,
        type: true,
        wbsNumber: true,
        name: true,
        description: true,
        category: true,
        assigneeId: true,
        plannedStartDate: true,
        plannedEndDate: true,
        actualStartDate: true,
        actualEndDate: true,
        plannedEffort: true,
        priority: true,
        status: true,
        progressRate: true,
        isMilestone: true,
        notes: true,
        createdBy: true,
        updatedBy: true,
      },
    }),
    prisma.projectMember.findMany({
      where: { projectId },
      include: { user: { select: { id: true, name: true } } },
    }),
  ]);

  const existingById = new Map(existingTasks.map((t) => [t.id, t as DbTaskSnapshot]));
  const existingByName = new Map<string, DbTaskSnapshot[]>();
  for (const t of existingTasks) {
    const arr = existingByName.get(t.name) ?? [];
    arr.push(t as DbTaskSnapshot);
    existingByName.set(t.name, arr);
  }

  // 担当者氏名 → userId 辞書 (氏名重複時は配列で保持)
  const membersByName = new Map<string, { id: string; name: string }[]>();
  for (const m of members) {
    if (!m.user) continue;
    const arr = membersByName.get(m.user.name) ?? [];
    arr.push({ id: m.user.id, name: m.user.name });
    membersByName.set(m.user.name, arr);
  }

  // CSV 内の ID 重複検知
  const csvIdCounts = new Map<string, number>();
  for (const r of csvRows) {
    if (r.id) csvIdCounts.set(r.id, (csvIdCounts.get(r.id) ?? 0) + 1);
  }
  const duplicateIds = new Set([...csvIdCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id));

  // 同階層名称重複検知 (level + parent + name のキーで判定するが、
  // 親決定は level スタックで動的なので、単純に同じ level かつ同じ name で重複検知)
  const csvNameByLevelCounts = new Map<string, number>();
  for (const r of csvRows) {
    const key = `${r.level}::${r.name}`;
    csvNameByLevelCounts.set(key, (csvNameByLevelCounts.get(key) ?? 0) + 1);
  }
  const duplicateNamesAtLevel = new Set(
    [...csvNameByLevelCounts.entries()].filter(([, c]) => c > 1).map(([k]) => k),
  );

  // 親決定用のスタック (level → 該当タスクの tempRowIndex / 行)
  const parentStack: { row: SyncImportRow; tempId: string }[] = [];
  // 各行に tempId を割り当て (UI での参照キー用)
  const tempIdByRow = new Map<SyncImportRow, string>();

  // CSV から「このインポートで生き残るタスク id」の集合を作る (REMOVE_CANDIDATE 検出用)
  const csvKeptIds = new Set<string>();

  // 行ごとの diff 計算
  for (let i = 0; i < csvRows.length; i++) {
    const row = csvRows[i];
    const tempId = `csv_${row.tempRowIndex}`;
    tempIdByRow.set(row, tempId);

    const errors: string[] = [];
    const warnings: string[] = [];
    const fieldChanges: SyncDiffFieldChange[] = [];

    // 親決定 (level スタック)
    // 親 DB id は UPDATE の fieldChanges (parentTaskId 比較) で使う。
    // tempId は applySyncImport 側で再構築するため、ここでは親の検証 + DB id 抽出のみ。
    let parentDbId: string | null = null;
    if (row.level > 1) {
      // 直近の level=N-1 の要素
      const parent = parentStack[row.level - 2];
      if (!parent) {
        errors.push(`レベル ${row.level} ですが親 (レベル ${row.level - 1}) が直前にありません`);
      } else {
        parentDbId = parent.row.id; // 親が既存 DB タスクのとき
        // 親が WP でない場合は ACT を子に持てない
        if (parent.row.type !== 'work_package') {
          errors.push(`親 "${parent.row.name}" がワークパッケージではありません (種別=${parent.row.type})`);
        }
      }
    }

    // 親スタック更新
    parentStack[row.level - 1] = { row, tempId };
    parentStack.length = row.level;

    // CSV 内 ID 重複
    if (row.id && duplicateIds.has(row.id)) {
      errors.push(`CSV 内で ID "${row.id}" が重複しています`);
    }
    // 同階層名称重複
    if (duplicateNamesAtLevel.has(`${row.level}::${row.name}`)) {
      errors.push(`同階層・同名のタスクが CSV 内に複数あります`);
    }

    // 担当者 lookup (ACT のみ採用、WP は assignee 不要)
    let resolvedAssigneeId: string | null = null;
    if (row.assigneeName && row.type === 'activity') {
      const candidates = membersByName.get(row.assigneeName);
      if (!candidates || candidates.length === 0) {
        errors.push(`担当者 "${row.assigneeName}" がプロジェクトメンバーに見つかりません`);
      } else if (candidates.length > 1) {
        errors.push(`担当者 "${row.assigneeName}" がプロジェクトメンバー内で複数該当します`);
      } else {
        resolvedAssigneeId = candidates[0].id;
      }
    }

    // ID 突合
    let action: SyncDiffAction = 'CREATE';
    let dbTask: DbTaskSnapshot | undefined;

    if (row.id) {
      dbTask = existingById.get(row.id);
      if (!dbTask) {
        errors.push(`ID "${row.id}" が DB に存在しません`);
      } else if (dbTask.projectId !== projectId) {
        errors.push(`ID "${row.id}" は別プロジェクトのタスクです`);
      } else {
        action = 'UPDATE';
        csvKeptIds.add(dbTask.id);

        // WP↔ACT 切替検知
        if (dbTask.type !== row.type) {
          errors.push(
            `種別を ${dbTask.type === 'work_package' ? 'WP' : 'ACT'} → ${row.type === 'work_package' ? 'WP' : 'ACT'} へ変更できません (削除→新規作成してください)`,
          );
        }
      }
    } else {
      // ID 不一致 (空欄) で名称一致をチェック (誤コピー検知)
      const sameName = existingByName.get(row.name);
      if (sameName && sameName.length > 0) {
        errors.push(
          `ID 空欄ですが同名のタスクが既存にあります (新規作成すると重複)。意図的なら ID 列に既存 ID を貼り付けるか、CSV 上で名称を変えてください`,
        );
      }
    }

    // UPDATE 時の field changes 計算
    if (action === 'UPDATE' && dbTask) {
      compareField(fieldChanges, 'name', dbTask.name, row.name);
      compareField(fieldChanges, 'wbsNumber', dbTask.wbsNumber, row.wbsNumber);
      // 親変更検知 (parentDbId は CSV 構造から復元)
      if ((dbTask.parentTaskId ?? null) !== (parentDbId ?? null)) {
        fieldChanges.push({
          field: 'parentTaskId',
          before: dbTask.parentTaskId,
          after: parentDbId,
        });
      }
      // 計画情報 (ACT のみ採用)
      if (row.type === 'activity') {
        compareField(fieldChanges, 'assigneeId', dbTask.assigneeId, resolvedAssigneeId);
        compareField(
          fieldChanges,
          'plannedStartDate',
          dateOnlyStr(dbTask.plannedStartDate),
          row.plannedStartDate,
        );
        compareField(
          fieldChanges,
          'plannedEndDate',
          dateOnlyStr(dbTask.plannedEndDate),
          row.plannedEndDate,
        );
        compareField(
          fieldChanges,
          'plannedEffort',
          Number(dbTask.plannedEffort),
          row.plannedEffort ?? Number(dbTask.plannedEffort),
        );
        compareField(fieldChanges, 'priority', dbTask.priority, row.priority);
        compareField(fieldChanges, 'isMilestone', dbTask.isMilestone, row.isMilestone);
      }
      compareField(fieldChanges, 'notes', dbTask.notes, row.notes);

      // 進捗系 read-only 警告
      if (row.csvStatus && row.csvStatus !== dbTask.status) {
        warnings.push(
          `ステータスが DB と異なります (CSV: "${row.csvStatus}" / DB: "${dbTask.status}") — 進捗系列は import で無視されます`,
        );
      }
      if (row.csvProgressRate != null && row.csvProgressRate !== dbTask.progressRate) {
        warnings.push(
          `進捗率が DB と異なります (CSV: ${row.csvProgressRate} / DB: ${dbTask.progressRate}) — import で無視されます`,
        );
      }
    }

    if (action === 'UPDATE' && fieldChanges.length === 0) {
      action = 'NO_CHANGE';
    }

    const errorCount = errors.length;
    const warningLevel: SyncDiffWarningLevel =
      errorCount > 0 ? 'ERROR' : warnings.length > 0 ? 'WARN' : 'INFO';

    result.rows.push({
      csvRow: row.tempRowIndex,
      id: dbTask?.id ?? null,
      tempId,
      action,
      name: row.name,
      fieldChanges: fieldChanges.length > 0 ? fieldChanges : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      errors: errors.length > 0 ? errors : undefined,
      warningLevel,
    });

    if (action === 'CREATE' && errorCount === 0) result.summary.added++;
    if (action === 'UPDATE' && errorCount === 0) result.summary.updated++;
    if (warnings.length > 0) result.summary.warnings += warnings.length;
    result.summary.blockedErrors += errorCount;
  }

  // 削除候補 (DB に存在するが CSV に出てこない ID)
  for (const t of existingTasks) {
    if (!csvKeptIds.has(t.id)) {
      const hasProgress = (t.progressRate ?? 0) > 0 || t.actualStartDate != null;
      result.rows.push({
        csvRow: null,
        id: t.id,
        tempId: null,
        action: 'REMOVE_CANDIDATE',
        name: t.name,
        hasProgress,
        warningLevel: hasProgress ? 'ERROR' : 'WARN',
        warnings: hasProgress
          ? undefined
          : ['CSV にこのタスクが含まれていません (削除モード次第で削除候補)'],
        errors: hasProgress
          ? ['CSV にこのタスクが含まれていません。進捗あり (削除モード=delete のとき blocker)']
          : undefined,
      });
      result.summary.removed++;
      // 進捗ありの REMOVE_CANDIDATE は削除モード=delete でのみブロック扱いになるが、
      // dry-run では canExecute は影響させない (確定実行時に removeMode を見て判定)
    }
  }

  // ブロッカーが 1 件でもあれば実行不可
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
// applySyncImport (本実行 + rollback)
// ============================================================

export type SyncImportResult = {
  added: number;
  updated: number;
  removed: number;
};

/**
 * dry-run 結果を踏まえて確定実行する。
 *
 * 流れ:
 *   1. computeSyncDiff を再実行して再 validation (CSV 改竄や DB 状態変動への保険)
 *   2. ブロッカーがあれば即エラー (canExecute=false 時は呼出側で 400 を返す想定)
 *   3. 削除候補のうち、進捗を持つタスクは removeMode='delete' 時にブロック
 *   4. 影響タスクの完全スナップショットを取得
 *   5. CREATE/UPDATE/DELETE を逐次実行
 *   6. 失敗時は 4 のスナップショットから復元
 *   7. 成功時は WP 集計を再計算
 *
 * @throws {Error} 'IMPORT_VALIDATION_ERROR:<msgs>' — 再 validation で blocker
 * @throws {Error} 'IMPORT_REMOVE_BLOCKED:<msgs>' — 進捗ありタスクの削除を要求された
 */
export async function applySyncImport(
  projectId: string,
  csvRows: SyncImportRow[],
  removeMode: RemoveMode,
  userId: string,
): Promise<SyncImportResult> {
  // 1. 再 validation
  const diff = await computeSyncDiff(projectId, csvRows);
  if (!diff.canExecute) {
    const msgs = [
      ...diff.globalErrors,
      ...diff.rows.flatMap((r) => (r.errors ?? []).map((e) => `行 ${r.csvRow ?? '-'}: ${e}`)),
    ];
    throw new Error(`IMPORT_VALIDATION_ERROR:${msgs.join('; ')}`);
  }

  // 2. 削除候補のうち、進捗を持つタスクは removeMode='delete' 時にブロック
  if (removeMode === 'delete') {
    const blockedRemovals = diff.rows.filter(
      (r) => r.action === 'REMOVE_CANDIDATE' && r.hasProgress,
    );
    if (blockedRemovals.length > 0) {
      throw new Error(
        `IMPORT_REMOVE_BLOCKED:進捗を持つタスクは削除モード=delete では消せません: ${blockedRemovals.map((r) => `"${r.name}"`).join(', ')}`,
      );
    }
  }

  // 3. 影響タスクの完全スナップショット (rollback 用)
  const snapshot = await prisma.task.findMany({
    where: { projectId, deletedAt: null },
  });
  const snapshotById = new Map(snapshot.map((t) => [t.id, t]));

  // 親解決のためのテンポラリ id マッピング (新規作成タスクの DB id を保持)
  const tempIdToDbId = new Map<string, string>();

  // 実行中に変更したタスク id を追跡 (rollback 用)
  const createdIds: string[] = [];
  const updatedIds: string[] = [];
  const softDeletedIds: string[] = [];

  // 親決定用に csvRows の level スタックを再構築
  const parentStackById = new Map<number, { tempId: string; csvId: string | null }>();

  try {
    // members lookup (担当者氏名→userId)
    const members = await prisma.projectMember.findMany({
      where: { projectId },
      include: { user: { select: { id: true, name: true } } },
    });
    const membersByName = new Map<string, string>();
    for (const m of members) {
      if (m.user) membersByName.set(m.user.name, m.user.id);
    }

    // CSV を level 順に処理 (親→子の順、computeSyncDiff と同じ走査)
    for (let i = 0; i < csvRows.length; i++) {
      const row = csvRows[i];
      const tempId = `csv_${row.tempRowIndex}`;

      // 親 ID 決定
      let parentTaskId: string | null = null;
      if (row.level > 1) {
        const parent = parentStackById.get(row.level - 1);
        if (parent) {
          // 親が既存 DB タスクなら csvId を使う、新規なら tempIdToDbId 経由
          parentTaskId = parent.csvId ?? tempIdToDbId.get(parent.tempId) ?? null;
        }
      }
      parentStackById.set(row.level, { tempId, csvId: row.id });
      // 深いレベルのスタックをクリア
      for (const k of Array.from(parentStackById.keys())) {
        if (k > row.level) parentStackById.delete(k);
      }

      const isActivity = row.type === 'activity';
      const resolvedAssigneeId = row.assigneeName ? membersByName.get(row.assigneeName) ?? null : null;

      const planData = {
        projectId,
        parentTaskId,
        type: row.type,
        wbsNumber: row.wbsNumber,
        name: row.name,
        category: 'other',
        assigneeId: isActivity ? resolvedAssigneeId : null,
        plannedStartDate: isActivity && row.plannedStartDate ? new Date(row.plannedStartDate) : null,
        plannedEndDate: isActivity && row.plannedEndDate ? new Date(row.plannedEndDate) : null,
        plannedEffort: isActivity ? (row.plannedEffort ?? 0) : 0,
        priority: isActivity ? (row.priority ?? 'medium') : null,
        isMilestone: isActivity ? row.isMilestone : false,
        notes: row.notes,
        updatedBy: userId,
      };

      if (row.id) {
        // UPDATE: CSV 由来の計画情報のみ更新 (進捗系は触らない)
        await prisma.task.update({
          where: { id: row.id },
          data: planData,
        });
        updatedIds.push(row.id);
        tempIdToDbId.set(tempId, row.id);
      } else {
        // CREATE: 進捗初期値で作成
        const created = await prisma.task.create({
          data: {
            ...planData,
            status: 'not_started',
            progressRate: 0,
            createdBy: userId,
          },
        });
        createdIds.push(created.id);
        tempIdToDbId.set(tempId, created.id);
      }
    }

    // 削除モード処理 (REMOVE_CANDIDATE)
    if (removeMode === 'delete') {
      for (const r of diff.rows) {
        if (r.action === 'REMOVE_CANDIDATE' && r.id && !r.hasProgress) {
          await prisma.task.update({
            where: { id: r.id },
            data: { deletedAt: new Date(), updatedBy: userId },
          });
          softDeletedIds.push(r.id);
        }
      }
    }

    // 成功時: WP 集計を再計算 (深い順、子→親で伝播)
    const wpIdsAffected = new Set<string>();
    for (const id of [...createdIds, ...updatedIds]) {
      const t = await prisma.task.findUnique({ where: { id }, select: { type: true, parentTaskId: true } });
      if (t?.type === 'work_package') wpIdsAffected.add(id);
      if (t?.parentTaskId) {
        const parent = await prisma.task.findUnique({
          where: { id: t.parentTaskId },
          select: { type: true },
        });
        if (parent?.type === 'work_package') wpIdsAffected.add(t.parentTaskId);
      }
    }
    for (const wpId of wpIdsAffected) {
      await recalculateAncestorsPublic(wpId);
    }

    return {
      added: createdIds.length,
      updated: updatedIds.length,
      removed: softDeletedIds.length,
    };
  } catch (e) {
    // rollback: snapshot から完全復元
    await rollbackToSnapshot(snapshot, snapshotById, createdIds, updatedIds, softDeletedIds, userId);
    throw e;
  }
}

/**
 * apply 中にエラーが起きた際、snapshot 時点に復元する。
 *
 * 復元手順:
 *   - 本処理で作成したタスクは物理削除
 *   - 本処理で UPDATE したタスクは snapshot から完全復元 (全列)
 *   - 本処理で論理削除したタスクは deletedAt=null に戻す
 */
async function rollbackToSnapshot(
  snapshot: Awaited<ReturnType<typeof prisma.task.findMany>>,
  snapshotById: Map<string, (typeof snapshot)[number]>,
  createdIds: string[],
  updatedIds: string[],
  softDeletedIds: string[],
  userId: string,
): Promise<void> {
  // 1. 作成済を物理削除
  if (createdIds.length > 0) {
    await prisma.task.deleteMany({ where: { id: { in: createdIds } } });
  }
  // 2. UPDATE 済を復元
  for (const id of updatedIds) {
    const orig = snapshotById.get(id);
    if (!orig) continue;
    await prisma.task.update({
      where: { id },
      data: {
        parentTaskId: orig.parentTaskId,
        type: orig.type,
        wbsNumber: orig.wbsNumber,
        name: orig.name,
        description: orig.description,
        category: orig.category,
        assigneeId: orig.assigneeId,
        plannedStartDate: orig.plannedStartDate,
        plannedEndDate: orig.plannedEndDate,
        actualStartDate: orig.actualStartDate,
        actualEndDate: orig.actualEndDate,
        plannedEffort: orig.plannedEffort,
        priority: orig.priority,
        status: orig.status,
        progressRate: orig.progressRate,
        isMilestone: orig.isMilestone,
        notes: orig.notes,
        updatedBy: userId,
      },
    });
  }
  // 3. 論理削除を巻き戻し
  if (softDeletedIds.length > 0) {
    await prisma.task.updateMany({
      where: { id: { in: softDeletedIds } },
      data: { deletedAt: null, updatedBy: userId },
    });
  }
}
