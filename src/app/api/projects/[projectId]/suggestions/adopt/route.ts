import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { adoptPastIssueAsTemplate, linkKnowledgeToProject } from '@/services/suggestion.service';
import { recordAuditLog } from '@/services/audit.service';

/**
 * POST /api/projects/:projectId/suggestions/adopt
 *
 * 提案リストから項目を「このプロジェクトに採用」する:
 *   - kind='knowledge': KnowledgeProject に中間レコードを追加 (紐付けのみ)
 *   - kind='issue': 過去 Issue を雛形として新規 Issue を複製 (state='open' でリスタート)
 *
 * 認可: プロジェクトの update 権限が必要 (admin / pm_tl / member)。
 */
const adoptSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('knowledge'), id: z.string().uuid() }),
  z.object({ kind: z.literal('issue'), id: z.string().uuid() }),
]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:update');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = adoptSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  if (parsed.data.kind === 'knowledge') {
    await linkKnowledgeToProject(parsed.data.id, projectId);
    await recordAuditLog({
      userId: user.id,
      action: 'CREATE',
      entityType: 'knowledge_project',
      entityId: parsed.data.id,
    });
    return NextResponse.json({ data: { success: true } }, { status: 201 });
  }

  // kind === 'issue': 雛形として新規 Issue を複製
  const created = await adoptPastIssueAsTemplate(parsed.data.id, projectId, user.id);
  await recordAuditLog({
    userId: user.id,
    action: 'CREATE',
    entityType: 'risk_issue',
    entityId: created.id,
  });
  return NextResponse.json({ data: { id: created.id } }, { status: 201 });
}
