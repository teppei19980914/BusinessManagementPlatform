/**
 * POST /api/projects/[projectId]/risks/sync-import — リスク/課題 上書きインポート (Sync by ID)
 *
 * 役割:
 *   既存リスク/課題の「export → Excel 編集 → re-import」往復編集サイクル。
 *   ?dryRun=1 でプレビュー (副作用なし)、無しで本実行。
 *
 * 認可:
 *   risk:update + risk:delete (= PM/TL + admin) を要求。
 *
 * 監査:
 *   本実行成功時に audit_logs (action='SYNC_IMPORT', entityType='risk_sync_import',
 *   entityId=projectId, afterValue=サマリ) を 1 件追加。
 *
 * Runtime: Node.js (Edge では Prisma が動かない + body サイズ制限のため)。
 *
 * 関連:
 *   - DEVELOPER_GUIDE §11 T-22 Phase 22a
 *   - src/services/risk-sync-import.service.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import {
  parseRiskSyncImportCsv,
  computeRiskSyncDiff,
  applyRiskSyncImport,
  type RemoveMode,
} from '@/services/risk-sync-import.service';
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

  const updateForbidden = await checkProjectPermission(user, projectId, 'risk:update');
  if (updateForbidden) return updateForbidden;
  const deleteForbidden = await checkProjectPermission(user, projectId, 'risk:delete');
  if (deleteForbidden) return deleteForbidden;

  const t = await getTranslations('message');

  const url = new URL(req.url);
  const isDryRun = url.searchParams.get('dryRun') === '1';

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
            error: { code: 'VALIDATION_ERROR', message: t('removeModeInvalid') },
          },
          { status: 400 },
        );
      }
    }
  } catch (e) {
    await logUnknownError('server', e, {
      userId: user.id,
      context: { path: 'POST /api/projects/[id]/risks/sync-import', stage: 'body-parse', isDryRun },
    });
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: t('requestBodyUnreadable') } },
      { status: 400 },
    );
  }

  csvText = csvText.replace(/^﻿/, '').trim();
  if (!csvText) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: t('csvDataEmptyAlt') } },
      { status: 400 },
    );
  }

  const csvRows = parseRiskSyncImportCsv(csvText);

  if (isDryRun) {
    const diff = await computeRiskSyncDiff(projectId, csvRows);
    return NextResponse.json({ data: diff });
  }

  try {
    const result = await applyRiskSyncImport(projectId, csvRows, removeMode, user.id);

    await recordAuditLog({
      userId: user.id,
      action: 'SYNC_IMPORT',
      entityType: 'risk_sync_import',
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

    await logUnknownError('server', e, {
      userId: user.id,
      context: { path: 'POST /api/projects/[id]/risks/sync-import', stage: 'apply', removeMode },
    });
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: t('internalError') } },
      { status: 500 },
    );
  }
}
