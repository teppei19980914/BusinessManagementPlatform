/**
 * POST /api/webhooks/stripe - Stripe Webhook 受信エンドポイント (PR-S4 / 2026-05-14)
 *
 * 役割:
 *   Stripe から POST される Webhook イベントを受信し、署名検証 → 冪等性確保 → ハンドラ dispatch。
 *
 * 認可:
 *   middleware の PUBLIC_PATHS に含まれており Cookie 認証は通過する。
 *   **Stripe signature 検証が唯一の認可** (= stripe.webhooks.constructEvent 失敗で 400)。
 *
 * フロー:
 *   1. STRIPE_ENABLED feature flag を確認 (false なら 503)
 *   2. 生 body + stripe-signature ヘッダで構造を検証 (= 改ざん検知 / 偽装防止)
 *   3. StripeWebhookEvent.upsert で event.id 単位の冪等性を確保
 *      - 既存レコードで processedAt != null → 即 200 (= 二重処理を防ぐ)
 *      - 既存レコードで処理中 (= 別ワーカが並行処理) → 即 200 (= Stripe 再送に任せる)
 *   4. dispatchStripeWebhookEvent でイベント別ハンドラを実行
 *   5. 成功: processedAt = now, errorMessage = null を更新 → 200
 *   6. 失敗: errorMessage 記録 + retryCount++ → 500 (= Stripe が自動再送する)
 *
 * 設計判断:
 *   - **生 body の取得**: `req.text()` で取り出す (= JSON parse 前)。`constructEvent` は生 body
 *     に対する HMAC SHA256 を検証するため、body を JSON parse すると署名検証が失敗する
 *   - **失敗時の 5xx 返却**: Stripe は 5xx を最大 3 日間自動再送する (= 公式仕様)。
 *     4xx を返すと再送されないため、一時的失敗 (DB エラー等) は 5xx 必須
 *   - **未処理 retryCount >= 3 の DLQ 入りは route.ts 内では判定しない** (= super_admin
 *     ダッシュボードで一覧化、PR-S6 で実装予定)
 *
 * 関連:
 *   - 仕様: docs/business/STRIPE_BILLING.md §3.2 / §6.2 / §7.1
 *   - ハンドラ: src/services/stripe-webhook-handlers.service.ts
 *   - 冪等性テーブル: prisma/schema.prisma model StripeWebhookEvent
 */

import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { prisma } from '@/lib/db';
import { getStripe, getStripeWebhookSecret, isStripeEnabled } from '@/lib/stripe';
import { dispatchStripeWebhookEvent } from '@/services/stripe-webhook-handlers.service';

/**
 * Next.js App Router: Route Handlers は body parsing をデフォルトで行うが、本ルートは生 body が必要。
 * `req.text()` で取り出すので明示的な config は不要 (Next.js 15 ではこれで raw body が得られる)。
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // §1. Feature flag チェック
  if (!isStripeEnabled()) {
    return NextResponse.json(
      { error: { code: 'STRIPE_DISABLED', message: 'Stripe integration is currently disabled' } },
      { status: 503 },
    );
  }

  // §2. 署名検証
  const signature = req.headers.get('stripe-signature');
  if (signature == null) {
    return NextResponse.json(
      { error: { code: 'MISSING_SIGNATURE', message: 'stripe-signature header is required' } },
      { status: 400 },
    );
  }

  const rawBody = await req.text();
  const stripe = getStripe();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, getStripeWebhookSecret());
  } catch (e) {
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_SIGNATURE',
          message: e instanceof Error ? e.message : 'Signature verification failed',
        },
      },
      { status: 400 },
    );
  }

  // §3. 冪等性確保 (= event.id ベース)
  //   - 既に processedAt != null なら早期 return (= Stripe 再送への対応)
  //   - レコード新規作成時は payloadJson に event 全体を保存
  const existing = await prisma.stripeWebhookEvent.findUnique({
    where: { id: event.id },
    select: { id: true, processedAt: true, retryCount: true },
  });

  if (existing != null && existing.processedAt != null) {
    return NextResponse.json({ data: { status: 'already_processed', eventId: event.id } });
  }

  if (existing == null) {
    await prisma.stripeWebhookEvent.create({
      data: {
        id: event.id,
        type: event.type,
        payloadJson: event as unknown as object,
        retryCount: 0,
      },
    });
  }

  // §4. ハンドラ dispatch
  try {
    const result = await dispatchStripeWebhookEvent(event);

    // §5. 処理成功: processedAt を確定
    await prisma.stripeWebhookEvent.update({
      where: { id: event.id },
      data: {
        processedAt: new Date(),
        errorMessage: null,
        nextRetryAt: null,
      },
    });

    return NextResponse.json({
      data: { status: 'processed', eventId: event.id, action: result.action },
    });
  } catch (e) {
    // §6. 処理失敗: errorMessage + retryCount を記録、5xx で Stripe に再送を促す
    const message = e instanceof Error ? e.message : String(e);
    const nextRetryCount = (existing?.retryCount ?? 0) + 1;
    // exponential backoff: 1, 5, 15 分 (= 4 回目で DLQ 入り)
    const backoffMin = [1, 5, 15][nextRetryCount - 1] ?? null;
    const nextRetryAt = backoffMin != null ? new Date(Date.now() + backoffMin * 60 * 1000) : null;

    await prisma.stripeWebhookEvent.update({
      where: { id: event.id },
      data: {
        errorMessage: message.slice(0, 1000),
        retryCount: nextRetryCount,
        nextRetryAt,
      },
    });

    return NextResponse.json(
      { error: { code: 'WEBHOOK_HANDLER_ERROR', message } },
      { status: 500 },
    );
  }
}
