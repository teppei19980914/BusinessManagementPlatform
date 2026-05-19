/**
 * 請求書 (invoice / bank_transfer) 払いテナントの月次集計サービス (PR-V7a / 2026-05-19)
 *
 * credit_card 払いは Stripe が月末に Invoice を自動生成 → Webhook で BillingHistory に同期される。
 * 請求書払いは Stripe を介さないため、ApiCallLog + Storage add-on から自社で月次集計する必要がある。
 *
 * 監査 C-G1 (S 優先度): 「invoice 払い側の月次集計ロジック未実装」を解消する実装。
 *
 * 設計:
 *   - **対象**: paymentMethod が 'invoice' or 'bank_transfer' の全テナント (MANAGEMENT 除外)
 *   - **テナント TZ ベース月境界**: 各テナント独自の timezone で「当該月の API 呼び出し」を集計
 *   - **idempotent**: 既存 BillingHistory が status='paid'/'refunded'/'replaced_by_stripe' 等
 *     の遷移済レコードは触らない。'pending' のみ金額更新可。
 *   - **解約済テナントも対象**: 解約前に発生した利用は請求対象 (= deletedAt フィルタなし)
 *     ただし「解約済 + 残金 0」は INSERT しない (= 無意味な空請求書を抑制)
 *
 * 関連:
 *   - 定数: src/config/billing.ts (TAX_RATE / calculateInvoiceDueDate)
 *   - 価格: src/config/storage-addon.ts (ADDON_MONTHLY_JPY)
 *   - cron: src/app/api/cron/billing-monthly-aggregation/route.ts
 */

import { prisma } from '@/lib/db';
import { MANAGEMENT_TENANT_ID } from '@/lib/tenant';
import { getTenantMonthStart, getTenantNextMonthStart } from '@/lib/tenant-time';
import { ADDON_MONTHLY_JPY, type StorageAddonPlan } from '@/config/storage-addon';
import { calculateTaxJpy, calculateInvoiceDueDate } from '@/config/billing';
// PR-V7a 再検証 round 2 (2026-05-19): per-tenant 失敗が cron status='success' に紛れて
//   検知されない問題を解消するため、errors.length > 0 で active push を実施
import { sendSuperAdminAlert } from './admin-alert.service';

export type AggregateMonthlyBillingResult = {
  yearMonth: string;
  processedTenants: number;
  upsertedRecords: number;
  skippedTenants: number;
  totalSubtotalJpy: number;
  totalTaxJpy: number;
  totalGrandJpy: number;
  errors: Array<{ tenantId: string; reason: string }>;
};

/**
 * 指定月の invoice/bank_transfer テナント月次請求を集計し BillingHistory に upsert する。
 *
 * @param yearMonth 集計対象月 (= 'YYYY-MM')。通常は前月を指定 (= 月初 cron で実行)
 */
