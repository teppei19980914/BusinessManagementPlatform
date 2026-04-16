import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { copyWbs } from '@/services/task.service';
import { recordAuditLog } from '@/services/audit.service';
import { z } from 'zod/v4';

const copyWbsSchema = z.object({
  sourceProjectId: z.string().uuid(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const { projectId } = await params;
  const body = await req.json();
  const parsed = copyWbsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const count = await copyWbs(parsed.data.sourceProjectId, projectId, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'CREATE',
    entityType: 'wbs_copy',
    entityId: projectId,
    afterValue: { sourceProjectId: parsed.data.sourceProjectId, copiedCount: count },
  });

  return NextResponse.json({ data: { copiedCount: count } }, { status: 201 });
}
