/**
 * POST /api/projects/[projectId]/tasks/import - WBS テンプレート CSV インポート
 *
 * 役割:
 *   他プロジェクトでエクスポートした WBS テンプレートを取り込み、現プロジェクトの
 *   タスクとして一括作成する。階層 (parent_task_id) を維持しつつ ID は新規発番。
 *
 * 認可: checkProjectPermission('task:create')
 * 監査: audit_logs (action=CREATE, entityType=task) を一括記録。
 *
 * Runtime:
 *   Edge Runtime ではなく Node Runtime を明示。Prisma + 大きめ body の扱いを
 *   安定化させるため (Edge では Prisma が動かない / body サイズ制限がきつい)。
 *
 * 関連: SPECIFICATION.md (WBS テンプレート機能 / インポートバリデーション)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { parseCsvTemplate, importWbsTemplate, validateWbsTemplate } from '@/services/task.service';
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
  const forbidden = await checkProjectPermission(user, projectId, 'task:create');
  if (forbidden) return forbidden;

  // multipart/form-data から CSV ファイルを取り出す。
  // 旧実装は text/csv 生 body を req.text() で受けていたが、Vercel edge 層で
  // ERR_CONNECTION_RESET を誘発するケースが確認されたため FormData に変更。
  // 旧形式（text/csv 直接 POST）にもフォールバックして後方互換を維持する。
  let csvText = '';
  const contentType = req.headers.get('content-type') ?? '';
  try {
    if (contentType.startsWith('multipart/form-data')) {
      const formData = await req.formData();
      const file = formData.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json(
          { error: { code: 'VALIDATION_ERROR', message: 'file フィールドにファイルを指定してください' } },
          { status: 400 },
        );
      }
      csvText = await file.text();
    } else {
      // 後方互換: text/csv 等の生 body
      csvText = await req.text();
    }
  } catch (e) {
    await logUnknownError('server', e, {
      userId: user.id,
      context: { path: 'POST /api/projects/[id]/tasks/import', stage: 'body-parse' },
    });
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'リクエストボディを読み取れませんでした' } },
      { status: 400 },
    );
  }

  // BOM 除去
  csvText = csvText.replace(/^\uFEFF/, '').trim();
  if (!csvText) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'CSVデータが空です' } },
      { status: 400 },
    );
  }

  // CSV をパースしてテンプレートデータに変換
  const templateTasks = parseCsvTemplate(csvText);
  if (templateTasks.length === 0) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'インポート可能なタスクがありません。ヘッダー行と1件以上のデータ行が必要です' } },
      { status: 400 },
    );
  }
  if (templateTasks.length > 500) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'テンプレートは500件までです' } },
      { status: 400 },
    );
  }

  // 事前バリデーション
  const validationErrors = validateWbsTemplate(templateTasks);
  if (validationErrors.length > 0) {
    return NextResponse.json(
      { error: { code: 'IMPORT_VALIDATION_ERROR', message: validationErrors.join('; ') } },
      { status: 400 },
    );
  }

  let count: number;
  try {
    count = await importWbsTemplate(projectId, templateTasks, user.id);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('IMPORT_VALIDATION_ERROR:')) {
      const details = e.message.replace('IMPORT_VALIDATION_ERROR:', '');
      return NextResponse.json(
        { error: { code: 'IMPORT_VALIDATION_ERROR', message: details } },
        { status: 400 },
      );
    }
    // PR #115 (2026-04-24): console.* 廃止。system_error_logs に保存してユーザには
    // 固定文言「内部エラーが発生しました」のみ返す (機密情報を Network / Console にも出さない)。
    await logUnknownError('server', e, {
      userId: user.id,
      context: { path: 'POST /api/projects/[id]/tasks/import', stage: 'import-execute' },
    });
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '内部エラーが発生しました' } },
      { status: 500 },
    );
  }

  await recordAuditLog({
    userId: user.id,
    action: 'CREATE',
    entityType: 'wbs_import',
    entityId: projectId,
    afterValue: { importedCount: count },
  });

  return NextResponse.json({ data: { importedCount: count } }, { status: 201 });
}