export async function aggregateInvoiceBillingForMonth(
  yearMonth: string,
): Promise<AggregateMonthlyBillingResult> {
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
    throw new Error(`Invalid yearMonth format: ${yearMonth}`);
  }

  // 対象テナント全件 (= 論理削除済も含む。締日前に解約した分の請求は実施する必要がある)
  const tenants = await prisma.tenant.findMany({
    where: {
      paymentMethod: { in: ['invoice', 'bank_transfer'] },
      id: { not: MANAGEMENT_TENANT_ID },
    },
    select: {
      id: true,
      timezone: true,
      storageAddonPlan: true,
      deletedAt: true,
    },
  });

  const paymentDueDate = calculateInvoiceDueDate(yearMonth);
  // 安定したテストのため Date.UTC 中旬を「対象月内」の起点として渡す
  const monthMidPoint = new Date(`${yearMonth}-15T12:00:00Z`);

  const result: AggregateMonthlyBillingResult = {
    yearMonth,
    processedTenants: 0,
    upsertedRecords: 0,
    skippedTenants: 0,
    totalSubtotalJpy: 0,
    totalTaxJpy: 0,
    totalGrandJpy: 0,
    errors: [],
  };

  for (const tenant of tenants) {
    try {
      const tz = tenant.timezone ?? 'Asia/Tokyo';
      const monthStart = getTenantMonthStart(monthMidPoint, tz);
      const monthEnd = getTenantNextMonthStart(monthMidPoint, tz);

      // API 利用料金 (= ApiCallLog.costJpy の単純合計)
      const apiAgg = await prisma.apiCallLog.aggregate({
        where: {
          tenantId: tenant.id,
          createdAt: { gte: monthStart, lt: monthEnd },
        },
        _sum: { costJpy: true },
      });
      const apiSubtotalJpy = apiAgg._sum.costJpy ?? 0;

      // Storage add-on 月額 (= 月途中ダウングレードでも当月分は丸ごと請求する単純化方針)
      const storagePlan = (tenant.storageAddonPlan ?? 'standard') as StorageAddonPlan;
      const storageJpy = ADDON_MONTHLY_JPY[storagePlan] ?? 0;

      const subtotalJpy = apiSubtotalJpy + storageJpy;

      // 「解約済 + ¥0 利用」は請求書発行不要 (= 無意味な空履歴を作らない)
      if (subtotalJpy === 0 && tenant.deletedAt != null) {
        result.skippedTenants += 1;
        continue;
      }

      const taxJpy = calculateTaxJpy(subtotalJpy);
      const totalJpy = subtotalJpy + taxJpy;

      // 既存 status を確認してから upsert (= pending 以外は触らない)
      const existing = await prisma.billingHistory.findUnique({
        where: { tenantId_yearMonth: { tenantId: tenant.id, yearMonth } },
        select: { status: true },
      });
      if (existing != null && existing.status !== 'pending') {
        // paid / failed / refunded / canceled / replaced_by_stripe → 触らない
        result.skippedTenants += 1;
        continue;
      }

      await prisma.billingHistory.upsert({
        where: { tenantId_yearMonth: { tenantId: tenant.id, yearMonth } },
        create: {
          tenantId: tenant.id,
          yearMonth,
          paymentMethod: 'invoice',
          amountJpy: subtotalJpy,
          taxAmountJpy: taxJpy,
          totalAmountJpy: totalJpy,
          status: 'pending',
          paymentDueDate,
          retryCount: 0,
        },
        update: {
          amountJpy: subtotalJpy,
          taxAmountJpy: taxJpy,
          totalAmountJpy: totalJpy,
          paymentDueDate,
        },
      });

      result.processedTenants += 1;
      result.upsertedRecords += 1;
      result.totalSubtotalJpy += subtotalJpy;
      result.totalTaxJpy += taxJpy;
      result.totalGrandJpy += totalJpy;
    } catch (err) {
      result.errors.push({
        tenantId: tenant.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // PR-V7a 再検証 round 2: per-tenant 失敗の active push (= stripe-reconcile と同パターン)
  //   cron-execution-log は overall status='success' で返るため、
  //   この alert がないと super_admin は /admin/super/cron-history を見るまで気付けない。
  if (result.errors.length > 0) {
    const errorLines = result.errors
      .slice(0, 20)
      .map((e) => `- tenant ${e.tenantId}: ${e.reason}`)
      .join('\n');
    const overflowSuffix
      = result.errors.length > 20 ? `\n... (他 ${result.errors.length - 20} 件)` : '';
    await sendSuperAdminAlert(
      `[たすきば] ${yearMonth} の invoice 月次集計で ${result.errors.length} 件のエラー (= 部分失敗)`,
      `billing-monthly-aggregation cron で per-tenant の集計が失敗しました。\n`
        + `cron 全体は success で完走していますが、以下のテナント分の請求書は未生成です。\n\n`
        + `集計対象: ${tenants.length} テナント\n`
        + `成功: ${result.processedTenants} / skipped: ${result.skippedTenants} / 失敗: ${result.errors.length}\n\n`
        + `エラー詳細:\n${errorLines}${overflowSuffix}\n\n`
        + `対応:\n`
        + `1. /admin/super/cron-history で billing-monthly-aggregation の payload を確認\n`
        + `2. 失敗テナントの ApiCallLog / Storage 状態を点検\n`
        + `3. 個別 fix 後、?yearMonth=${yearMonth} 付きで cron を手動再実行 (= idempotent)`,
    );
  }

  return result;
}
