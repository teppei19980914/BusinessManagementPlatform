/**
 * cron 実行履歴ロギング共通ヘルパ (PR feat/cron-execution-log / 2026-05-18)
 *
 * 役割:
 *   各 cron route の処理を `withCronExecutionLogging(name, async () => { ... })` で
 *   ラップすることで、開始時 / 完了時 / 失敗時に DB へ実行記録を残す。
 *
 * 設計判断:
 *   - **logging 失敗で cron 本体を落とさない**: log 書込みの try/catch を本ヘルパで内包。
 *     log 失敗時は console.warn し、cron 本体の処理結果は呼出元へ届ける。
 *     (= 監視機能の故障で本番処理を巻き添えにしないという fail-soft 原則)
 *   - **timeout 検知の根拠**: Netlify Functions 10s 上限で Lambda が殺された場合、
 *     try/finally の finally すら走らない。本ヘルパは run 直前に DB に status='running' を
 *     書き込み、終了後に update する。timeout で update が走らなければ status='running' の
 *     ままレコードが残り、super_admin ダッシュボードが「stale running = timeout 疑い」として
 *     検出表示できる。
 *   - **invokerIp の取得**: cron-job.org が POST してくる IP。`x-forwarded-for` の先頭値を採用
 *     (Netlify Edge は当該 header を信頼できる形で付与する。仕様: https://docs.netlify.com/
 *     edge-functions/api/#request)
 *   - **不正呼出は記録しない**: isCronAuthorized で 401 になった requests は本ヘルパに到達
 *     しない。記録するのは「認証済かつ実行された」cron のみ
 *
 * 使用例:
 *   ```ts
 *   export async function POST(req: NextRequest) {
 *     if (!isCronAuthorized(req)) {
 *       return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
 *     }
 *     return withCronExecutionLogging('daily-notifications', req, async () => {
 *       const result = await generateDailyNotifications();
 *       return { data: { source: 'cron', ...result } };
 *     });
 *   }
 *   ```
 *
 * 関連:
 *   - Prisma model: prisma/schema.prisma model CronExecutionLog
 *   - 可視化 UI: src/app/(dashboard)/admin/super/cron-history/page.tsx
 *   - KDD: docs/knowledge/KDD_PATTERNS.md §5.X+72
 */

import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';

/** cron route のハンドラから返すレスポンス本体 (= NextResponse.json に渡す JSON)。 */
export type CronHandlerSuccess = {
  data: Record<string, unknown>;
};

/**
 * cron route 本体をラップして DB 実行記録を残す。
 *
 * @param cronName     log に記録される識別子 (= URL path のフラグメント、kebab-case 推奨)
 * @param req          呼出元 IP / 開始時刻取得用
 * @param handler      cron の本体処理。レスポンス JSON (= `{ data: ... }`) を返す async 関数
 * @returns            NextResponse (200 成功 / 500 失敗)
 */
export async function withCronExecutionLogging(
  cronName: string,
  req: NextRequest,
  handler: () => Promise<CronHandlerSuccess>,
): Promise<NextResponse> {
  const startedAtMs = Date.now();
  const invokerIp = extractInvokerIp(req);

  // 開始記録 (status='running'): 後で update する。失敗しても log なしで本体は継続。
  const logId = await safeCreateRunningLog(cronName, invokerIp);

  try {
    const result = await handler();
    const durationMs = Date.now() - startedAtMs;
    await safeCompleteLog(logId, {
      status: 'success',
      durationMs,
      payloadJson: result.data,
    });
    return NextResponse.json(result);
  } catch (error) {
    const durationMs = Date.now() - startedAtMs;
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack ?? null : null;
    await safeCompleteLog(logId, {
      status: 'failure',
      durationMs,
      errorMessage: message,
      errorStack: stack,
    });
    // 500 を返して Stripe Webhook 等の再送機能を起動させる (cron-job.org は再送しないため
    // failure 時の挙動はサービス側の冪等性に委ねる)。super_admin は本テーブルから状況確認可能。
    return NextResponse.json(
      { error: { code: 'CRON_EXECUTION_FAILED', message } },
      { status: 500 },
    );
  }
}

/**
 * x-forwarded-for ヘッダから呼出元 IP を抽出する。
 * Netlify Edge が複数 IP を `, ` 区切りで付与する場合、**先頭** が真のクライアント IP。
 *
 * 返値は最大 45 文字 (= IPv6 の最長表現)。VARCHAR(45) 列に収まる。
 */
function extractInvokerIp(req: NextRequest): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (!xff) return null;
  const first = xff.split(',')[0]?.trim();
  if (!first) return null;
  return first.slice(0, 45);
}

/**
 * status='running' レコードを作成する。失敗時は null を返し log を諦める (= cron 本体は続行)。
 */
async function safeCreateRunningLog(
  cronName: string,
  invokerIp: string | null,
): Promise<string | null> {
  try {
    const created = await prisma.cronExecutionLog.create({
      data: { cronName, status: 'running', invokerIp },
      select: { id: true },
    });
    return created.id;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[cron-execution-log] failed to create running record', {
      cronName,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * status='running' → 'success'|'failure' に update する。logId が null (= 開始 log 失敗時) なら何もしない。
 */
async function safeCompleteLog(
  logId: string | null,
  patch: {
    status: 'success' | 'failure';
    durationMs: number;
    payloadJson?: Record<string, unknown>;
    errorMessage?: string;
    errorStack?: string | null;
  },
): Promise<void> {
  if (!logId) return;
  try {
    // Prisma の JsonB 列 (@db.JsonB) は内部的に Prisma.InputJsonValue を要求する。
    // 本ヘルパは cron route が返す任意の `data` を保存するため、構造的に JSON 互換だが TS の
    // 型推論で食い違う。webhooks/stripe/route.ts と同じ `as unknown as object` キャストに統一。
    await prisma.cronExecutionLog.update({
      where: { id: logId },
      data: {
        status: patch.status,
        completedAt: new Date(),
        durationMs: patch.durationMs,
        payloadJson: patch.payloadJson as unknown as object,
        errorMessage: patch.errorMessage,
        errorStack: patch.errorStack ?? null,
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[cron-execution-log] failed to update log', {
      logId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
