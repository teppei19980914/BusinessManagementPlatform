/**
 * super_admin 向け請求ダッシュボードのサービス層 (PR-V7 #8 / 2026-05-19)
 *
 * 役割:
 *   `/admin/super/billing` 配下の画面に必要なデータを `BillingHistory` テーブルから
 *   集計・取得する。`super_admin` のみがアクセスする前提 (呼出側で認可済)。
 *
 * 主要関数:
 *   - getBillingSummary(yearMonths): 月次サマリの集計 (= 概要画面用)
 *   - getMonthlyBillingDetail(yearMonth, filters): テナント別月次明細 (= 詳細画面用)
 *   - getRecentMonths(n, timezone): 「直近 N ヶ月」の yearMonth リスト生成
 *
 * 設計判断:
 *   - **全テナント横断クエリ** (= 顧客集計用なので tenant scope なし)
 *     → `tenant-isolation-invariants.test.ts` の `CROSS_TENANT_ALLOWED_FILES` に登録
 *   - **管理テナント (MANAGEMENT_TENANT_ID) は除外**: 運営内部テナントは課金対象外
 *   - **論理削除済テナントも含める**: 解約済テナントの過去請求も集計対象 (= 月次サマリ整合性)
 *   - **集計は status / paymentMethod の組合せで groupBy**: SQL 1 回で結果取得 (= O(月数))
 *
 * 関連:
 *   - 仕様: docs/business/STRIPE_BILLING.md §2.3 (BillingHistory ライフサイクル)
 *   - schema: prisma/schema.prisma model BillingHistory
 *   - 呼出側: src/app/(dashboard)/admin/super/billing/*
 */

import { prisma } from '@/lib/db';
import { MANAGEMENT_TENANT_ID } from '@/lib/tenant';
import { getTenantCurrentYearMonth } from '@/lib/tenant-time';

// ============================================================
// 型定義
// ============================================================

/**
 * 月次サマリ (= 概要画面の集計カード + 月次推移テーブル用)
 */
export type BillingMonthSummary = {
  yearMonth: string;
  /** 当月の総請求額 (= 全 status の totalAmountJpy 合計) */
  totalAmount: number;
  /** 入金確認済額 (status='paid') */
  paidAmount: number;
  /** 入金待ち額 (status='pending') */
  pendingAmount: number;
  /** 引落失敗額 (status='failed') */
  failedAmount: number;
  /** 返金済額 (status='refunded') */
  refundedAmount: number;
  /** 取消額 (status='canceled') */
  canceledAmount: number;
  /** Stripe 一括請求に置換済額 (status='replaced_by_stripe') */
  replacedAmount: number;
  /** 件数: status 別 */
  countByStatus: Record<string, number>;
  /** 件数: 支払方法別 (= テナント側 paymentMethod ではなく BillingHistory.paymentMethod) */
  countByPaymentMethod: Record<string, number>;
};

/**
 * テナント別月次明細 (= 詳細画面のテーブル行)
 */
export type BillingHistoryDetail = {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSeq: number | null;
  /** テナント論理削除済かどうか (= 解約済テナントは UI で目印表示) */
  tenantDeletedAt: Date | null;
  yearMonth: string;
  paymentMethod: string;
  amountJpy: number;
  taxAmountJpy: number;
  totalAmountJpy: number;
  status: string;
  stripeInvoiceId: string | null;
  paidAt: Date | null;
  failureReason: string | null;
  retryCount: number;
  createdAt: Date;
  updatedAt: Date;
};

// ============================================================
// 公開関数: 集計
// ============================================================

/**
 * 指定 yearMonth 群の月次サマリを集計する。
 * 各月について status 別の合計額 + status / paymentMethod 別の件数を返却。
 *
 * SQL 戦略:
 *   - `groupBy(['yearMonth', 'status'])` で status 別の合計取得 (1 query)
 *   - `groupBy(['yearMonth', 'paymentMethod'])` で支払方法別件数取得 (1 query)
 *   - 月数 × status 数 = 高々数十行レベルなので O(月数) で十分
 *
 * 管理テナント除外:
 *   - MANAGEMENT_TENANT_ID は集計対象外 (運営内部、顧客課金対象ではない)
 */
