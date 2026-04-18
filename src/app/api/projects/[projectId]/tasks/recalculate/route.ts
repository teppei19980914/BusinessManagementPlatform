import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { recalculateAllProjectWps } from '@/services/task.service';
import { recordAuditLog } from '@/services/audit.service';

/**
 * 関数の実行時間上限を 60 秒に設定（Vercel Hobby 最大）。
 * 通常は A 案 (祖先伝播スキップ) + C 案 (一致時 update スキップ) で十分高速に完了するが、
 * WP 数が多い・全 WP が未反映のデータを 1 回で修復するケースでは既定 10 秒を超える可能性が
 * あるため保険として 60 秒まで許容する。
 */
export const maxDuration = 60;

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

  const { total, updated } = await recalculateAllProjectWps(projectId);

  // 監査ログ: プロジェクト単位の操作として記録（entityId はプロジェクト ID）
  // 実際に値が変わった数のみ記録（一致スキップは監査対象外）
  if (updated > 0) {
    await recordAuditLog({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'project',
      entityId: projectId,
      afterValue: { totalWp: total, updatedWp: updated, operation: 'recalculateAllProjectWps' },
    });
  }

  return NextResponse.json({ data: { totalWp: total, updatedWp: updated } });
}
