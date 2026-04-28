/**
 * POST /api/projects/[projectId]/retrospectives/sync-import — 振り返り 上書きインポート (T-22 Phase 22b)
 *
 * 認可: project:update (retrospectives は project:update で書き込み判定する慣習に準拠)
 * Runtime: Node.js
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import {
  parseRetrospectiveSyncImportCsv,
  computeRetrospectiveSyncDiff,
  applyRetrospectiveSyncImport,
  type RemoveMode,
} from '@/services/retrospective-sync-import.service';
import { recordAuditLog } from '@/services/audit.service';
import { logUnknownError } from '@/services/error-log.service';

export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:update');
  if (forbidden) return forbidden;

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
      context: { path: 'POST /api/projects/[id]/retrospectives/sync-import', stage: 'body-parse', isDryRun },
    });
    return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: t('requestBodyUnreadable') } }, { status: 400 });
  }

  csvText = csvText.replace(/^﻿/, '').trim();
  if (!csvText) {
    return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: t('csvDataEmptyAlt') } }, { status: 400 });
  }

  const csvRows = parseRetrospectiveSyncImportCsv(csvText);
  if (isDryRun) {
    const diff = await computeRetrospectiveSyncDiff(projectId, csvRows);
    return NextResponse.json({ data: diff });
  }

  try {
    const result = await applyRetrospectiveSyncImport(projectId, csvRows, removeMode, user.id);
    await recordAuditLog({
      userId: user.id,
      action: 'SYNC_IMPORT',
      entityType: 'retrospective_sync_import',
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
      context: { path: 'POST /api/projects/[id]/retrospectives/sync-import', stage: 'apply', removeMode },
    });
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: t('internalError') } }, { status: 500 });
  }
}
