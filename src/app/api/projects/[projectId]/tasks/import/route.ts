import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { parseCsvTemplate, importWbsTemplate, validateWbsTemplate } from '@/services/task.service';
import { recordAuditLog } from '@/services/audit.service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'task:create');
  if (forbidden) return forbidden;

  // CSV テキストを取得（BOM 除去）
  const rawText = await req.text();
  const csvText = rawText.replace(/^\uFEFF/, '').trim();
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
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error('WBS import error:', errorMessage);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: `インポート処理中にエラーが発生しました: ${errorMessage}` } },
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
