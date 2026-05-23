/**
 * POST /api/auth/resend-verification (Phase 1 / feat/signup-email-resend-ux / 2026-05-23)
 *
 * サインアップ後にメールが届かない顧客のための **招待メール再送 API**。
 *
 * 設計:
 *   - **公開 API** (middleware の PUBLIC_PATHS に含まれる `/api/auth/*` で吸収)
 *   - **3 軸 Rate Limit** で abuse 防止:
 *       1. IP 別: 1 時間に 3 回まで (= bot 防御)
 *       2. tenantSlug 別: 1 時間に 3 回まで (= 同テナントへの spam 防止)
 *       3. email 別: 24 時間に 5 回まで (= 受信者への spam 防止 + Brevo Free 枠 300/日の保護)
 *   - **User enumeration 防止**: 存在しない tenant / email / 既活性化済ユーザでも 200 OK を返す
 *     (= 攻撃者が email 列挙できないようにする)
 *   - **Honeypot は不要**: signup 経由でのみ到達する画面からの呼出のため、bot 流入は少ない想定
 *
 * Body: { email: string, tenantSlug: string }
 *
 * Response (success):
 *   200 OK
 *   { data: { message, cooldownSeconds, remainingCountByIp, remainingCountByEmail } }
 *
 * エラー:
 *   - 400: VALIDATION_ERROR (body 形式不正)
 *   - 429: RATE_LIMITED (= retry-after を含む)
 *   - 502: EMAIL_SEND_FAILED (= Brevo 等の外部 ESP エラー、再試行可)
 *
 * 関連:
 *   - サービス: src/services/email-verification.service.ts (resendVerificationEmail)
 *   - UI: src/app/(auth)/signup/page.tsx (success 画面の「再送」ボタン)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resendVerificationEmail } from '@/services/email-verification.service';
import { getDefaultRateLimiter } from '@/lib/llm/rate-limiter';

// ----------------------------------------------------------------
// Rate Limit 設定 (3 軸)
// ----------------------------------------------------------------

/** IP 別: 1 時間 3 回 (bot 防御の primary) */
const RESEND_IP_LIMIT = 3;
const RESEND_IP_WINDOW_SEC = 3600;

/** tenantSlug 別: 1 時間 3 回 (= 同テナントへの spam 防止) */
const RESEND_TENANT_LIMIT = 3;
const RESEND_TENANT_WINDOW_SEC = 3600;

/** email 別: 24 時間 5 回 (= 受信者への spam 防止 + Brevo Free 枠 300/日の保護) */
const RESEND_EMAIL_LIMIT = 5;
const RESEND_EMAIL_WINDOW_SEC = 24 * 3600;

// ----------------------------------------------------------------
// 入力スキーマ
// ----------------------------------------------------------------

const ResendVerificationInputSchema = z.object({
  email: z.string().trim().email({ message: 'メールアドレス形式が不正です' }).max(255),
  // ADR-0016 (2026-05-20): tenant-scoped 一意化で tenantSlug 必須
  tenantSlug: z
    .string()
    .trim()
    .regex(/^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$/, {
      message: 'tenantSlug 形式が不正です',
    }),
});

// ----------------------------------------------------------------
// Handler
// ----------------------------------------------------------------

export async function POST(req: NextRequest) {
  // ---------- 1. Body 取得 + zod 検証 ----------
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'リクエスト JSON が不正です' } },
      { status: 400 },
    );
  }

  const parsed = ResendVerificationInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? '入力内容に誤りがあります',
        },
      },
      { status: 400 },
    );
  }
  const { email, tenantSlug } = parsed.data;

  // ---------- 2. Rate Limit (3 軸) ----------
  const forwarded = req.headers.get('x-forwarded-for') ?? '';
  const ip = forwarded.split(',')[0]?.trim() || 'unknown';
  const rateLimiter = getDefaultRateLimiter();

  // IP 軸
  const rlIp = await rateLimiter.check(`resend:ip:${ip}:hour`, {
    limit: RESEND_IP_LIMIT,
    windowSec: RESEND_IP_WINDOW_SEC,
  });
  if (!rlIp.allowed) {
    return NextResponse.json(
      {
        error: {
          code: 'RATE_LIMITED',
          message: '再送回数の上限に達しました。しばらくしてから再度お試しください。',
        },
      },
      {
        status: 429,
        headers: rlIp.retryAfterSec ? { 'Retry-After': String(rlIp.retryAfterSec) } : {},
      },
    );
  }

  // tenant 軸
  const rlTenant = await rateLimiter.check(`resend:tenant:${tenantSlug}:hour`, {
    limit: RESEND_TENANT_LIMIT,
    windowSec: RESEND_TENANT_WINDOW_SEC,
  });
  if (!rlTenant.allowed) {
    return NextResponse.json(
      {
        error: {
          code: 'RATE_LIMITED',
          message: '再送回数の上限に達しました。しばらくしてから再度お試しください。',
        },
      },
      {
        status: 429,
        headers: rlTenant.retryAfterSec ? { 'Retry-After': String(rlTenant.retryAfterSec) } : {},
      },
    );
  }

  // email 軸 (24h 5 回)
  const rlEmail = await rateLimiter.check(`resend:email:${email.toLowerCase()}:day`, {
    limit: RESEND_EMAIL_LIMIT,
    windowSec: RESEND_EMAIL_WINDOW_SEC,
  });
  if (!rlEmail.allowed) {
    return NextResponse.json(
      {
        error: {
          code: 'RATE_LIMITED',
          message: '本日の再送回数の上限に達しました。明日以降に再度お試しください。',
        },
      },
      {
        status: 429,
        headers: rlEmail.retryAfterSec ? { 'Retry-After': String(rlEmail.retryAfterSec) } : {},
      },
    );
  }

  // ---------- 3. Service 呼び出し ----------
  const baseUrl = process.env.NEXTAUTH_URL || req.nextUrl.origin;
  const result = await resendVerificationEmail(email, tenantSlug, baseUrl);

  if (!result.ok) {
    return NextResponse.json(
      { error: { code: result.reason, message: result.message } },
      { status: 502 },
    );
  }

  // ok (sent / silent_skip 共通) → enumeration 防止のため UI への返答は同一
  return NextResponse.json(
    {
      data: {
        message: '招待メールを再送しました。受信箱と迷惑メールフォルダをご確認ください。',
        // クライアント側でクールダウン表示・残り回数表示に使う
        // 注: IP 軸が枯渇する手前で UI を抑制したいため IP 軸の残り情報のみ返す
        cooldownSeconds: 0, // 成功直後は次の再送可能 (= rate limit の許容範囲内)
      },
    },
    { status: 200 },
  );
}
