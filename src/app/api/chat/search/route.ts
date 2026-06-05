/**
 * POST /api/chat/search (仕様: docs/specification/CHAT_SEMANTIC_SEARCH.md)
 *
 * 認証済ユーザが自然文クエリを送信し、5 資産横断意味検索を実行する。
 * 1 リクエスト = 1 ApiCallLog 計上 (cost=0)。
 *
 * ADR-0019 (2026-05-24): チャット検索 (featureUnit=`chat-semantic-search`) は **全プラン無料**。
 *   ApiCallLog には監査・分析のため cost=0 で記録するが、Tenant counter 増分なし、
 *   Stripe queue 投入なし、Beginner 上限カウントなし。
 *   暴走防止は fair-use-limit (月 10,000 calls/tenant) で対応 (src/services/fair-use-limit.service.ts)。
 *
 * 認可:
 *   - 認証必須 (getAuthenticatedUser)
 *   - プロジェクトメンバーシップは不問 (チャット検索は tenant 全体の公開資産が対象)
 *   - テナント境界: viewerTenantId を必須付与、seedDataEnabled に従いシード可否
 *
 * Rate-limit (PR fix/chat-search-and-auto-open / 2026-05-24):
 *   - 同一 IP から 1 分 30 リクエストまで (applyRateLimit, key: 'chat-search')
 *   - 認証チェックの後に適用 (未認証は 401 で安価に弾く)
 *   - 理由: pg_trgm fallback は 5 テーブル並列 similarity 計算で重く、認証済ユーザが
 *     UI gate を迂回して連投した場合に DB DoS となるリスクがある。withMeteredLLM の
 *     rate_limited(1 user / 1 分 10 回) はLLM 経路にのみ作用するため、縮退モードでは
 *     ガードが効かない弱点を route 側で塞ぐ。
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
 *   - 429: IP レート制限超過
 *   - 400: query 空文字 / 8000 字超過
 *   - 500: 予期しないサーバエラー
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { applyRateLimit } from '@/lib/rate-limit';
import { chatSemanticSearch } from '@/services/chat-search.service';
import { CHAT_SEARCH_INPUT_MAX_CHARS } from '@/config/suggestion';
import { recordError } from '@/services/error-log.service';

/**
 * エラー詳細から user query 部分を redact しつつ debug 可能な要約を組み立てる
 * (PR fix/chat-search-and-auto-open / 2026-05-24)。
 *
 * 背景: 旧実装は `error.message` / `error.stack` を recordError にそのまま渡しており、
 * Prisma / Voyage SDK が parameter / payload を message に含めるケースで、ユーザの
 * クエリ文字列 (機微情報の可能性あり) が自社 DB の error_log に保存される懸念があった。
 *
 * 方針: クエリが verbatim で含まれていれば置換、長さも上限カット。
 * エラークラス名 (例: 'PrismaClientKnownRequestError') は trace に有用なので残す。
 */
const REDACT_TOKEN = '[REDACTED_QUERY]';
const SANITIZED_MESSAGE_MAX_CHARS = 500;
const SANITIZED_STACK_MAX_CHARS = 4000;

function redactQuery(text: string | undefined, query: string): string | undefined {
  if (!text) return text;
  // 短すぎるクエリ (10 字未満) は false positive を起こしやすい (例: query='a' が
  // ありふれた英字に当たる) ため redact 対象外。仕様上 10 字未満は UI で警告だが
  // 送信自体は可能なので、本ガードは defense-in-depth。
  if (query.length < 10) return text;
  if (!text.includes(query)) return text;
  return text.split(query).join(REDACT_TOKEN);
}

function sanitizeErrorForLog(
  error: unknown,
  query: string,
): { name: string; message: string; stack?: string } {
  if (!(error instanceof Error)) {
    return { name: 'UnknownThrown', message: String(error).slice(0, SANITIZED_MESSAGE_MAX_CHARS) };
  }
  const safeMessage = redactQuery(error.message, query) ?? '(no message)';
  const safeStack = redactQuery(error.stack, query);
  return {
    name: error.name,
    message: safeMessage.slice(0, SANITIZED_MESSAGE_MAX_CHARS),
    stack: safeStack?.slice(0, SANITIZED_STACK_MAX_CHARS),
  };
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  // IP レート制限 (詳細は冒頭 docstring §Rate-limit)。
  // 認証後に適用することで、未認証トラフィックは 401 で安価に弾ける。
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

  // 予期しない例外を catch して stack trace 等の内部情報が client に漏洩しないよう
  // 全体を try-catch で wrap (security review HIGH 項目 / PR #432)。
  // error log への記録は sanitizeErrorForLog でクエリ文字列を redact してから保存する
  // (PR fix/chat-search-and-auto-open: Prisma/Voyage SDK が parameter を message に
  //  含める場合のクエリ漏洩防止)。
  const queryForRedact = body.query;
  try {
    // feat/starter-data-import (2026-06-05): 単一テナント化。チャット検索は自テナントのみを参照するため、
    //   旧 seedDataEnabled lookup (管理テナントのシード越境参照可否) は不要になった。
    //   越境参照そのものが撤去されたため、フェイルオープンによるシード漏洩リスクも構造的に消滅した。
    const data = await chatSemanticSearch({
      query: body.query,
      viewerTenantId: user.tenantId,
      viewerUserId: user.id,
    });

    return NextResponse.json({ data });
  } catch (error) {
    const sanitized = sanitizeErrorForLog(error, queryForRedact);
    await recordError({
      severity: 'error',
      source: 'server',
      // クエリ文字列を redact 済みの message/stack を保存。エラークラス名を頭に
      // 付与して trace 容易性を維持。
      message: `${sanitized.name}: ${sanitized.message}`,
      stack: sanitized.stack,
      userId: user.id,
      tenantId: user.tenantId,
      context: {
        kind: 'chat_search_unexpected_error',
        // クエリ文字列は機微情報の可能性があるため、context にも含めない。
        // message/stack 経由でも sanitizeErrorForLog で redact 済み。
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
