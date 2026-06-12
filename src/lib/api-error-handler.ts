/**
 * API Route 共通エラーハンドラ (PR #115 / 2026-04-24, i18n zero-hardcode で再設計)
 *
 * 目的:
 *   未捕捉例外が発生した API route で、
 *     1. エラー詳細を system_error_logs に保存 (recordError)
 *     2. ユーザにはエラーコード + ロケール対応文言を返す
 *   を一括で提供する。
 *
 * 使い方:
 *   ```ts
 *   export const POST = withErrorHandler(async (req, { params }) => {
 *     // throw new AppError('TENANT_NOT_FOUND', { tenantId }) 等
 *     // 未捕捉例外は INTERNAL_ERROR にラップ
 *   }, { source: 'server' });
 *   ```
 *
 * 設計判断:
 *   - 既知のビジネスエラーは {@link AppError} を throw する。code は安定識別子、
 *     message はロケールに応じて i18n catalog から解決される。
 *   - 未知の例外 (DB / ネットワーク / null pointer) は INTERNAL_ERROR にラップ。
 *     stack / 詳細は DB のみに残し、ユーザ応答には出さない。
 *   - {@link TenantBoundaryError} は legacy 互換のため `TENANT_BOUNDARY_VIOLATION`
 *     コードに変換 + warn 重要度で記録する。
 *
 * 関連:
 *   - docs/i18n/CONVENTIONS.md §5 §7
 *   - src/lib/errors/app-error.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { logUnknownError, type ErrorSource } from '@/services/error-log.service';
import { auth } from '@/lib/auth';
import { TenantBoundaryError } from '@/lib/permissions/tenant';
import { AppError, isAppError, type AppErrorParams, type ErrorCode } from '@/lib/errors/app-error';

type RouteHandler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<NextResponse>;

type WithErrorHandlerOptions = {
  /** エラーの発生源。既定 'server'。 */
  source?: ErrorSource;
};

/**
 * Translate an error code via the i18n catalog. Falls back to the code itself
 * if translation context is unavailable (e.g., catalog miss). Never throws.
 */
async function translateErrorMessage(
  code: ErrorCode,
  params: AppErrorParams,
): Promise<string> {
  try {
    const t = await getTranslations('error');
    // next-intl ICU formatter accepts string|number|Date|boolean for placeholders.
    return t(code, params as Record<string, string | number>);
  } catch {
    return code;
  }
}

/**
 * Build a NextResponse for an AppError. The body always contains
 * `{ error: { code, message } }`; tests should assert on `code`, while UI
 * shows `message`.
 */
async function buildAppErrorResponse(err: AppError): Promise<NextResponse> {
  const message = await translateErrorMessage(err.code, err.params);
  return NextResponse.json(
    { error: { code: err.code, message } },
    { status: err.httpStatus },
  );
}

/**
 * API Route ハンドラ を包んで、AppError と未捕捉例外を統一形式の JSON 応答に変換する。
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

      // 1. AppError: 既知のドメインエラー。code + params + httpStatus を素直に返す。
      //    severity は INTERNAL_ERROR のときだけ "error" 扱いとし、他は warn。
      if (isAppError(error)) {
        const isInternal = error.code === 'INTERNAL_ERROR';
        await logUnknownError(source, error, {
          userId,
          severity: isInternal ? undefined : 'warn',
          context: {
            path: url.pathname,
            method: req.method,
            queryKeys: Array.from(url.searchParams.keys()),
            kind: 'app_error',
            code: error.code,
          },
        });
        return buildAppErrorResponse(error);
      }

      // 2. TenantBoundaryError: legacy 互換。AppError('TENANT_BOUNDARY_VIOLATION')
      //    と同じ意味だが、cross-tenant attack 試行として明示的に warn 記録する。
      //    Backward-compat: response body の code は 'FORBIDDEN' を維持
      //    (UI / 既存 fetch handler が 'FORBIDDEN' を見ているため)。
      if (error instanceof TenantBoundaryError) {
        await logUnknownError('server', error, {
          userId,
          severity: 'warn',
          context: {
            path: url.pathname,
            method: req.method,
            queryKeys: Array.from(url.searchParams.keys()),
            kind: 'tenant_boundary_violation',
          },
        });
        const message = await translateErrorMessage('FORBIDDEN', {});
        return NextResponse.json(
          { error: { code: 'FORBIDDEN', message } },
          { status: 403 },
        );
      }

      // 3. その他未捕捉例外: 詳細を DB に残しつつ INTERNAL_ERROR を返す。
      await logUnknownError(source, error, {
        userId,
        context: {
          path: url.pathname,
          method: req.method,
          // クエリは PII / token が混じり得るため key のみ記録
          queryKeys: Array.from(url.searchParams.keys()),
        },
      });

      const message = await translateErrorMessage('INTERNAL_ERROR', {});
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message } },
        { status: 500 },
      );
    }
  };
}
