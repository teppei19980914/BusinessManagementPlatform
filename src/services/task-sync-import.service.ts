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
import { parseCsvText, recalculateAncestorsPublic } from './task.service';

// ============================================================
// 型定義
// ============================================================

/**
 * CSV から解析した 1 行 (T-19 で 7 列に削減)。tempRowIndex は CSV 上の元の行番号 (1 始まり)。
 *
 * 列構成 (WBS_CSV_HEADERS と同じ):
 *   ID / 種別 / 名称 / レベル / 予定開始日 / 予定終了日 / 予定工数
 *
 * 担当者 / 優先度 / マイルストーン / 備考 / WBS 番号 / 進捗系列は CSV 経由で扱わない。
 * (CSV 編集の用途を「計画調整」に絞り、それ以外は UI 個別編集に集約)
 */
export type SyncImportRow = {
  tempRowIndex: number;
  /** ID 列の値。空欄なら null (= 新規作成扱い)。 */
  id: string | null;
  level: number;
  type: 'work_package' | 'activity';
  name: string;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  plannedEffort: number | null;
  /**
   * CSV 上の親行 tempRowIndex (level スタックから決定)。root (level=1) は null。
   *
   * 重複判定・誤コピー検知を「同階層 (= 同一親配下)」のスコープで行うために必要。
   * 親が直前に無い不正 CSV の場合も null (エラーは別途 computeSyncDiff で surface)。
   */
  parentRowIndex: number | null;
};

/**
 * WBS sync-import の正式ヘッダー (T-19 で 7 列に削減)。先頭 4 列は必須、後 3 列は順序固定。
 *
 * parseSyncImportCsv はこのヘッダーと完全一致しない場合 globalErrors として返す。
 * 列順違い・列不足を silent skip すると「データ 0 件」になり原因がわからないため。
 */
export const WBS_SYNC_CSV_HEADERS = [
  'ID',
  '種別',
  '名称',
  'レベル',
  '予定開始日',
  '予定終了日',
  '予定工数',
] as const;

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
  /**
   * 2026-05-21 [C2] OCC: dry-run 時点での影響範囲 (project 配下 task 最大 updatedAt)。
   * apply 時に再取得した値と比較し、ずれていれば「並行編集検出」で blocker 化する。
   */
  snapshotAt?: string | null;
};

/**
 * 2026-05-21 [A3] CSV パーサが返すヘッダー検証結果。
 * parser からの globalErrors を computeSyncDiff 側に伝搬するためのオプション情報。
 */
export type ParseSyncImportResult = {
  rows: SyncImportRow[];
  /** ヘッダー検証 / 致命的パースエラー。空でなければ row は使うべきでない。 */
  headerErrors: string[];
};

export type RemoveMode = 'keep' | 'warn' | 'delete';

// ============================================================
// CSV パース
// ============================================================

/**
 * 7 列 CSV を解析して { rows, headerErrors } を返す (T-19 で 17 列から削減)。
 *
 * - 1 行目はヘッダー。**列順・列名を厳格チェック** し、不一致は headerErrors に追加。
 *   ([A3] 旧実装は header を素通しで silent skip しており、ユーザに原因が伝わらなかった)
 * - 列順: ID / 種別 / 名称 / レベル / 予定開始日 / 予定終了日 / 予定工数
 * - データ行: 短い行 / 名称空欄 / レベル不正 はスキップ。長い行は余分列を無視。
 * - **parentRowIndex** を level スタックから決定 ([A1] 同階層名称重複判定を「同一親配下」スコープで行うため)。
 *
 * @returns rows: 有効データ行 (header エラー時も部分的に返す), headerErrors: ヘッダー不正の説明文
 */
