/**
 * GET    /api/projects/[projectId] - プロジェクト詳細取得
 * PATCH  /api/projects/[projectId] - プロジェクト編集
 * DELETE /api/projects/[projectId] - プロジェクト論理削除 (連鎖削除あり)
 *
 * 役割:
 *   プロジェクト詳細画面のデータソース。DELETE は配下のタスク / リスク /
 *   振り返り / 添付などを deleteProjectCascade で連鎖的に論理削除する。
 *
 * 認可: checkProjectPermission ('project:read' / 'project:edit' / 'project:delete')
 * 監査: PATCH/DELETE 時に audit_logs に before/after を記録。
 *
 * 関連: DESIGN.md §8 (権限制御) / §6 (状態と削除可否)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { updateProjectSchema } from '@/lib/validators/project';
import {
  getProject,
  updateProject,
  deleteProject,
  deleteProjectCascade,
} from '@/services/project.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:read');
  if (forbidden) return forbidden;

  const project = await getProject(projectId);
  if (!project) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }

  return NextResponse.json({ data: project });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:update');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = updateProjectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const before = await getProject(projectId);
  const project = await updateProject(projectId, parsed.data, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'project',
    entityId: projectId,
    beforeValue: before ? sanitizeForAudit(before as unknown as Record<string, unknown>) : null,
    afterValue: sanitizeForAudit(project as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: project });
}

/**
 * プロジェクト削除。クエリパラメータ cascade=true で関連データを物理削除:
 *   - リスク/課題、振り返り、タスク、見積、メンバー: 全削除
 *   - ナレッジ: 他プロジェクトと共有していないものは物理削除、共有中は紐付け解除のみ
 *
 * cascade 省略時は従来通り論理削除のみ (データは残るが、
 * ProjectMember が特定できず全○○ 画面からは admin のみ管理可能)。
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:delete');
  if (forbidden) return forbidden;

  const cascade = req.nextUrl.searchParams.get('cascade') === 'true';

  const before = await getProject(projectId);

  if (cascade) {
    const counts = await deleteProjectCascade(projectId);
    await recordAuditLog({
      userId: user.id,
      action: 'DELETE',
      entityType: 'project',
      entityId: projectId,
      beforeValue: before ? sanitizeForAudit(before as unknown as Record<string, unknown>) : null,
      afterValue: { cascade: true, ...counts },
    });
    return NextResponse.json({ data: { success: true, cascade: true, ...counts } });
  }

  // 従来通り論理削除
  await deleteProject(projectId, user.id);
  await recordAuditLog({
    userId: user.id,
    action: 'DELETE',
    entityType: 'project',
    entityId: projectId,
    beforeValue: before ? sanitizeForAudit(before as unknown as Record<string, unknown>) : null,
    afterValue: { cascade: false },
  });
  return NextResponse.json({ data: { success: true, cascade: false } });
}
