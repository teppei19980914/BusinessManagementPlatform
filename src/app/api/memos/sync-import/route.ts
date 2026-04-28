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

  const csvRows = parseMemoSyncImportCsv(csvText);
  if (isDryRun) {
    const diff = await computeMemoSyncDiff(user.id, csvRows);
    return NextResponse.json({ data: diff });
  }

  try {
    const result = await applyMemoSyncImport(user.id, csvRows, removeMode);
    await recordAuditLog({
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
