import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { createProjectSchema } from '@/lib/validators/project';
import { listProjects, createProject } from '@/services/project.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { searchParams } = req.nextUrl;
  const result = await listProjects(
    {
      keyword: searchParams.get('keyword') || undefined,
      customerName: searchParams.get('customerName') || undefined,
      status: searchParams.get('status') || undefined,
      page: Number(searchParams.get('page')) || 1,
      limit: Number(searchParams.get('limit')) || 20,
    },
    user.id,
    user.systemRole,
  );

  return NextResponse.json({
    data: result.data,
    meta: {
      total: result.total,
      page: Number(searchParams.get('page')) || 1,
      limit: Number(searchParams.get('limit')) || 20,
    },
  });
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  // admin と pm_tl のみ作成可（pm_tl はプロジェクト未所属でも新規作成可）
  if (user.systemRole !== 'admin') {
    // 一般ユーザでも PM/TL ロールを持っていればプロジェクト作成可能
    // ただし、ここではシステムロールで判断（プロジェクトスコープ外の操作のため）
    // MVP-1a では admin のみに制限
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'この操作を実行する権限がありません' } },
      { status: 403 },
    );
  }

  const body = await req.json();
  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const project = await createProject(parsed.data, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'CREATE',
    entityType: 'project',
    entityId: project.id,
    afterValue: sanitizeForAudit(project as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: project }, { status: 201 });
}
