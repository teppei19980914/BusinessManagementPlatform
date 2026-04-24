/**
 * システムエラーログ サービス (PR #115 / 2026-04-24)
 *
 * 役割:
 *   内部エラー (サーバ例外・予期せぬ Promise reject など) と
 *   クライアントエラー (React render error・fetch 失敗・UI バグ) を
 *   DB (system_error_logs) に保存する。
 *
 *   本プロダクトの **セキュリティ原則**:
 *     「機密情報を含み得るエラー詳細 (スタック、設定値、SQL 構造 etc.) は
 *      Console にも UI にも出さない。必ず DB に秘匿して保存し、
 *      ユーザには固定文言『内部エラーが発生しました』のみを返す。」
 *
 * 呼び出し経路:
 *   - API route の try/catch → recordError({ source: 'server', ... })
 *   - Cron / batch job のエラー → recordError({ source: 'cron', ... })
 *   - メールプロバイダ失敗 → recordError({ source: 'mail', ... })
 *   - Client error boundary (global-error.tsx) → POST /api/client-errors → recordError({ source: 'client', ... })
 *
 * 永続化失敗時の挙動:
 *   DB 接続切れ等で本サービス自体が失敗すると再帰的に無限ログになる危険があるため、
 *   サービス内部で try/catch して **silent fail** する。ユーザ側のエラーハンドリングを
 *   阻害しない (エラー情報は既に失われたとして諦める)。
 *
 * 関連:
 *   - prisma/schema.prisma SystemErrorLog モデル
 *   - DESIGN.md §9.8.5 (エラー情報の機密化方針)
 */

import { prisma } from '@/lib/db';

/** エラー重要度。info < warn < error < fatal。 */
export type ErrorSeverity = 'info' | 'warn' | 'error' | 'fatal';

/** 発生源カテゴリ。分析時にソースごとに集計するために用いる。 */
export type ErrorSource =
  | 'server' // API route / service 層
  | 'client' // ブラウザ (error boundary 経由)
  | 'cron' // 定期バッチ
  | 'mail' // メールプロバイダ
  | 'auth' // 認証フロー
  | 'unknown';

export type RecordErrorInput = {
  severity?: ErrorSeverity;
  source: ErrorSource;
  /** 固定ラベル + 動的メッセージを組み合わせた短い説明 (機密含めないこと)。 */
  message: string;
  /** Error.stack が取れる場合に渡す。取れないなら undefined。 */
  stack?: string;
  /** 認証済ユーザの ID。pre-auth や cron は undefined。 */
  userId?: string;
  /** trace 用の request id (middleware で header から払い出す想定)。 */
  requestId?: string;
  /** IP / URL path / HTTP method / 任意メタデータ (機密は含めない)。 */
  context?: Record<string, unknown>;
};

/**
 * エラーを system_error_logs テーブルに書き込む。
 *
 * - 本サービス自身の失敗は silent (console にも出さない、再帰ログ防止)。
 * - message 256 文字超・stack 大容量は DB 側 TEXT で受けるため制限なしだが、
 *   context に巨大な値 (req body 全体等) を入れるのは避ける。
 */
export async function recordError(input: RecordErrorInput): Promise<void> {
  try {
    await prisma.systemErrorLog.create({
      data: {
        severity: input.severity ?? 'error',
        source: input.source,
        message: input.message,
        stack: input.stack,
        userId: input.userId,
        requestId: input.requestId,
        context: input.context as object | undefined,
      },
    });
  } catch {
    // silent fail — エラーログ自体の失敗はユーザ体験を阻害させない
  }
}

/**
 * Error オブジェクトから message + stack を抽出して recordError に渡すヘルパ。
 * API route の try/catch で `catch (e) { await logUnknownError('server', e, { userId }); }` の形で使う。
 */
export async function logUnknownError(
  source: ErrorSource,
  error: unknown,
  extras?: Omit<RecordErrorInput, 'source' | 'message' | 'stack'>,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  await recordError({ source, message, stack, ...extras });
}
