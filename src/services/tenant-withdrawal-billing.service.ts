/**
 * テナント退会時の即時請求集計 (ADR-0020 / 2026-05-25)
 *
 * 役割 (R5 横断対応):
 *   旧仕様の月初 cron は `deletedAt IS NULL` フィルタで退会済テナントを除外していた。
 *   そのため月途中で退会したテナントの当月分使用量は **永久に課金されない** 問題があった
 *   (= 退会タイミングを月末直前に集中させる抜け道 + 事業継続性損失)。
 *
 *   本サービスは退会 API から呼ばれ、月末 cron を待たず以下を即時実施:
 *     1. **DB 容量超過分** (ADR-0020): peak → ApiCallLog INSERT + Stripe queue enqueue
 *     2. **API 利用量** (ADR-0019): 既存 deleteTenant 内の snapshot 処理がそのまま捕捉
 *        (= ApiCallLog SUM 真値ベース、PR-V8.2 経路)
 *     3. その他将来追加される featureUnit も自動で 1. に含まれる
 *
 * 設計判断:
 *   - DB 容量請求は本サービスで「退会時即時 ApiCallLog INSERT」
 *   - API 利用量請求は既存 deleteTenant 内の TenantMonthlyUsageHistory upsert で SUM 真値
 *   - 既存パターンを変えずに DB 容量を上乗せ → 影響範囲最小、回帰リスク最小
 *
 * 呼出タイミング:
 *   deleteTenant の冒頭 (= 論理削除前) で呼ぶこと。
 *   論理削除後だと apiCallLog.create が tenant FK 制約で失敗するため。
 *
 * 関連:
 *   - ADR: docs/adr/0020-db-capacity-usage-based-billing.md §4.3
 *   - 月初 cron 同等処理: src/services/tenant-monthly-reset.service.ts:billOneTenantDbCapacityOverage
 *   - 退会 API: src/services/super-admin.service.ts:deleteTenant
 *   - Memory: feedback_billing_invariant.md (ApiCallLog SUM = 表示 = 請求 invariant)
 */

import { prisma } from '@/lib/db';
import { recordError } from '@/services/error-log.service';
import { billOneTenantDbCapacityOverage } from '@/services/tenant-monthly-reset.service';

export type WithdrawalBillingResult = {
  /** DB 容量超過分の請求額 (円、0 なら無料枠内) */
  dbCapacityOverageJpy: number;
  /** 作成された ApiCallLog の ID (= 監査用 / Stripe idempotency_key)、課金 0 なら null */
  apiCallLogId: string | null;
};

/**
 * テナント退会時に、当月分の DB 容量超過請求を ApiCallLog INSERT + Stripe queue 投入する。
 *
 * 既存 deleteTenant の流れ:
 *   1. テナント情報取得 (含む storageBytesPeakThisMonth)
 *   2. **本サービス呼出** ← ここで挿入
 *   3. ApiCallLog SUM で TenantMonthlyUsageHistory upsert (DB 容量分も含まれる)
 *   4. 全業務エンティティを soft delete
 *
 * @returns 課金結果 (= 監査ログ・レスポンスで参照可)
 */
export async function billTenantWithdrawal(args: {
  tenantId: string;
  timezone: string;
  storageBytesUsed: bigint;
  storageBytesPeakThisMonth: bigint;
  now?: Date;
}): Promise<WithdrawalBillingResult> {
  const now = args.now ?? new Date();

  try {
    const result = await billOneTenantDbCapacityOverage({
      tenantId: args.tenantId,
      timezone: args.timezone,
      storageBytesUsed: args.storageBytesUsed,
      storageBytesPeakThisMonth: args.storageBytesPeakThisMonth,
      billingScope: 'current-month-on-withdrawal',
      now,
    });

    return {
      dbCapacityOverageJpy: result.billedJpy,
      apiCallLogId: result.apiCallLogId,
    };
  } catch (error) {
    // 課金失敗は事業継続性 severity-1 案件: 即時 error ログ + super_admin に通知
    await recordError({
      severity: 'error',
      source: 'server',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      context: {
        kind: 'tenant_withdrawal_billing',
        tenantId: args.tenantId,
        peakBytes: args.storageBytesPeakThisMonth.toString(),
        severity: 'requires_manual_action',
      },
    });

    // 退会自体は止めない (= ユーザ操作優先、課金漏れは事後手動補填)
    // ただし呼出側で「課金失敗 + 退会継続」の状態を判別できるよう例外を再 throw する
    throw error;
  }
}

/** 退会済テナントの未請求 DB 容量を手動補填するための super_admin 用関数 (= billTenantWithdrawal 失敗時の救済) */
export async function backfillDeletedTenantDbCapacity(
  tenantId: string,
): Promise<WithdrawalBillingResult | null> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      timezone: true,
      storageBytesUsed: true,
      storageBytesPeakThisMonth: true,
      deletedAt: true,
    },
  });
  if (!tenant) return null;

  // 削除済でも未請求があれば補填可能 (= idempotency キーで二重課金防止される)
  return billTenantWithdrawal({
    tenantId: tenant.id,
    timezone: tenant.timezone,
    storageBytesUsed: tenant.storageBytesUsed,
    storageBytesPeakThisMonth: tenant.storageBytesPeakThisMonth,
    now: tenant.deletedAt ?? new Date(),
  });
}
