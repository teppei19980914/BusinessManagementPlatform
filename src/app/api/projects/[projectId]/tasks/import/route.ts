import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { importWbsTemplate } from '@/services/task.service';
import { wbsTemplateSchema } from '@/lib/validators/task';
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

  const body = await req.json();
  const parsed = wbsTemplateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const count = await importWbsTemplate(projectId, parsed.data.tasks, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'CREATE',
    entityType: 'wbs_import',
    entityId: projectId,
    afterValue: { importedCount: count },
  });

  return NextResponse.json({ data: { importedCount: count } }, { status: 201 });
}
