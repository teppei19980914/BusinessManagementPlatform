/**
 * POST /api/chat/search (仕様: docs/specification/CHAT_SEMANTIC_SEARCH.md)
 *
 * 認証済ユーザが自然文クエリを送信し、5 資産横断意味検索を実行する。
 * 1 リクエスト = 1 ApiCallLog 計上 (仕様 §4、Beginner は月100回枠と共有、
 * Expert ¥10、Pro ¥30、書込操作と同単価)。
 *
 * 認可:
 *   - 認証必須 (getAuthenticatedUser)
 *   - プロジェクトメンバーシップは不問 (チャット検索は tenant 全体の公開資産が対象)
 *   - テナント境界: viewerTenantId を必須付与、seedDataEnabled に従いシード可否
 *
 * リクエスト:
 *   { query: string }
 *
 * レスポンス (成功 200):
 *   {
 *     data: {
 *       query, degraded, degradeReason?, results: {...}, totalCount
 *     }
 *   }
 *
 * レスポンス (失敗):
 *   - 401: 未認証 / セッション失効
 *   - 400: query 空文字 / 8000 字超過
 *   - 500: 予期しないサーバエラー
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { chatSemanticSearch } from '@/services/chat-search.service';
import { CHAT_SEARCH_INPUT_MAX_CHARS } from '@/config/suggestion';

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

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

  // テナントの seedDataEnabled を取得 (既存提案機能と整合)
  const tenant = await prisma.tenant.findUnique({
    where: { id: user.tenantId },
    select: { seedDataEnabled: true },
  });

  const data = await chatSemanticSearch({
    query: body.query,
    viewerTenantId: user.tenantId,
    viewerUserId: user.id,
    viewerSeedDataEnabled: tenant?.seedDataEnabled ?? true,
  });

  return NextResponse.json({ data });
}
