/**
 * BillingHistory 整合性検証サービス (PR-V8.4 / 2026-05-19)
 *
 * ★請求重要 (事業継続性の最終防衛線)★
 *   BillingHistory の `totalAmountJpy` は「請求書 PDF / Stripe Invoice / 月次合計」の根拠であり、
 *   これが誤った値で永続化されると、検知も修復も困難。本 service は **保存された請求金額と
 *   再計算結果を突合** し、不整合があれば診断ダッシュボードに表示する最終防衛。
 *
 * 検証する不変条件 (invariant):
 *   1. `totalAmountJpy === amountJpy + taxAmountJpy` (= 税込合計の単純和)
 *   2. `taxAmountJpy === calculateTaxJpy(amountJpy)` (= 消費税計算式と整合、四捨五入)
 *   3. `amountJpy >= 0` (= 負値は不正、refund は別 row で表現)
 *   4. `totalAmountJpy >= 0`
 *
 * 設計判断:
 *   - **読み取り専用**: 検知のみで自動修復しない。請求金額の自動上書きは事故リスクが大きい
 *     ため、super_admin が手動で修復 (= 該当月の `billing-monthly-aggregation` 再実行 or
 *     `regenerateMonthlyHistoryFromApiCallLog` で snapshot 再生成 + Stripe 側手動調整)。
 *   - **対象期間は直近 6 ヶ月**: 古い不整合は実害が消えている可能性 + 性能制約
 *   - **status='canceled' / 'replaced_by_stripe' は対象外**: これらは意図的に金額が
 *     不一致になる場合がある (= 月途中切替で部分課金等)
 *
 * 関連:
 *   - 請求金額算出: src/services/billing-aggregation.service.ts:aggregateMonthlyBilling
 *   - 税計算: src/config/billing.ts:calculateTaxJpy
 *   - 表示: src/app/(dashboard)/admin/super/diagnostics/page.tsx
 */

import { prisma } from '@/lib/db';
import { calculateTaxJpy, AMOUNT_RECONCILE_TOLERANCE_JPY } from '@/config/billing';

// ================================================================
// 公開型
// ================================================================

/** 不整合の種類。複数同時に検出する場合は配列で持つ。 */
export type BillingIntegrityIssueKind =
  /** totalAmountJpy != amountJpy + taxAmountJpy (= 単純和違反) */
  | 'total_mismatch'
  /** taxAmountJpy != calculateTaxJpy(amountJpy) (= 消費税計算違反) */
  | 'tax_mismatch'
  /** amountJpy < 0 (= 税抜金額が負値) */
  | 'negative_amount'
  /** totalAmountJpy < 0 (= 税込合計が負値) */
  | 'negative_total';

export type BillingIntegrityIssue = {
  billingHistoryId: string;
  tenantId: string;
  yearMonth: string;
  paymentMethod: string;
  status: string;
  /** 保存値 */
  storedAmountJpy: number;
  storedTaxAmountJpy: number;
  storedTotalAmountJpy: number;
  /** 再計算値 */
  expectedTaxAmountJpy: number;
  expectedTotalAmountJpy: number;
  /** 不整合の種類 (複数同時) */
  issueKinds: BillingIntegrityIssueKind[];
};

// ================================================================
// 公開関数
// ================================================================

/**
 * 直近 N ヶ月の BillingHistory を走査し、不整合を持つ行を返す。
 *
 * @param monthsBack 走査対象月数 (デフォルト 6 ヶ月)
 * @returns 不整合行の配列。0 件なら空配列。
 */
export async function detectBillingHistoryIntegrityIssues(
  monthsBack: number = 6,
  now: Date = new Date(),
): Promise<BillingIntegrityIssue[]> {
  // 走査対象月 (= now - monthsBack 〜 now) の yearMonth リストを生成
  const targetMonths = generateYearMonthRange(now, monthsBack);

  // status='canceled' / 'replaced_by_stripe' は意図的不一致を許容するため除外
  const rows = await prisma.billingHistory.findMany({
    where: {
      yearMonth: { in: targetMonths },
      status: { notIn: ['canceled', 'replaced_by_stripe'] },
    },
    select: {
      id: true,
      tenantId: true,
      yearMonth: true,
      paymentMethod: true,
      status: true,
      amountJpy: true,
      taxAmountJpy: true,
      totalAmountJpy: true,
    },
  });

  const issues: BillingIntegrityIssue[] = [];
  for (const row of rows) {
    const issueKinds: BillingIntegrityIssueKind[] = [];

    // 不変条件 1: totalAmountJpy === amountJpy + taxAmountJpy
    const expectedTotal = row.amountJpy + row.taxAmountJpy;
    if (Math.abs(row.totalAmountJpy - expectedTotal) > AMOUNT_RECONCILE_TOLERANCE_JPY) {
      issueKinds.push('total_mismatch');
    }

    // 不変条件 2: taxAmountJpy === calculateTaxJpy(amountJpy)
    const expectedTax = calculateTaxJpy(row.amountJpy);
    if (Math.abs(row.taxAmountJpy - expectedTax) > AMOUNT_RECONCILE_TOLERANCE_JPY) {
      issueKinds.push('tax_mismatch');
    }

    // 不変条件 3: amountJpy >= 0
    if (row.amountJpy < 0) {
      issueKinds.push('negative_amount');
    }

    // 不変条件 4: totalAmountJpy >= 0
    if (row.totalAmountJpy < 0) {
      issueKinds.push('negative_total');
    }

    if (issueKinds.length > 0) {
      issues.push({
        billingHistoryId: row.id,
        tenantId: row.tenantId,
        yearMonth: row.yearMonth,
        paymentMethod: row.paymentMethod,
        status: row.status,
        storedAmountJpy: row.amountJpy,
        storedTaxAmountJpy: row.taxAmountJpy,
        storedTotalAmountJpy: row.totalAmountJpy,
        expectedTaxAmountJpy: expectedTax,
        expectedTotalAmountJpy: expectedTotal,
        issueKinds,
      });
    }
  }

  return issues;
}

/**
 * 'YYYY-MM' 文字列のリストを「now の月から monthsBack ヶ月遡って」生成する。
 * 例: now=2026-05-19, monthsBack=6 → ['2026-05', '2026-04', '2026-03', '2026-02', '2026-01', '2025-12']
 */
function generateYearMonthRange(now: Date, monthsBack: number): string[] {
  const result: string[] = [];
  for (let i = 0; i < monthsBack; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    result.push(`${y}-${m}`);
  }
  return result;
}
