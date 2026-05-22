/**
 * POST /api/auth/check-tenant-eligibility (ADR-0016 Revised / 2026-05-22)
 *
 * 役割:
 *   新規テナント払い出しフォーム (signup page) で、入力 email が **過去/現在のどこかの
 *   テナントに登録履歴がある** かを事前判定する UI ヒント API。
 *   サーバ層の最終判定は tenant-onboarding.service.ts (3 層判定) が defense-in-depth で
 *   実施するため、本 API は bypass されても損害ゼロ。
 *
 * 3 層判定 (ADR-0016 Revised / 2026-05-22):
 *   - 層 1 (signupAllowed=false, reason='owned'):
 *       initialAdminEmail を持つ user が、いずれかの tenant の createdByUserId に紐付き
 *       → 「自前テナント保有」: 公開フォーム完全不可。UI はフォーム全体 disable + admin 問合せ動線。
 *   - 層 2 (beginnerAvailable=false, reason='past_email_found'):
 *       initialAdminEmail が users に存在するが、層 1 ではない (= 招待 / Default 所属のみ)
 *       → Beginner 不可。UI は Beginner radio disable + Expert/Pro 誘導 CTA。
 *   - 層 3 (beginnerAvailable=true, reason='none'): 履歴一切なし → 全プラン可。
 *
 * 認可:
 *   公開エンドポイント (src/config/routes.ts の PUBLIC_PATHS = `/api/auth/*`)。
 *
 * セキュリティ考慮:
 *   - enumeration リスク: 同 email の登録状況が露出する (層 1 / 層 2 / 層 3 の 3 値)。
 *     旧 2 値判定からの情報差分は「層 1 と層 2 の区別」のみで、UX 上必要な最小情報。
 *   - rate limit: 5 分間に 10 req まで。
 *   - return 値: 「登録状況」のみ。ユーザ名や所属テナント等は一切返さない。
 *
 * 入力: { billingContactEmail?: string, initialAdminEmail: string }
 *   - billingContactEmail は判定対象外 (ADR-0016 Revised で initialAdminEmail のみに変更)
 *     だが、後方互換のため受信は許容する。
 *
 * 出力:
 *   {
 *     signupAllowed: boolean,         // false = 層 1 (フォーム全体 disable)
 *     beginnerAvailable: boolean,     // false = 層 2 以降 (Beginner radio disable)
 *     reason: 'owned' | 'past_email_found' | 'none',
 *     message?: string
 *   }
 *
 * 関連:
 *   - サービス: src/services/tenant-onboarding.service.ts (OWNED_TENANT_EXISTS / BEGINNER_REQUIRES_UPGRADE)
 *   - UI: src/app/(auth)/signup/page.tsx
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { prisma } from '@/lib/db';
import { applyRateLimit } from '@/lib/rate-limit';

const requestSchema = z.object({
  // 受信は許容するが判定対象外 (後方互換)
  billingContactEmail: z.string().email().optional(),
  initialAdminEmail: z.string().email(),
});

const OWNED_TENANT_MESSAGE =
  '入力された初期管理者メールは、既に「自前テナント」を保有しているユーザのものです。追加のテナント払い出しはシステム管理者へお問い合わせください。';
const BEGINNER_REQUIRES_UPGRADE_MESSAGE =
  'このメールアドレスは既に登録履歴があるため、Beginner プランでの新規払い出しはできません。Expert または Pro プランをご選択ください。';

export async function POST(req: NextRequest) {
  // ブルートフォース防御 (= 大量列挙抑制)
  const limited = applyRateLimit(req, { key: 'check-tenant-eligibility' });
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    // バリデーション失敗時も「使える」前提で返す (= UI ヒント無効化)。
    //   最終判定はサーバ層で行うので情報漏洩リスクなし。
    return NextResponse.json({
      signupAllowed: true,
      beginnerAvailable: true,
      reason: 'none',
    });
  }

  // ADR-0016 Revised (2026-05-22): tenant-onboarding.service.ts の 3 層判定と同条件。
  //   判定キーは initialAdminEmail のみ (billingContactEmail は対象外)。
  //   DB 接続失敗時は fail-open (= reason='none' で UI ヒント無効化) で返す。本 API は UI ヒント専用で、
  //   サーバ層の最終判定 (tenant-onboarding.service.ts) が同じ DB クエリを実行するため、DB が落ちていれば
  //   そちらでも 5xx で reject される。client が「層 1 user に signup できる気にさせる」誤動作を一瞬
  //   起こしても、サーバ最終判定で確実に block される (defense-in-depth)。
  try {
    const usersWithSameEmail = await prisma.user.findMany({
      where: { email: parsed.data.initialAdminEmail },
      select: { id: true },
    });

    if (usersWithSameEmail.length === 0) {
      // 層 3: 完全な新規
      return NextResponse.json({
        signupAllowed: true,
        beginnerAvailable: true,
        reason: 'none',
      });
    }

    const userIds = usersWithSameEmail.map((u) => u.id);
    // 層 1 判定: createdByUserId IS NOT NULL かつ user.id IN (...) のテナントが存在するか。
    //   `createdByUserId: { in: userIds }` は NULL を自動除外するため、backfill 漏れの NULL tenant は
    //   ここに hit しない (= soft relaxation 経路。migration の RAISE WARNING で運用者通知。
    //   詳細は ADR-0016 Revised 「運用注意 D. backfill NULL 残置」)。
    const ownedTenant = await prisma.tenant.findFirst({
      where: { createdByUserId: { in: userIds } },
      select: { id: true },
    });

    if (ownedTenant != null) {
      // 層 1: 自前テナント保有 (= 公開フォーム完全不可)
      return NextResponse.json({
        signupAllowed: false,
        beginnerAvailable: false,
        reason: 'owned',
        message: OWNED_TENANT_MESSAGE,
      });
    }

    // 層 2: users に email あり (招待 / Default 所属) → Beginner 不可、Expert/Pro 可
    return NextResponse.json({
      signupAllowed: true,
      beginnerAvailable: false,
      reason: 'past_email_found',
      message: BEGINNER_REQUIRES_UPGRADE_MESSAGE,
    });
  } catch {
    // DB error 時は fail-open (= サーバ最終判定の defense-in-depth に委ねる)
    //   client UI が「層 3 表示」になっても、submit 時の /api/auth/signup が同じ DB クエリで弾くため
    //   実害なし。500 を出さないことで client の form 表示自体は維持。
    return NextResponse.json({
      signupAllowed: true,
      beginnerAvailable: true,
      reason: 'none',
    });
  }
}
