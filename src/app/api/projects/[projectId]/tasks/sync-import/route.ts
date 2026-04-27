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
  type RemoveMode,
} from '@/services/task-sync-import.service';
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

  // CSV パース
  const csvRows = parseSyncImportCsv(csvText);

  if (isDryRun) {
    // dry-run: diff を計算して返す (副作用なし)
    const diff = await computeSyncDiff(projectId, csvRows);
    return NextResponse.json({ data: diff });
  }

  // 本実行
  try {
    const result = await applySyncImport(projectId, csvRows, removeMode, user.id);

    await recordAuditLog({
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
