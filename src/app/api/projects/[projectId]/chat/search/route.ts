/**
 * POST /api/projects/[projectId]/chat/search
 *
 * たすきフクロウ「PJ内から探す」タブの検索エンドポイント。
 * 指定プロジェクト内の 6 資産 (Knowledge / RiskIssue / Retrospective /
 * IdeaQaThread / IdeaWhiteboardSession / IdeaVotingSession) を意味検索する。
 *
 * 認可:
 *   - 認証必須 (getAuthenticatedUser)
 *   - プロジェクト参照権限必須 (checkProjectPermission: 'project:read')
 *
 * 課金:
 *   - featureUnit='chat-semantic-search' (全プラン無料、fair-use-limit 月 10,000 回/tenant)
 *
 * リクエスト:
 *   { query: string }
 *
 * レスポンス (成功 200):
 *   { data: ProjectChatSearchResult }
 *
 * レスポンス (失敗):
 *   - 401: 未認証
 *   - 403: プロジェクト参照権限なし
 *   - 429: IP レート制限超過
 *   - 400: query 空文字 / 8000 字超過
 *   - 500: サーバエラー
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { applyRateLimit } from '@/lib/rate-limit';
import { projectChatSearch } from '@/services/project-chat-search.service';
import { CHAT_SEARCH_INPUT_MAX_CHARS } from '@/config/suggestion';
import { recordError } from '@/services/error-log.service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:read');
  if (forbidden) return forbidden;

  const limited = applyRateLimit(req, { key: 'chat-search', max: 30, windowMs: 60_000 });
  if (limited) return limited;

  let body: { query?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_JSON', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  if (typeof body.query !== 'string') {
    return NextResponse.json(
      { error: { code: 'INVALID_QUERY', message: 'query は文字列で指定してください' } },
      { status: 400 },
    );
  }

  if (body.query.length > CHAT_SEARCH_INPUT_MAX_CHARS) {
    return NextResponse.json(
      {
        error: {
          code: 'QUERY_TOO_LONG',
          message: `クエリは ${CHAT_SEARCH_INPUT_MAX_CHARS} 文字以内で送信してください`,
        },
      },
      { status: 400 },
    );
  }

  try {
    const data = await projectChatSearch({
      query: body.query,
      projectId,
      tenantId: user.tenantId,
      userId: user.id,
    });
    return NextResponse.json({ data });
  } catch (error) {
    await recordError({
      severity: 'error',
      source: 'server',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      userId: user.id,
      tenantId: user.tenantId,
      context: { kind: 'project_chat_search_error', projectId },
    });
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '検索に失敗しました。時間をおいて再度お試しください' } },
      { status: 500 },
    );
  }
}
