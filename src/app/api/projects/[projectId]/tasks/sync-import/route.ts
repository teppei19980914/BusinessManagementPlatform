/**
 * POST /api/projects/[projectId]/tasks/sync-import — WBS 上書きインポート (Sync by ID)
 *
 * 役割:
 *   既存 WBS の「export → Excel 編集 → re-import」往復編集サイクルで管理。
 *   ?dryRun=1 でプレビュー (副作用なし)、無しで本実行。
 *
 * 認可:
 *   task:update + task:delete (= PM/TL + admin) を要求。
 *   削除候補の存在に関わらず両権限を要求し、フローの一貫性を保つ。
 *
 * 監査:
 *   本実行成功時に audit_logs (action='SYNC_IMPORT', entityType='wbs_sync_import',
 *   entityId=projectId, afterValue=サマリ) を 1 件追加。
 *
 * Runtime: Node.js (Edge では Prisma が動かない + body サイズ制限のため)。
 *
 * 関連:
 *   - DESIGN.md §33 (WBS 上書きインポート設計)
 *   - SPECIFICATION.md WBS 上書きインポート仕様
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import {
  parseSyncImportCsv,
  computeSyncDiff,
  applySyncImport,
  TASK_SYNC_IMPORT_MAX_ROWS,
  type RemoveMode,
} from '@/services/task-sync-import.service';
import { recordAuditLog } from '@/services/audit.service';
import { logUnknownError } from '@/services/error-log.service';
import { checkCsvSize, checkCsvRowCount, handleCsvParseError } from '@/lib/csv-import-helpers';
import { runImportStoragePrecheck } from '@/services/import-storage-precheck.service';
import {
  assertStorageLimitInTx,
  // ADR-0025 (2026-05-29): Beginner プラン超過時の専用エラーマッパー
  // 2026-05-31: 50GB 累積ハードキャップ (StorageLimitExceededError / mapStorageGuardErrorToResponse) は撤去 (ADR-0030)
  mapBeginnerWriteGuardErrorToResponse,
} from '@/services/storage-guard.service';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;

  // 認可: 上書きは task:update + task:delete (= PM/TL + admin) 必須
  const updateForbidden = await checkProjectPermission(user, projectId, 'task:update');
  if (updateForbidden) return updateForbidden;
  const deleteForbidden = await checkProjectPermission(user, projectId, 'task:delete');
  if (deleteForbidden) return deleteForbidden;

  const t = await getTranslations('message');

  // dryRun フラグ
  const url = new URL(req.url);
  const isDryRun = url.searchParams.get('dryRun') === '1';

  // multipart/form-data で CSV ファイルと removeMode を受け取る
  let csvText = '';
  let removeMode: RemoveMode = 'keep';
  try {
    const formData = await req.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: t('fileFieldRequired') } },
        { status: 400 },
      );
    }
    csvText = await file.text();

    const removeModeRaw = formData.get('removeMode');
    if (typeof removeModeRaw === 'string') {
      if (removeModeRaw === 'keep' || removeModeRaw === 'warn' || removeModeRaw === 'delete') {
        removeMode = removeModeRaw;
      } else {
        return NextResponse.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: t('removeModeInvalid'),
            },
          },
          { status: 400 },
        );
      }
    }
  } catch (e) {
    await logUnknownError('server', e, {
      userId: user.id,
      context: { path: 'POST /api/projects/[id]/tasks/sync-import', stage: 'body-parse', isDryRun },
    });
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: t('requestBodyUnreadable') } },
      { status: 400 },
    );
  }

  // BOM 除去
  csvText = csvText.replace(/^﻿/, '').trim();
  if (!csvText) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: t('csvDataEmptyAlt') } },
      { status: 400 },
    );
  }

  // fix/csv-import-multiline-text-data-loss 2 巡目: DoS 緩和 + csv-parse throw の 400 化
  const sizeError = checkCsvSize(csvText, t);
  if (sizeError) return sizeError;

  // CSV パース ([A3] ヘッダー検証は parser 内で実施し、errors を computeSyncDiff に伝搬)
  let csvRows;
  let headerErrors;
  try {
    const parsed = parseSyncImportCsv(csvText);
    csvRows = parsed.rows;
    headerErrors = parsed.headerErrors;
  } catch (e) {
    const parseErr = handleCsvParseError(e, t);
    if (parseErr) return parseErr;
    throw e;
  }
  // 2026-05-28 フルスキャン 2 巡目: parse 後の行数を明示的に上限判定 (DoS 緩和)。
  //   ADR-0032 (2026-06-04): 業務上限 (旧 500 件) は撤廃し、ここでは DoS 安全弁としての
  //   高め上限 (TASK_SYNC_IMPORT_MAX_ROWS) のみ適用。目安超過は dry-run の globalWarnings で案内。
  const rowCountError = checkCsvRowCount(csvRows.length, t, TASK_SYNC_IMPORT_MAX_ROWS);
  if (rowCountError) return rowCountError;

  // 4 巡目フルスキャン: DB 容量事前判定 (Beginner block / Expert-Pro warning)
  const newRowCount = csvRows.filter((r) => !r.id).length;
  const storage = await runImportStoragePrecheck({
    tenantId: user.tenantId,
    entity: 'task',
    newRowCount,
  });
  if (storage.isBlocker && storage.errorBody) {
    return NextResponse.json(storage.errorBody, { status: 403 });
  }

  if (isDryRun) {
    // dry-run: diff を計算して返す (副作用なし)
    const diff = await computeSyncDiff(projectId, csvRows, user.tenantId, { headerErrors });
    return NextResponse.json({ data: { ...diff, storagePrecheck: storage.precheck } });
  }

  // 本実行 ([C2] OCC: dry-run の snapshotAt と本実行時点を比較するため、UI から渡された snapshot を受領)
  const expectedSnapshotAt = (() => {
    const raw = (req.headers.get('x-import-snapshot-at') ?? '').trim();
    return raw || undefined;
  })();
  try {
    const result = await applySyncImport(
      projectId,
      csvRows,
      removeMode,
      user.id,
      user.tenantId,
      { headerErrors, expectedSnapshotAt },
    );
    // apply 後の post-check (peak 計測 + Beginner 無料枠。2026-05-31: 50GB 累積ハードキャップは撤去 ADR-0030)
    try {
      await prisma.$transaction(
        async (tx) => assertStorageLimitInTx(tx, user.tenantId),
        { timeout: 10_000 },
      );
    } catch (storageErr) {
      // ADR-0025: Beginner プラン超過エラーは専用 UX 文言で応答 (データは既にコミット済)
      const beginnerMapped = mapBeginnerWriteGuardErrorToResponse(storageErr);
      if (beginnerMapped) return NextResponse.json(beginnerMapped.body, { status: beginnerMapped.status });
      // 2026-05-31: 50GB 累積ハードキャップ撤去 (ADR-0030)。peak 計測失敗 (fail-open) は
      //   storage-guard 内で記録済 + 日次 cron が補正するため握りつぶす。
    }

    await recordAuditLog({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'SYNC_IMPORT',
      entityType: 'wbs_sync_import',
      entityId: projectId,
      afterValue: { removeMode, ...result },
    });

    return NextResponse.json({ data: result }, { status: 200 });
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('IMPORT_VALIDATION_ERROR:')) {
      return NextResponse.json(
        {
          error: {
            code: 'IMPORT_VALIDATION_ERROR',
            message: e.message.replace('IMPORT_VALIDATION_ERROR:', ''),
          },
        },
        { status: 400 },
      );
    }
    if (e instanceof Error && e.message.startsWith('IMPORT_REMOVE_BLOCKED:')) {
      return NextResponse.json(
        {
          error: {
            code: 'IMPORT_REMOVE_BLOCKED',
            message: e.message.replace('IMPORT_REMOVE_BLOCKED:', ''),
          },
        },
        { status: 400 },
      );
    }
    // [C2] OCC: dry-run 後に並行編集が検出された
    if (e instanceof Error && e.message.startsWith('IMPORT_CONCURRENT_EDIT:')) {
      return NextResponse.json(
        {
          error: {
            code: 'IMPORT_CONCURRENT_EDIT',
            message: e.message.replace('IMPORT_CONCURRENT_EDIT:', ''),
          },
        },
        { status: 409 },
      );
    }

    await logUnknownError('server', e, {
      userId: user.id,
      context: { path: 'POST /api/projects/[id]/tasks/sync-import', stage: 'apply', removeMode },
    });
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: t('internalError') } },
      { status: 500 },
    );
  }
}
