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
import { getTranslations } from 'next-intl/server';
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
    const t = await getTranslations('message');
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
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
 * プロジェクト削除 (PR #89 で細粒度化):
 *
 * クエリパラメータ:
 *   - cascade=true                : 関連データ物理削除モード (従来機能)
 *   - cascadeRisks=true           : リスク一覧も物理削除 (PR #89)
 *   - cascadeIssues=true          : 課題一覧も物理削除 (PR #89)
 *   - cascadeRetros=true          : 振り返り一覧も物理削除 (PR #89)
 *   - cascadeKnowledge=true       : ナレッジ一覧も物理削除 (PR #89)
 *
 * フラグなし (未指定 or cascade=false): 従来通り論理削除のみ。
 * 強制削除: Project 本体 / Task / Estimate / ProjectMember / Attachment (project/task/estimate) は
 *           cascade=true の場合は常に物理削除 (個別フラグ不要)。
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
  const cascadeRisks = req.nextUrl.searchParams.get('cascadeRisks') === 'true';
  const cascadeIssues = req.nextUrl.searchParams.get('cascadeIssues') === 'true';
  const cascadeRetros = req.nextUrl.searchParams.get('cascadeRetros') === 'true';
  const cascadeKnowledge = req.nextUrl.searchParams.get('cascadeKnowledge') === 'true';

  const before = await getProject(projectId);

  if (cascade) {
    const counts = await deleteProjectCascade(projectId, {
      cascadeRisks,
      cascadeIssues,
      cascadeRetros,
      cascadeKnowledge,
    });
    await recordAuditLog({
      userId: user.id,
      action: 'DELETE',
      entityType: 'project',
      entityId: projectId,
      beforeValue: before ? sanitizeForAudit(before as unknown as Record<string, unknown>) : null,
      afterValue: {
        cascade: true,
        cascadeRisks,
        cascadeIssues,
        cascadeRetros,
        cascadeKnowledge,
        ...counts,
      },
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
