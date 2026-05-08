/**
 * PATCH /api/tenants/me/billing (P-G / 2026-05-08)
 *
 * テナント管理者が自テナントの請求先情報を更新する。
 *
 * 認可: admin role 必須 (= テナント管理者)
 *
 * Body: { billingCompanyName?, billingContactName?, billingContactEmail?,
 *         billingAddress?, billingPhoneNumber?, paymentMethod? }
 *   - 未指定 (undefined): 変更なし
 *   - null: 値クリア (任意項目のみ。必須項目に null を渡すとアプリ側で reject)
 *
 * エラー:
 *   - 400: VALIDATION_ERROR (zod 検証失敗)
 *   - 401: 未認証
 *   - 403: admin 以外
 *
 * 関連:
 *   - サービス: src/services/tenant-self.service.ts (updateBillingContact)
 *   - UI: src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx (BillingContactSection)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { updateBillingContact } from '@/services/tenant-self.service';

const BillingPatchSchema = z.object({
  billingCompanyName: z.string().trim().min(1).max(200).optional(),
  billingContactName: z.string().trim().min(1).max(100).optional(),
  billingContactEmail: z.string().trim().email().max(255).optional(),
  billingAddress: z.string().trim().min(1).optional(),
  // 任意項目: null クリアも許可
  billingPhoneNumber: z.string().trim().max(20).nullable().optional(),
  // 2026-05-09 (#4): クレジットカードは UI 非活性 + API でも reject (defense-in-depth)。
  //   将来対応する際に 'credit_card' を再追加する。
  paymentMethod: z.enum(['invoice', 'bank_transfer']).optional(),
});

export async function PATCH(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'リクエスト JSON が不正です' } },
      { status: 400 },
    );
  }

  const parsed = BillingPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? '入力内容に誤りがあります' } },
      { status: 400 },
    );
  }

  await updateBillingContact(user.tenantId, parsed.data);

  return NextResponse.json({ data: { ok: true } });
}
