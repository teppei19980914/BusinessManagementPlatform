/**
 * PATCH /api/projects/[projectId]/status - プロジェクト状態遷移
 *
 * 役割:
 *   プロジェクトのステータス (企画中 → 見積中 → ... → クローズ) を進める。
 *   state-machine.ts の canTransition() で「逆戻り禁止」「飛び級禁止」を強制。
 *   違反時は 409 STATE_CONFLICT を返す。
 *
 * 認可: checkProjectPermission('project:change_status') - PM/TL or admin のみ
 * 監査: audit_logs (action=UPDATE, entityType=project) に before/after status を記録。
 *
 * 関連: DESIGN.md §6 (プロジェクト状態遷移設計) / src/services/state-machine.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { changeStatusSchema } from '@/lib/validators/project';
import { getProject, changeProjectStatus } from '@/services/project.service';
import { recordAuditLog } from '@/services/audit.service';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:change_status');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = changeStatusSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  try {
    const before = await getProject(projectId);
    const project = await changeProjectStatus(projectId, parsed.data.status, user.id);

    await recordAuditLog({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'project',
      entityId: projectId,
      beforeValue: { status: before?.status },
      afterValue: { status: project.status },
    });

    return NextResponse.json({ data: project });
  } catch (e) {
    if (e instanceof Error) {
      if (e.message === 'NOT_FOUND') {
        const t = await getTranslations('message');
        return NextResponse.json(
          { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
          { status: 404 },
        );
      }
      if (e.message.startsWith('STATE_CONFLICT:')) {
        return NextResponse.json(
          { error: { code: 'STATE_CONFLICT', message: e.message.replace('STATE_CONFLICT:', '') } },
          { status: 409 },
        );
      }
    }
    throw e;
  }
}
