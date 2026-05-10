import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { suggestForProject } from '@/services/suggestion.service';
import { SUGGESTION_DEFAULT_LIMIT } from '@/config/suggestion';

/**
 * GET /api/projects/:projectId/suggestions
 *
 * プロジェクトに対する提案型サービス (核心機能, PR #65 Phase 1)。
 * レスポンス: { data: { knowledge: KnowledgeSuggestion[]; pastIssues: PastIssueSuggestion[]; retrospectives: RetrospectiveSuggestion[] } }
 *
 * 認可: プロジェクトの read 権限が必要 (メンバー or admin)。
 *   → 他プロジェクトの情報を含むため「そのプロジェクトのメンバー」に閲覧を限定する。
 *   過去 Issue の sourceProjectName は project の deletedAt 判定で null マスクしてから返す。
 */
const SUGGESTIONS_API_MAX_LIMIT = 100;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:read');
  if (forbidden) return forbidden;

  // PR-X6 (2026-05-07): limit のデフォルトを SUGGESTION_DEFAULT_LIMIT (=50) に拡大、
  //   上限を 30 → 100 に拡大。段階表示 (Tiered) で 50 件表示しても UX 上の情報過多にならない
  //   (weak tier は折りたたみデフォルトのため)。
  const url = new URL(req.url);
  const raw = url.searchParams.get('limit');
  const limit = raw
    ? Math.max(1, Math.min(SUGGESTIONS_API_MAX_LIMIT, Number(raw) || SUGGESTION_DEFAULT_LIMIT))
    : SUGGESTION_DEFAULT_LIMIT;

  const data = await suggestForProject(projectId, user.tenantId, { limit });
  return NextResponse.json({ data });
}