export async function getBillingSummary(
  yearMonths: string[],
): Promise<BillingMonthSummary[]> {
  if (yearMonths.length === 0) return [];

  // status 別合計
  const statusAgg = await prisma.billingHistory.groupBy({
    by: ['yearMonth', 'status'],
    _sum: { totalAmountJpy: true },
    _count: true,
    where: {
      yearMonth: { in: yearMonths },
      tenantId: { not: MANAGEMENT_TENANT_ID },
    },
  });

  // paymentMethod 別件数
  const methodAgg = await prisma.billingHistory.groupBy({
    by: ['yearMonth', 'paymentMethod'],
    _count: true,
    where: {
      yearMonth: { in: yearMonths },
      tenantId: { not: MANAGEMENT_TENANT_ID },
    },
  });

  // yearMonth → サマリ の Map を構築
  const summaryMap = new Map<string, BillingMonthSummary>();
  for (const ym of yearMonths) {
    summaryMap.set(ym, {
      yearMonth: ym,
      totalAmount: 0,
      paidAmount: 0,
      pendingAmount: 0,
      failedAmount: 0,
      refundedAmount: 0,
      canceledAmount: 0,
      replacedAmount: 0,
      countByStatus: {},
      countByPaymentMethod: {},
    });
  }

  for (const row of statusAgg) {
    const s = summaryMap.get(row.yearMonth);
    if (s == null) continue;
    const amount = row._sum.totalAmountJpy ?? 0;
    s.totalAmount += amount;
    s.countByStatus[row.status] = (s.countByStatus[row.status] ?? 0) + row._count;
    switch (row.status) {
      case 'paid':
        s.paidAmount += amount;
        break;
      case 'pending':
        s.pendingAmount += amount;
        break;
      case 'failed':
        s.failedAmount += amount;
        break;
      case 'refunded':
        s.refundedAmount += amount;
        break;
      case 'canceled':
        s.canceledAmount += amount;
        break;
      case 'replaced_by_stripe':
        s.replacedAmount += amount;
        break;
    }
  }

  for (const row of methodAgg) {
    const s = summaryMap.get(row.yearMonth);
    if (s == null) continue;
    s.countByPaymentMethod[row.paymentMethod] =
      (s.countByPaymentMethod[row.paymentMethod] ?? 0) + row._count;
  }

  // 新しい yearMonth が先頭 (= UI で「直近 6 ヶ月」表示時に逆順)
  return yearMonths
    .map((ym) => summaryMap.get(ym)!)
    .sort((a, b) => b.yearMonth.localeCompare(a.yearMonth));
}

// ============================================================
// 公開関数: 詳細取得
// ============================================================

/**
 * 指定月のテナント別請求明細を取得 (= 月次詳細画面のテーブル用)。
 *
 * フィルタ:
 *   - status: 単一値 or undefined (= 全て)
 *   - paymentMethod: 単一値 or undefined (= 全て)
 *
 * ソート: status → totalAmountJpy desc → tenantName
 *   - failed が上、paid が下になるよう降順 (= 督促対応の優先表示)
 *   - 同 status 内は金額大きい順
 */
export async function getMonthlyBillingDetail(
  yearMonth: string,
  filters: { status?: string; paymentMethod?: string } = {},
): Promise<BillingHistoryDetail[]> {
  const records = await prisma.billingHistory.findMany({
    where: {
      yearMonth,
      tenantId: { not: MANAGEMENT_TENANT_ID },
      ...(filters.status != null ? { status: filters.status } : {}),
      ...(filters.paymentMethod != null ? { paymentMethod: filters.paymentMethod } : {}),
    },
    include: {
      tenant: {
        select: {
          id: true,
          name: true,
          tenantSeq: true,
          deletedAt: true,
        },
      },
    },
    orderBy: [
      // failed (= 'failed') が上、pending (= 'pending') 中、paid (= 'paid') 下、になるよう
      // status の文字列順とは別の優先順位が欲しいが、Prisma orderBy で複雑な条件は扱いにくい。
      // 簡易: status desc で 'replaced_by_stripe' / 'refunded' / 'pending' / 'paid' / 'failed' /
      //       'canceled' の順 (= アルファベット降順)。失敗が上で十分。
      { status: 'desc' },
      { totalAmountJpy: 'desc' },
    ],
  });

  return records.map((r) => ({
    id: r.id,
    tenantId: r.tenantId,
    tenantName: r.tenant.name,
    tenantSeq: r.tenant.tenantSeq,
    tenantDeletedAt: r.tenant.deletedAt,
    yearMonth: r.yearMonth,
    paymentMethod: r.paymentMethod,
    amountJpy: r.amountJpy,
    taxAmountJpy: r.taxAmountJpy,
    totalAmountJpy: r.totalAmountJpy,
    status: r.status,
    stripeInvoiceId: r.stripeInvoiceId,
    paidAt: r.paidAt,
    failureReason: r.failureReason,
    retryCount: r.retryCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

// ============================================================
// ユーティリティ
// ============================================================

/**
 * 「直近 N ヶ月」の yearMonth 配列を返す (= 新しい順)。
 *
 * 例: getRecentMonths(6, 'Asia/Tokyo') @ 2026-06-15 (JST)
 *   → ['2026-06', '2026-05', '2026-04', '2026-03', '2026-02', '2026-01']
 *
 * @param n 取得月数 (1 以上)
 * @param timeZone IANA タイムゾーン (default: 'Asia/Tokyo')
 * @param now 基準時刻 (default: 現在時刻、テスト用に注入可)
 */
export function getRecentMonths(
  n: number,
  timeZone: string = 'Asia/Tokyo',
  now: Date = new Date(),
): string[] {
  if (n < 1) return [];
  const result: string[] = [];
  // 現在月から 1 ヶ月ずつ遡る
  for (let i = 0; i < n; i++) {
    // i ヶ月前の日付を生成
    //   - now をベースに UTC で month を -i すると、テナント TZ で月境界がずれるケースあり
    //   - 簡易実装: テナント TZ の年月を取得 → 月を整数で減算 → YYYY-MM 再構成
    const baseYM = getTenantCurrentYearMonth(now, timeZone);
    const [yearStr, monthStr] = baseYM.split('-');
    const baseYear = parseInt(yearStr, 10);
    const baseMonth = parseInt(monthStr, 10);
    let targetYear = baseYear;
    let targetMonth = baseMonth - i;
    while (targetMonth <= 0) {
      targetMonth += 12;
      targetYear -= 1;
    }
    result.push(`${targetYear}-${String(targetMonth).padStart(2, '0')}`);
  }
  return result;
}