export function parseSyncImportCsv(csvText: string): ParseSyncImportResult {
  // fix/csv-import-multiline-text-data-loss: WBS の「名称」列にユーザが改行を含めても
  //   silent に欠落しないよう、RFC 4180 準拠の parseCsvText に統一。
  //   旧 split 方式は他 4 entity 同様にデータロスを起こす可能性があった。
  const records = parseCsvText(csvText);
  if (records.length < 1) {
    return { rows: [], headerErrors: ['CSV が空です'] };
  }

  // ============================================================
  // [A3] ヘッダー検証 (列順・列名)
  // ============================================================
  const headerFields = records[0].map((s) => s.trim());
  const headerErrors: string[] = [];

  // 列数チェック (最低 4 列, 推奨 7 列)
  if (headerFields.length < 4) {
    headerErrors.push(
      `CSV ヘッダーの列数が不足しています (${headerFields.length} 列, 最低 4 列必要)。期待: ${WBS_SYNC_CSV_HEADERS.join(',')}`,
    );
  }

  // 列名チェック (必須 4 列は厳格、後 3 列は順序チェックのみ)
  const REQUIRED_HEADER_COUNT = 4;
  for (let i = 0; i < Math.min(headerFields.length, WBS_SYNC_CSV_HEADERS.length); i++) {
    const expected = WBS_SYNC_CSV_HEADERS[i];
    const actual = headerFields[i];
    if (actual !== expected) {
      const isRequired = i < REQUIRED_HEADER_COUNT;
      headerErrors.push(
        `${i + 1} 列目のヘッダーが "${actual}" ですが "${expected}" を期待しています${isRequired ? ' (必須)' : ''}`,
      );
    }
  }

  if (records.length < 2) {
    return { rows: [], headerErrors };
  }

  const dataRecords = records.slice(1);
  const rows: SyncImportRow[] = [];

  // [A1] parentRowIndex を埋めるための level スタック
  // stack[level-1] = 該当 level の最新行の tempRowIndex
  const parentStack: number[] = [];

  for (let i = 0; i < dataRecords.length; i++) {
    const fields = dataRecords[i];
    // ID + 種別 + 名称 + レベル (= 4 列) は最低限必要
    if (fields.length < 4) continue;

    const csvRowIndex = i + 2; // ヘッダー行 + 0 始まり補正

    const idRaw = (fields[0] ?? '').trim();
    const id = idRaw.length > 0 ? idRaw : null;

    const typeRaw = (fields[1] ?? '').trim();
    const type = typeRaw === 'WP' ? 'work_package' : 'activity';

    const name = (fields[2] ?? '').trim();
    if (!name) continue;

    const level = parseInt(fields[3], 10);
    if (isNaN(level) || level < 1) continue;

    const plannedStartDate = (fields[4] ?? '').trim() || null;
    const plannedEndDate = (fields[5] ?? '').trim() || null;
    const plannedEffortStr = (fields[6] ?? '').trim();
    const plannedEffort = plannedEffortStr ? parseFloat(plannedEffortStr) : null;

    // [A1] parentRowIndex 決定: level=1 は null, それ以外は stack[level-2]
    //   親が直前に無い不正 CSV (level=3 だが level=2 が無い等) は null としておき、
    //   computeSyncDiff 側で「親不在」エラーを surface する (既存の挙動を維持)
    const parentRowIndex = level > 1 ? (parentStack[level - 2] ?? null) : null;

    // スタック更新: 自分の level を上書き、深いレベルは破棄
    parentStack[level - 1] = csvRowIndex;
    parentStack.length = level;

    rows.push({
      tempRowIndex: csvRowIndex,
      id,
      level,
      type,
      name,
      plannedStartDate,
      plannedEndDate,
      plannedEffort: plannedEffort != null && !isNaN(plannedEffort) ? plannedEffort : null,
      parentRowIndex,
    });
  }

  return { rows, headerErrors };
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
 *   - ヘッダー不正 ([A3], options.headerErrors 経由)
 *   - 親不在 (level=N の親が直前のスタックに無い)
 *   - WP↔ACT 切替 (既存 type と CSV type の不一致)
 *   - ID 不一致だが「同一親配下に同名」のタスクが既存 (誤コピー検知, [A2])
 *   - CSV 内 ID 重複 / 同一親配下の名称重複 ([A1])
 *   - DB に存在しない ID を指定 (typo 等)
 *   - 循環参照 (CSV の new parent 指定が DB の旧子孫経由で自分に戻る, [A4])
 */
export async function computeSyncDiff(
  projectId: string,
  csvRows: SyncImportRow[],
  viewerTenantId: string,
  options?: { headerErrors?: string[] },
): Promise<SyncDiffResult> {
  const result: SyncDiffResult = {
    summary: { added: 0, updated: 0, removed: 0, blockedErrors: 0, warnings: 0 },
    rows: [],
    canExecute: true,
    globalErrors: [],
    snapshotAt: null,
  };

  // [A3] ヘッダーエラーは globalErrors に伝搬し、ブロッカー化
  if (options?.headerErrors && options.headerErrors.length > 0) {
    result.globalErrors.push(...options.headerErrors);
    result.canExecute = false;
    // ヘッダー不正でも以降の検査は続ける (ユーザに同時にデータエラーも見せるため) 。
    // ただし「ヘッダー直しなしには進めない」のは canExecute=false で表現済。
  }

  // 2026-05-10 feedback Phase 2-8: 越境 sync-import を遮断するため projectId のテナント検証。
  //   旧仕様は projectId 直叩きで他テナントの WBS を import 可能だった severity-1 バグ。
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

  // DB 既存タスクを取得 (T-19: 担当者は CSV で扱わないので member lookup 不要)
  // Task は tenantId 列を持たないが、projectId が viewerTenantId 配下にあることを上で確認済。
  const existingTasks = await prisma.task.findMany({
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
      updatedAt: true,
    },
  });

  // [C2] OCC: project 配下 task の最大 updatedAt を snapshot として記録。apply 時に再取得して
  //   ずれていれば「並行編集が発生」として blocker 化する (PgBouncer 制約で advisory lock 不可)。
  result.snapshotAt = existingTasks.reduce<string | null>((acc, t) => {
    const u = (t as { updatedAt?: Date }).updatedAt;
    if (!u) return acc;
    const iso = u.toISOString();
    return acc == null || iso > acc ? iso : acc;
  }, null);

  const existingById = new Map(existingTasks.map((t) => [t.id, t as DbTaskSnapshot]));

  // [A2] DB 既存タスクを (parentTaskId ?? 'root', name) でインデックス。
  //   旧実装は name のみで「別 WP 配下の既存同名」も誤コピー判定していた過剰制限を解消。
  const parentScopeKey = (parentTaskId: string | null, name: string): string =>
    `${parentTaskId ?? '__root__'}::${name}`;
  const existingByParentAndName = new Map<string, DbTaskSnapshot[]>();
  for (const t of existingTasks) {
    const key = parentScopeKey(t.parentTaskId, t.name);
    const arr = existingByParentAndName.get(key) ?? [];
    arr.push(t as DbTaskSnapshot);
    existingByParentAndName.set(key, arr);
  }

  // CSV 内の ID 重複検知
  const csvIdCounts = new Map<string, number>();
  for (const r of csvRows) {
    if (r.id) csvIdCounts.set(r.id, (csvIdCounts.get(r.id) ?? 0) + 1);
  }
  const duplicateIds = new Set([...csvIdCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id));

  // [A1] 同一親配下の名称重複検知 (旧 level+name → parentRowIndex+name)
  //   別 WP 配下に同名 ACT を作る正当なユースケースを誤って弾かない。
  const csvNameByParentCounts = new Map<string, number>();
  for (const r of csvRows) {
    const key = `${r.parentRowIndex ?? '__root__'}::${r.name}`;
    csvNameByParentCounts.set(key, (csvNameByParentCounts.get(key) ?? 0) + 1);
  }
  const duplicateNamesUnderSameParent = new Set(
    [...csvNameByParentCounts.entries()].filter(([, c]) => c > 1).map(([k]) => k),
  );

  // [A2] CSV 行を tempRowIndex でルックアップできるよう Map 化 (誤コピー検知・循環検出で使用)
  const csvRowByTempIndex = new Map<number, SyncImportRow>();
  for (const r of csvRows) csvRowByTempIndex.set(r.tempRowIndex, r);

  // [A2] 各 CSV 行の「import 完了後の新 parentTaskId」を解決する。
  //   - 親が CSV 内 UPDATE 行 (id あり): その id
  //   - 親が CSV 内 CREATE 行 (id 無し): null を返す (DB id 未確定。誤コピー検知は parent 不明でスキップ)
  //   - root (parentRowIndex=null): null
  function resolveNewParentDbId(row: SyncImportRow): {
    parentDbId: string | null;
    parentIsCsvCreate: boolean;
  } {
    if (row.parentRowIndex == null) return { parentDbId: null, parentIsCsvCreate: false };
    const parent = csvRowByTempIndex.get(row.parentRowIndex);
    if (!parent) return { parentDbId: null, parentIsCsvCreate: false };
    if (parent.id) return { parentDbId: parent.id, parentIsCsvCreate: false };
    return { parentDbId: null, parentIsCsvCreate: true };
  }

  // 親決定用のスタック (level → 該当タスクの tempRowIndex / 行)
  //   parser 側の parentRowIndex と冗長だが、parent.row.type / .name を error message に出すため残す。
  const parentStack: { row: SyncImportRow; tempId: string }[] = [];
  // 各行に tempId を割り当て (UI での参照キー用)
  const tempIdByRow = new Map<SyncImportRow, string>();

  // CSV から「このインポートで生き残るタスク id」の集合を作る (REMOVE_CANDIDATE 検出用)
  const csvKeptIds = new Set<string>();

  // [A4] 循環参照チェック: CSV の parent は level スタック由来 (= CSV 上の上位行) のため、
  //   CSV 内チェーンは sequentially acyclic、自己参照も ID 重複ブロッカーで既に弾かれる。
  //   よって本実装の CSV→tree 変換では構造的に閉路が形成不能。spec の「循環参照」言及は
  //   旧 parentTaskId 列直指定方式を想定した defensive 文言と判断し、追加コードは不要とする。

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
        errors.push(
          `レベル ${row.level} のタスクですが、親となるレベル ${row.level - 1} の行が直前にありません。CSV 上で親行 (WP) を上の行に配置してください。`,
        );
      } else {
        parentDbId = parent.row.id; // 親が既存 DB タスクのとき
        // 親が WP でない場合は ACT を子に持てない
        if (parent.row.type !== 'work_package') {
          errors.push(
            `親「${parent.row.name}」がワークパッケージ (WP) ではありません (種別=${parent.row.type})。ACT (作業) は WP の配下にのみ作成できます。`,
          );
        }
      }
    }

    // 親スタック更新
    parentStack[row.level - 1] = { row, tempId };
    parentStack.length = row.level;

    // CSV 内 ID 重複
    if (row.id && duplicateIds.has(row.id)) {
      errors.push(
        `CSV 内に同じ ID「${row.id}」を持つ行が複数あります。意図的に複製したい場合は ID 列を空欄にして新規作成扱いにしてください。`,
      );
    }
    // [A1] 同一親配下の名称重複 (旧 level+name → parentRowIndex+name)
    // fix/list-export-import-bugs (2026-05-26): ID が一意なら別エンティティとして許容できるため
    //   error → warning にダウングレード (canExecute をブロックしない)。
    if (duplicateNamesUnderSameParent.has(`${row.parentRowIndex ?? '__root__'}::${row.name}`)) {
      warnings.push(`同一親配下に同じ名称のタスクが CSV 内に複数あります (ID が異なれば別タスクとして取り込まれます)`);
    }

    // ID 突合
    let action: SyncDiffAction = 'CREATE';
    let dbTask: DbTaskSnapshot | undefined;

    if (row.id) {
      dbTask = existingById.get(row.id);
      if (!dbTask) {
        errors.push(
          `ID「${row.id}」のタスクがこのプロジェクトに存在しません。ID 列を空欄にして新規作成するか、正しい ID に修正してください。`,
        );
      } else if (dbTask.projectId !== projectId) {
        errors.push(
          `ID「${row.id}」は別プロジェクトのタスクです。このプロジェクトでは ID 列を空欄にして新規作成してください。`,
        );
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
      // [A2] ID 不一致 (空欄) で「同一親配下の同名」をチェック (誤コピー検知)
      //   旧実装は project 全体スコープで「他 WP 配下の同名」も誤検知していた。
      // fix/list-export-import-bugs (2026-05-26): error → warning にダウングレード。
      //   ID が一意なら別エンティティとして許容できるため canExecute をブロックしない。
      const resolved = resolveNewParentDbId(row);
      if (!resolved.parentIsCsvCreate) {
        const sameName = existingByParentAndName.get(parentScopeKey(resolved.parentDbId, row.name));
        if (sameName && sameName.length > 0) {
          warnings.push(
            `同一親配下に同名のタスクが既存にあります。ID 空欄のため新規 ID で作成されます (同名の別タスクが追加で作成されます)`,
          );
        }
      }
      // resolved.parentIsCsvCreate=true (親が CSV の新規 CREATE) のときは DB に親が無いので照合不要
    }

    // UPDATE 時の field changes 計算 (T-19: 7 列のみ比較)
    if (action === 'UPDATE' && dbTask) {
      compareField(fieldChanges, 'name', dbTask.name, row.name);
      // 親変更検知 (parentDbId は CSV 構造から復元)
      if ((dbTask.parentTaskId ?? null) !== (parentDbId ?? null)) {
        fieldChanges.push({
          field: 'parentTaskId',
          before: dbTask.parentTaskId,
          after: parentDbId,
        });
      }
      // 計画情報 (ACT のみ反映)
      if (row.type === 'activity') {
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
 *   2. [C2] OCC: dry-run の snapshotAt と再計算結果の snapshotAt がずれていれば「並行編集」として中断
 *   3. ブロッカーがあれば即エラー (canExecute=false 時は呼出側で 400 を返す想定)
 *   4. 削除候補のうち、進捗を持つタスクは removeMode='delete' 時にブロック
 *   5. 影響タスクの完全スナップショットを取得
 *   6. CREATE/UPDATE/DELETE を逐次実行
 *   7. 失敗時は 5 のスナップショットから復元
 *   8. 成功時は WP 集計を再計算
 *
 * @throws {Error} 'IMPORT_VALIDATION_ERROR:<msgs>' — 再 validation で blocker
 * @throws {Error} 'IMPORT_REMOVE_BLOCKED:<msgs>' — 進捗ありタスクの削除を要求された
 * @throws {Error} 'IMPORT_CONCURRENT_EDIT:<msgs>' — dry-run 後に別ユーザが該当 project の task を更新した
 */
export async function applySyncImport(
  projectId: string,
  csvRows: SyncImportRow[],
  removeMode: RemoveMode,
  userId: string,
  viewerTenantId: string,
  options?: { headerErrors?: string[]; expectedSnapshotAt?: string },
): Promise<SyncImportResult> {
  // 1. 再 validation (computeSyncDiff 側でテナント検証も実施、headerErrors も伝搬)
  const diff = await computeSyncDiff(projectId, csvRows, viewerTenantId, {
    headerErrors: options?.headerErrors,
  });
  if (!diff.canExecute) {
    const msgs = [
      ...diff.globalErrors,
      ...diff.rows.flatMap((r) => (r.errors ?? []).map((e) => `行 ${r.csvRow ?? '-'}: ${e}`)),
    ];
    throw new Error(`IMPORT_VALIDATION_ERROR:${msgs.join('; ')}`);
  }

  // 2. [C2] OCC: dry-run と本実行の間に別ユーザが project 配下 task を更新していないか確認。
  //   PgBouncer 制約で advisory lock が使えないため、updatedAt の最大値の一致で代替する。
  //   client が snapshotAt header を送らなかった場合 (旧 UI 等) はスキップ (best-effort)。
  if (options?.expectedSnapshotAt && diff.snapshotAt && options.expectedSnapshotAt !== diff.snapshotAt) {
    throw new Error(
      `IMPORT_CONCURRENT_EDIT:他のユーザがこのプロジェクトのタスクを更新しました。最新状態を確認してから再度インポートしてください (dry-run snapshot=${options.expectedSnapshotAt}, current=${diff.snapshotAt})`,
    );
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
    // CSV を level 順に処理 (親→子の順、computeSyncDiff と同じ走査)
    // T-19: 担当者 / 優先度 / マイルストーン / 備考 / WBS 番号は CSV で扱わない。
    //   UPDATE 時は DB 既存値を保持、CREATE 時はデフォルト値を設定。
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

      if (row.id) {
        // UPDATE: 7 列分のみ更新 (担当者/優先度等は DB 既存値を保持)
        const updateData: Record<string, unknown> = {
          parentTaskId,
          type: row.type,
          name: row.name,
          updatedBy: userId,
        };
        if (isActivity) {
          updateData.plannedStartDate = row.plannedStartDate ? new Date(row.plannedStartDate) : null;
          updateData.plannedEndDate = row.plannedEndDate ? new Date(row.plannedEndDate) : null;
          updateData.plannedEffort = row.plannedEffort ?? 0;
        }
        await prisma.task.update({ where: { id: row.id }, data: updateData });
        updatedIds.push(row.id);
        tempIdToDbId.set(tempId, row.id);
      } else {
        // CREATE: 7 列 + デフォルト値で作成 (担当者/優先度/マイルストーン/備考は UI で個別設定)
        const created = await prisma.task.create({
          data: {
            projectId,
            parentTaskId,
            type: row.type,
            name: row.name,
            category: 'other',
            assigneeId: null,
            plannedStartDate: isActivity && row.plannedStartDate ? new Date(row.plannedStartDate) : null,
            plannedEndDate: isActivity && row.plannedEndDate ? new Date(row.plannedEndDate) : null,
            plannedEffort: isActivity ? (row.plannedEffort ?? 0) : 0,
            priority: isActivity ? 'medium' : null,
            isMilestone: false,
            status: 'not_started',
            progressRate: 0,
            createdBy: userId,
            updatedBy: userId,
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
    // rollback: snapshot から完全復元 (2026-05-12 severity-1 防御: projectId を渡して project.tenantId 検証)
    await rollbackToSnapshot(
      snapshot,
      snapshotById,
      createdIds,
      updatedIds,
      softDeletedIds,
      userId,
      projectId,
      viewerTenantId,
    );
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
 *
 * 2026-05-12 severity-1 防御: Task は tenantId 列を持たないが、`project: { tenantId }` リレーション
 *   フィルタで自テナント所属 project の task のみに絞る。
 */
async function rollbackToSnapshot(
  snapshot: Awaited<ReturnType<typeof prisma.task.findMany>>,
  snapshotById: Map<string, (typeof snapshot)[number]>,
  createdIds: string[],
  updatedIds: string[],
  softDeletedIds: string[],
  userId: string,
  projectId: string,
  viewerTenantId: string,
): Promise<void> {
  // 1. 作成済を物理削除 (project が自テナント所属であることを併記)
  if (createdIds.length > 0) {
    await prisma.task.deleteMany({
      where: {
        id: { in: createdIds },
        projectId,
        project: { tenantId: viewerTenantId },
      },
    });
  }
  // 2. UPDATE 済を復元
  for (const id of updatedIds) {
    const orig = snapshotById.get(id);
    if (!orig) continue;
    await prisma.task.updateMany({
      where: { id, projectId, project: { tenantId: viewerTenantId } },
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
      where: {
        id: { in: softDeletedIds },
        projectId,
        project: { tenantId: viewerTenantId },
      },
      data: { deletedAt: null, updatedBy: userId },
    });
  }
}
