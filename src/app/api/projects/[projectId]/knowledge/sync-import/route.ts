/**
 * POST /api/projects/[projectId]/knowledge/sync-import — ナレッジ 上書きインポート (T-22 Phase 22c)
 *
 * 認可: knowledge:create + knowledge:update
 * Runtime: Node.js
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import {
  parseKnowledgeSyncImportCsv,
  computeKnowledgeSyncDiff,
  applyKnowledgeSyncImport,
  type RemoveMode,
} from '@/services/knowledge-sync-import.service';
import { recordAuditLog } from '@/services/audit.service';
import { logUnknownError } from '@/services/error-log.service';
import { checkCsvSize, checkCsvRowCount, handleCsvParseError } from '@/lib/csv-import-helpers';
import { runImportStoragePrecheck } from '@/services/import-storage-precheck.service';
import {
  assertStorageLimitInTx,
  StorageLimitExceededError,
  mapStorageGuardErrorToResponse,
  // ADR-0025 (2026-05-29): Beginner プラン超過時の専用エラーマッパー
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
  const createForbidden = await checkProjectPermission(user, projectId, 'knowledge:create');
  if (createForbidden) return createForbidden;
  const updateForbidden = await checkProjectPermission(user, projectId, 'knowledge:update');
  if (updateForbidden) return updateForbidden;

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
      context: { path: 'POST /api/projects/[id]/knowledge/sync-import', stage: 'body-parse', isDryRun },
    });
    return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: t('requestBodyUnreadable') } }, { status: 400 });
  }

  csvText = csvText.replace(/^﻿/, '').trim();
  if (!csvText) {
    return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: t('csvDataEmptyAlt') } }, { status: 400 });
  }

  // fix/csv-import-multiline-text-data-loss 2 巡目: DoS 緩和のためサイズ上限
  const sizeError = checkCsvSize(csvText, t);
  if (sizeError) return sizeError;

  // fix/csv-import-multiline-text-data-loss 2 巡目: csv-parse は malformed CSV で throw する。
  //   旧自前 parseCsvLine は throw しなかったため 500 → 400 退行を防ぐ。
  let csvRows;
  try {
    csvRows = parseKnowledgeSyncImportCsv(csvText);
  } catch (e) {
    const parseErr = handleCsvParseError(e, t);
    if (parseErr) return parseErr;
    throw e;
  }
  // 2026-05-28 フルスキャン 2 巡目: parse 後の行数を明示的に上限判定 (DoS 緩和 + UX)
  const rowCountError = checkCsvRowCount(csvRows.length, t);
  if (rowCountError) return rowCountError;

  // 4 巡目フルスキャン (2026-05-28): DB 容量事前判定。Beginner 50MB 超なら apply ブロック、
  //   Expert/Pro は L1/L2 警告。ID 無し行 (= 新規作成) のみで容量増分を見積もる。
  const newRowCount = csvRows.filter((r) => !r.id).length;
  const storage = await runImportStoragePrecheck({
    tenantId: user.tenantId,
    entity: 'knowledge',
    newRowCount,
  });
  if (storage.isBlocker && storage.errorBody) {
    return NextResponse.json(storage.errorBody, { status: 403 });
  }

  if (isDryRun) {
    const diff = await computeKnowledgeSyncDiff(projectId, csvRows, user.tenantId);
    // dry-run response に precheck 結果を同梱 (UI で警告表示)
    return NextResponse.json({ data: { ...diff, storagePrecheck: storage.precheck } });
  }

  try {
    const result = await applyKnowledgeSyncImport(projectId, csvRows, removeMode, user.id, user.tenantId);
    // 4 巡目: apply 後の post-check。50GB ハードキャップ超なら警告 (データは入った後で
    //   原子性は崩れているが、precheck で既にブロック済みなので超過する可能性は極めて低い)。
    try {
      await prisma.$transaction(
        async (tx) => assertStorageLimitInTx(tx, user.tenantId),
        { timeout: 10_000 },
      );
    } catch (storageErr) {
      // ADR-0025: Beginner プラン超過エラーを最優先で応答 (= 専用 UX 文言)
      const beginnerMapped = mapBeginnerWriteGuardErrorToResponse(storageErr);
      if (beginnerMapped) return NextResponse.json(beginnerMapped.body, { status: beginnerMapped.status });
      const mapped = mapStorageGuardErrorToResponse(storageErr);
      if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
      if (storageErr instanceof StorageLimitExceededError) throw storageErr;
    }
    await recordAuditLog({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'SYNC_IMPORT',
      entityType: 'knowledge_sync_import',
      entityId: projectId,
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
      context: { path: 'POST /api/projects/[id]/knowledge/sync-import', stage: 'apply', removeMode },
    });
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: t('internalError') } }, { status: 500 });
  }
}
