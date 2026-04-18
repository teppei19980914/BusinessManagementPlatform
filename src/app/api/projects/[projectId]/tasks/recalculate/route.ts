import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { recalculateAllProjectWps } from '@/services/task.service';
import { recordAuditLog } from '@/services/audit.service';

/**
 * プロジェクト内の全 WP 集計値を一括で再計算する修復用エンドポイント。
 *
 * PR #45 より前に作成された既存 WP で担当者集約 (子 ACT が全員同一なら親も同じ)
 * が null のまま残っているケースや、サブツリー個別の更新で未到達の WP を
 * 最新ロジックに揃えるために使う。
 *
 * 権限: task:update (admin / pm_tl)
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'task:update');
  if (forbidden) return forbidden;

  const count = await recalculateAllProjectWps(projectId);

  // 監査ログ: プロジェクト単位の操作として記録（entityId はプロジェクト ID）
  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'project',
    entityId: projectId,
    afterValue: { recalculatedWpCount: count, operation: 'recalculateAllProjectWps' },
  });

  return NextResponse.json({ data: { recalculatedWpCount: count } });
}
