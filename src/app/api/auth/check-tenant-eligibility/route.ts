/**
 * POST /api/auth/check-tenant-eligibility (ADR-0016 / 2026-05-20)
 *
 * 役割:
 *   新規テナント払い出しフォーム (signup page / super_admin tenants/new) で、
 *   入力 email が **過去/現在のどこかのテナントに登録履歴がある** かを事前判定する。
 *   登録履歴あり → UI で Beginner 選択肢を disable + Expert/Pro 誘導 CTA を表示。
 *
 *   サーバ層の最終判定は tenant-onboarding.service.ts (BEGINNER_REQUIRES_UPGRADE) が
 *   defense-in-depth で実施するため、本 API は **UI ヒント専用** (= bypass されても損害ゼロ)。
 *
 * 認可:
 *   公開エンドポイント (src/config/routes.ts の PUBLIC_PATHS = `/api/auth/*`)。
 *
 * セキュリティ考慮:
 *   - **enumeration リスク**: 同 email がどこかに登録済みかが露出する。
 *     P-B 強化前 (2026-05-20 以前) と同レベル (= 既に BEGINNER_NOT_AVAILABLE_FOR_RETURNING
 *     エラーで露出していた情報差分はゼロ)。新規 attack surface ではない。
 *   - **rate limit**: 5 分間に 10 req まで (大量列挙の現実的コスト確保)。
 *   - **return 値**: 「登録あり/なし」のみ。ユーザ名や所属テナント等は一切返さない。
 *
 * 入力: { billingContactEmail: string, initialAdminEmail: string }
 * 出力: { beginnerAvailable: boolean, reason: 'none' | 'past_email_found', message?: string }
 *
 * 関連:
 *   - サービス: src/services/tenant-onboarding.service.ts (BEGINNER_REQUIRES_UPGRADE)
 *   - UI: src/app/(auth)/signup/page.tsx / src/app/(dashboard)/admin/super/tenants/new/
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { prisma } from '@/lib/db';
import { applyRateLimit } from '@/lib/rate-limit';

const requestSchema = z.object({
  billingContactEmail: z.string().email(),
  initialAdminEmail: z.string().email(),
});

export async function POST(req: NextRequest) {
  // ブルートフォース防御 (= 大量列挙抑制)
  const limited = applyRateLimit(req, { key: 'check-tenant-eligibility' });
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    // バリデーション失敗時も「使える」前提で返す (= UI ヒント無効化)
    //   最終判定はサーバ層で行うので情報漏洩リスクなし。
    return NextResponse.json({ beginnerAvailable: true, reason: 'none' });
  }

  // ADR-0016: tenant-onboarding.service.ts の P-B 強化ロジックと同条件で判定
  //   - tenants.billing_contact_email = いずれか
  //   - users.email = いずれか (削除済含む)
  const [previousTenants, previousUser] = await Promise.all([
    prisma.tenant.findMany({
      where: {
        OR: [
          { billingContactEmail: parsed.data.billingContactEmail },
          { billingContactEmail: parsed.data.initialAdminEmail },
        ],
      },
      select: { id: true },
      take: 1,
    }),
    prisma.user.findFirst({
      where: {
        OR: [
          { email: parsed.data.billingContactEmail },
          { email: parsed.data.initialAdminEmail },
        ],
      },
      select: { id: true },
    }),
  ]);

  if (previousTenants.length > 0 || previousUser != null) {
    return NextResponse.json({
      beginnerAvailable: false,
      reason: 'past_email_found',
      message:
        'このメールアドレスは既に登録履歴があるため、Beginner プランでの新規払い出しはできません。Expert または Pro プランをご選択ください。',
    });
  }

  return NextResponse.json({ beginnerAvailable: true, reason: 'none' });
}
