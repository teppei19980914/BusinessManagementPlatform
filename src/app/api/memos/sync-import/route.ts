/**
 * POST /api/memos/sync-import — メモ 上書きインポート (T-22 Phase 22d)
 *
 * 認可: 認証済ユーザのみ (自分のメモのみ対象 = user-scoped)
 * Runtime: Node.js
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import {
  parseMemoSyncImportCsv,
  computeMemoSyncDiff,
  applyMemoSyncImport,
  type RemoveMode,
} from '@/services/memo-sync-import.service';
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

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const t = await getTranslations('message');
  const url = new URL(req.url);
  const isDryRun = url.searchParams.get('dryRun') === '1';

  let csvText = '';
  let removeMode: RemoveMode = 'keep';
  try {
    const formData = await req.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: t('fileFieldRequired') } }, { status: 400 });
    }
    csvText = await file.text();

    const removeModeRaw = formData.get('removeMode');
    if (typeof removeModeRaw === 'string') {
      if (removeModeRaw === 'keep' || removeModeRaw === 'warn' || removeModeRaw === 'delete') {
        removeMode = removeModeRaw;
      } else {
        return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: t('removeModeInvalid') } }, { status: 400 });
      }
    }
  } catch (e) {
    await logUnknownError('server', e, {
      userId: user.id,
      context: { path: 'POST /api/memos/sync-import', stage: 'body-parse', isDryRun },
    });
    return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: t('requestBodyUnreadable') } }, { status: 400 });
  }

  csvText = csvText.replace(/^﻿/, '').trim();
  if (!csvText) {
    return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: t('csvDataEmptyAlt') } }, { status: 400 });
  }

  // fix/csv-import-multiline-text-data-loss 2 巡目: DoS 緩和 + csv-parse throw の 400 化
  const sizeError = checkCsvSize(csvText, t);
  if (sizeError) return sizeError;

  let csvRows;
  try {
    csvRows = parseMemoSyncImportCsv(csvText);
  } catch (e) {
    const parseErr = handleCsvParseError(e, t);
    if (parseErr) return parseErr;
    throw e;
  }
  // 2026-05-28 フルスキャン 2 巡目: parse 後の行数を明示的に上限判定 (DoS 緩和 + UX)
  const rowCountError = checkCsvRowCount(csvRows.length, t);
  if (rowCountError) return rowCountError;

  // 4 巡目フルスキャン: DB 容量事前判定 (Beginner block / Expert-Pro warning)
  const newRowCount = csvRows.filter((r) => !r.id).length;
  const storage = await runImportStoragePrecheck({
    tenantId: user.tenantId,
    entity: 'memo',
    newRowCount,
  });
  if (storage.isBlocker && storage.errorBody) {
    return NextResponse.json(storage.errorBody, { status: 403 });
  }

  if (isDryRun) {
    const diff = await computeMemoSyncDiff(user.id, csvRows, user.tenantId);
    return NextResponse.json({ data: { ...diff, storagePrecheck: storage.precheck } });
  }

  try {
    const result = await applyMemoSyncImport(user.id, csvRows, removeMode, user.tenantId);
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
      entityType: 'memo_sync_import',
      entityId: user.id,
      afterValue: { removeMode, ...result },
    });
    return NextResponse.json({ data: result }, { status: 200 });
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('IMPORT_VALIDATION_ERROR:')) {
      return NextResponse.json({ error: { code: 'IMPORT_VALIDATION_ERROR', message: e.message.replace('IMPORT_VALIDATION_ERROR:', '') } }, { status: 400 });
    }
    if (e instanceof Error && e.message.startsWith('IMPORT_REMOVE_BLOCKED:')) {
      return NextResponse.json({ error: { code: 'IMPORT_REMOVE_BLOCKED', message: e.message.replace('IMPORT_REMOVE_BLOCKED:', '') } }, { status: 400 });
    }
    await logUnknownError('server', e, {
      userId: user.id,
      context: { path: 'POST /api/memos/sync-import', stage: 'apply', removeMode },
    });
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: t('internalError') } }, { status: 500 });
  }
}
