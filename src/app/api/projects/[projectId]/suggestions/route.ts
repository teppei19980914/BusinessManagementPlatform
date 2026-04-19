import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { suggestForProject } from '@/services/suggestion.service';

/**
 * GET /api/projects/:projectId/suggestions
 *
 * プロジェクトに対する提案型サービス (核心機能, PR #65 Phase 1)。
 * レスポンス: { data: { knowledge: KnowledgeSuggestion[]; pastIssues: PastIssueSuggestion[] } }
 *
 * 認可: プロジェクトの read 権限が必要 (メンバー or admin)。
 *   → 他プロジェクトの情報を含むため「そのプロジェクトのメンバー」に閲覧を限定する。
 *   過去 Issue の sourceProjectName は project の deletedAt 判定で null マスクしてから返す。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:read');
  if (forbidden) return forbidden;

  // limit は任意、デフォルト 10、最大 30 にクランプ
  const url = new URL(req.url);
  const raw = url.searchParams.get('limit');
  const limit = raw ? Math.max(1, Math.min(30, Number(raw) || 10)) : 10;

  const data = await suggestForProject(projectId, { limit });
  return NextResponse.json({ data });
}
