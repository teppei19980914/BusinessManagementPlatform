/**
 * API Route 共通エラーハンドラ (PR #115 / 2026-04-24)
 *
 * 目的:
 *   未捕捉例外が発生した API route で、
 *     1. エラー詳細を system_error_logs に保存 (recordError)
 *     2. ユーザには固定文言の 500 を返す (機密情報を応答 body に混ぜない)
 *   を一括で提供する。
 *
 * 使い方:
 *   ```ts
 *   export const POST = withErrorHandler(async (req, { params }) => {
 *     // ここで throw してもレスポンスは常に固定文言 500
 *     // 既知の NextResponse (validation error 400, forbidden 403 等) は
 *     // return すればそのまま返る (throw ではなく return)
 *   }, { source: 'server' });
 *   ```
 *
 * 設計判断:
 *   - ビジネスエラー (validation / auth / forbidden / not found) は
 *     各 route で explicit に NextResponse を return する従来方針を維持。
 *   - throw された時点で「想定外エラー」とみなし、ユーザには詳細を見せない。
 *   - stack / message は DB 専用、Console / response 共に出さない。
 */

import { NextRequest, NextResponse } from 'next/server';
import { logUnknownError, type ErrorSource } from '@/services/error-log.service';
import { auth } from '@/lib/auth';

type RouteHandler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<NextResponse>;

type WithErrorHandlerOptions = {
  /** エラーの発生源。既定 'server'。 */
  source?: ErrorSource;
};

/**
 * API Route ハンドラ を包んで、未捕捉例外を DB 記録 + 固定 500 応答に変換する。
 */
export function withErrorHandler(
  handler: RouteHandler,
  options: WithErrorHandlerOptions = {},
): RouteHandler {
  const source: ErrorSource = options.source ?? 'server';
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (error) {
      // 認証済ユーザなら userId を付ける (失敗しても silent)
      let userId: string | undefined;
      try {
        const session = await auth();
        userId = session?.user?.id;
      } catch {
        // auth 解決自体が失敗する状況もある
      }

      const url = new URL(req.url);
      await logUnknownError(source, error, {
        userId,
        context: {
          path: url.pathname,
          method: req.method,
          // クエリは PII / token が混じり得るため key のみ記録
          queryKeys: Array.from(url.searchParams.keys()),
        },
      });

      // ユーザ向け応答: 機密情報を一切含めない固定文言
      return NextResponse.json(
        {
          error: {
            code: 'INTERNAL_ERROR',
            message: '内部エラーが発生しました',
          },
        },
        { status: 500 },
      );
    }
  };
}
