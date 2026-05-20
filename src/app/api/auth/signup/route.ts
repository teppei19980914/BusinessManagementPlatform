/**
 * POST /api/auth/signup (P-G / 2026-05-08)
 *
 * 公開セルフサインアップ API。外部ユーザがテナントを自分で開設する経路。
 *
 * スパム対策 (3 重防御):
 *   1. **Honeypot field** (`hp_url`): 通常ユーザは空のまま、bot が自動で埋めるとリジェクト
 *   2. **Rate limit per IP**: 1 IP につき 1 時間に 5 回まで。同 IP からの大量サインアップ抑止
 *   3. **メール検証必須**: 招待メール経由でパスワード設定するまで `isActive=false`、
 *      ログイン不能 (= 偽メールでの登録は実質無効化)
 *
 * 認可:
 *   公開 API (PUBLIC_PATHS に `/api/auth` が登録されているため middleware は通過)
 *
 * Body: TenantOnboardingInput + honeypot field
 *
 * エラー:
 *   - 400: VALIDATION_ERROR
 *   - 409: SLUG_CONFLICT (ADR-0016: EMAIL_CONFLICT は廃止 — tenant-scoped 一意化で発生不能)
 *   - 429: RATE_LIMITED (短時間に 5 回超過)
 *   - 502: EMAIL_SEND_FAILED
 *
 * 関連:
 *   - サービス: src/services/tenant-onboarding.service.ts (createTenantBySignup)
 *   - UI: src/app/signup/page.tsx
 *   - middleware の公開ルート定義: src/config/routes.ts (PUBLIC_PATHS)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createTenantBySignup } from '@/services/tenant-onboarding.service';
import { getDefaultRateLimiter } from '@/lib/llm/rate-limiter';

/** 1 IP あたり 1 時間に 5 回まで */
const SIGNUP_RATE_LIMIT_PER_HOUR = 5;

export async function POST(req: NextRequest) {
  // ---------- 1. Rate limit per IP ----------
  // x-forwarded-for は最初の IP (= 直接の client) を取る。Vercel 等で複数段の場合に安全。
  const forwarded = req.headers.get('x-forwarded-for') ?? '';
  const ip = forwarded.split(',')[0]?.trim() || 'unknown';
  const rateLimiter = getDefaultRateLimiter();
  const rl = await rateLimiter.check(`signup:${ip}:hour`, {
    limit: SIGNUP_RATE_LIMIT_PER_HOUR,
    windowSec: 3600,
  });
  if (!rl.allowed) {
    return NextResponse.json(
      {
        error: {
          code: 'RATE_LIMITED',
          message: 'サインアップの試行回数が上限を超えました。しばらくしてから再度お試しください。',
        },
      },
      {
        status: 429,
        headers: rl.retryAfterSec ? { 'Retry-After': String(rl.retryAfterSec) } : {},
      },
    );
  }

  // ---------- 2. Body 取得 + honeypot 検証 ----------
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'リクエスト JSON が不正です' } },
      { status: 400 },
    );
  }

  // honeypot: 通常ユーザは空のまま、bot が埋めると "" 以外になる
  // 盗用しにくいよう URL っぽいフィールド名にする (= 'website' 等は自動入力されやすいため避ける)
  const bodyObj = body as Record<string, unknown> | null;
  const honeypotValue = bodyObj?.hp_url;
  if (typeof honeypotValue === 'string' && honeypotValue.trim() !== '') {
    // bot 検知: silently 200 を返す (= bot に検出されないよう成功を装う)
    // 実際にはテナント作成は行わない
    return NextResponse.json({ data: { ok: true } }, { status: 200 });
  }

  // ---------- 3. テナント作成 ----------
  const baseUrl = process.env.NEXTAUTH_URL || req.nextUrl.origin;
  // honeypot 以外のフィールドのみを onboarding service に渡す
  const onboardingInput = bodyObj == null ? {} : { ...bodyObj };
  if (onboardingInput && 'hp_url' in onboardingInput) delete onboardingInput.hp_url;
  // P-B (2026-05-08): 公開セルフサインアップは **強制的に Beginner プラン**。
  //   ユーザが入力で plan: 'pro' 等を送ってきても無視。最初から上位プランで開設したい
  //   顧客は super_admin による手動払い出し経路を使ってもらう。
  onboardingInput.plan = 'beginner';

  const result = await createTenantBySignup(onboardingInput, baseUrl);

  if (result.ok) {
    return NextResponse.json(
      {
        data: {
          // 新規テナント / 初期 admin の ID は返さない (情報漏洩抑止)
          message: '招待メールを送信しました。メールに記載のリンクからパスワードを設定してください。',
        },
      },
      { status: 201 },
    );
  }

  switch (result.reason) {
    case 'VALIDATION_ERROR':
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: result.message } },
        { status: 400 },
      );
    case 'SLUG_CONFLICT':
      return NextResponse.json(
        { error: { code: 'SLUG_CONFLICT', message: result.message } },
        { status: 409 },
      );
    // ADR-0016 (2026-05-20): EMAIL_CONFLICT は tenant-scoped 一意化で発生不能になったため削除
    case 'EMAIL_SEND_FAILED':
      return NextResponse.json(
        { error: { code: 'EMAIL_SEND_FAILED', message: result.message } },
        { status: 502 },
      );
    case 'BEGINNER_NOT_AVAILABLE_FOR_RETURNING':
      return NextResponse.json(
        { error: { code: 'BEGINNER_NOT_AVAILABLE_FOR_RETURNING', message: result.message } },
        { status: 409 },
      );
  }
}
