/**
 * POST /api/chat/search (仕様: docs/specification/CHAT_SEMANTIC_SEARCH.md)
 *
 * 認証済ユーザが自然文クエリを送信し、5 資産横断意味検索を実行する。
 * 1 リクエスト = 1 ApiCallLog 計上 (仕様 §4、Beginner は月100回枠と共有、
 * Expert ¥5、Pro ¥15、書込操作と同単価。価格は Tenant.pricePerCallHaiku/Sonnet 経由)。
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
import { recordError } from '@/services/error-log.service';

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

  // 予期しない例外を catch して stack trace 等の内部情報が client に漏洩しないよう
  // 全体を try-catch で wrap (security review HIGH 項目 / PR #432)。
  // 既存 error-log.service の方針 (機密情報含み得る詳細は DB に秘匿、ユーザには固定文言)
  // と整合させる。
  try {
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
  } catch (error) {
    await recordError({
      severity: 'error',
      source: 'server',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      userId: user.id,
      context: {
        kind: 'chat_search_unexpected_error',
        tenantId: user.tenantId,
        // クエリ文字列は機微情報の可能性があるため stack/message 経由でも保存しない
        // (Voyage には送るが、自社 DB の error log には残さない設計)
      },
    });
    return NextResponse.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: '検索に失敗しました。時間をおいて再度お試しください',
        },
      },
      { status: 500 },
    );
  }
}
