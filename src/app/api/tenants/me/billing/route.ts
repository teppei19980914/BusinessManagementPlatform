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
import { updateBillingContact, CreditCardNotRegisteredError } from '@/services/tenant-self.service';

// 2026-05-09 (PR C / #5/#8/#10): 個人法人切替 + 住所サブフィールド化。
//   PATCH 用なので各フィールドはすべて optional。送られてきた fields のみ update する。
//   billingCompanyName: 法人切替時は client から required 文字列、個人切替時は null クリア許可。
//   refine は意味的整合性 (= 法人なのに会社名空) を防ぐ用途で個別 endpoint 側に追加。
const BillingPatchSchema = z
  .object({
    billingType: z.enum(['corporate', 'individual']).optional(),
    billingCompanyName: z.string().trim().max(200).nullable().optional(),
    billingContactName: z.string().trim().min(1).max(100).optional(),
    billingContactEmail: z.string().trim().email().max(255).optional(),
    // 構造化住所 (#8)
    billingPostalCode: z.string().trim().regex(/^\d{3}-?\d{4}$/, {
      message: '郵便番号は 7 桁 (例 100-0001) で入力してください',
    }).optional(),
    billingPrefecture: z.string().trim().min(1).max(20).optional(),
    billingCity: z.string().trim().min(1).max(100).optional(),
    billingStreetAddress: z.string().trim().min(1).max(200).optional(),
    // (#10) building は optional。null クリアも可。
    billingBuildingName: z.string().trim().max(200).nullable().optional(),
    // 任意項目: null クリアも許可
    billingPhoneNumber: z.string().trim().max(20).nullable().optional(),
    // 2026-05-21 (PR #425): クレジットカード払い対応に伴い 'credit_card' を許可。
    //   - invoice → credit_card: paymentMethod のみ DB 更新。実カード登録は別途
    //     「クレジットカード情報更新」ボタン → POST /api/tenants/me/billing/stripe/setup へ
    //   - credit_card → invoice: updateBillingContact 側で Stripe Subscription を即時 cancel
    //     (= 当月分は運営手動 invoice。Storage add-on の二重引落防止)
    // 2026-05-15: 'bank_transfer' を廃止し 'invoice' に統合 (UI ラベル「銀行振込」, 内部値 'invoice')。
    //   旧 'bank_transfer' を送ってきた場合は VALIDATION_ERROR で reject (= 画面で再選択を促す)。
    paymentMethod: z.enum(['invoice', 'credit_card']).optional(),
  })
  // 2026-05-09 (PR C / #5): 法人切替 + 会社名を同時に送ってきた場合は会社名必須。
  //   billingType だけ切替えで会社名を送らないケース (= 既存値を維持) は許容する。
  .refine(
    (d) => {
      if (d.billingType !== 'corporate') return true;
      // billingCompanyName を明示的に送ってこなかった場合は既存値維持で OK
      if (d.billingCompanyName === undefined) return true;
      // 法人切替で会社名を空 / null に設定しようとしている → reject
      return d.billingCompanyName != null && d.billingCompanyName.trim().length > 0;
    },
    {
      path: ['billingCompanyName'],
      message: '法人プランでは会社名 / 法人名は必須です',
    },
  );

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

  try {
    await updateBillingContact(user.tenantId, parsed.data);
  } catch (e) {
    // PR #425 (2026-05-22) ★severity-1★: カード未登録で credit_card 切替を試みた UI バイパス
    //   は 422 で reject。正常 UI フローでは BillingContactSection が事前に Stripe Checkout
    //   へ強制遷移するため、本エラーは UI 経由では発生しない (= curl 直叩き等が対象)。
    if (e instanceof CreditCardNotRegisteredError) {
      return NextResponse.json(
        { error: { code: 'CREDIT_CARD_NOT_REGISTERED', message: e.message } },
        { status: 422 },
      );
    }
    throw e;
  }

  return NextResponse.json({ data: { ok: true } });
}
