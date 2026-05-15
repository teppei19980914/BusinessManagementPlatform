/**
 * Stripe 引落失敗による自動 suspend cron サービス (PR-S6 / 2026-05-14)
 *
 * 役割:
 *   `tenant.autoSuspendScheduledAt <= now` のテナントに対し、既存の `suspendTenant()` を
 *   `reason='payment_delinquent'` で呼出し、read-only モードへ強制移行する。
 *   日次 Vercel Cron (`/api/cron/stripe-auto-suspend`) から呼ばれる。
 *
 * 設計方針 (STRIPE_BILLING.md §4.3 / §9.2 / PR #372 の既存 suspendTenant 再利用):
 *   - **autoSuspendScheduledAt セット**: Webhook (= PR-S4) が `customer.subscription.updated`
 *     status='past_due' 受信時に `now + 3 日` をセット (= STRIPE_BILLING.md §4.3)
 *   - **本サービス**: その時刻が到来したら suspendTenant を呼出 (= 既存の手動 suspend と同じ動作)
 *   - **再開**: Webhook (`invoice.paid` / `subscription.updated status=active`) で自動 resume
 *     (= PR-S4 の stripe-webhook-handlers.service で実装済)
 *   - **冪等性**: 既に suspended のテナントは ALREADY_SUSPENDED で skip
 *   - **MANAGEMENT テナント保護**: 既存 suspendTenant が MANAGEMENT_TENANT_FORBIDDEN を投げる
 *     ので、catch して skip カウンタに加算
 *
 * 関連:
 *   - 仕様: docs/business/STRIPE_BILLING.md §4.3 (引き落とし失敗フロー)
 *   - 既存 suspend: src/services/super-admin.service.ts suspendTenant()
 *   - 自動再開: src/services/stripe-webhook-handlers.service.ts (= PR-S4)
 */

import { prisma } from '@/lib/db';
import { getSystemUserId } from '@/lib/stripe';
import { suspendTenant } from './super-admin.service';

export type AutoSuspendResult = {
  /** autoSuspendScheduledAt <= now の対象テナント数 (= 候補件数) */
  candidates: number;
  /** 実際に suspend に成功した件数 */
  suspended: number;
  /**
   * skip した件数 (= 既に suspended / 削除済 / MANAGEMENT テナント等)
   * suspendTenant の throw を catch しているので失敗扱いではない
   */
  skipped: number;
  /** 予期せぬエラーで失敗した件数 (= 運用調査対象) */
  errors: Array<{ tenantId: string; error: string }>;
};

/**
 * `autoSuspendScheduledAt` 到来テナントを一括 suspend。
 *
 * 1 件の失敗が全体の cron 失敗にならないよう、各テナントごとに try/catch する。
 *
 * 処理ステップ:
 *   1. 候補抽出: `autoSuspendScheduledAt <= now` AND `suspendedAt = null` AND `deletedAt = null`
 *   2. 各候補について suspendTenant('payment_delinquent', systemUserId) を呼出
 *   3. 成功時に `autoSuspendScheduledAt = null` をクリア (= 再キューイング防止)
 *   4. 既知エラー (= ALREADY_SUSPENDED / TENANT_DELETED / MANAGEMENT_TENANT_FORBIDDEN) は skip
 *   5. それ以外は errors に追加 (= 全体は止まらない)
 */
export async function autoSuspendDelinquentTenants(): Promise<AutoSuspendResult> {
  const now = new Date();

  const candidates = await prisma.tenant.findMany({
    where: {
      autoSuspendScheduledAt: { not: null, lte: now },
      suspendedAt: null,
      deletedAt: null,
    },
    select: { id: true },
  });

  let suspended = 0;
  let skipped = 0;
  const errors: AutoSuspendResult['errors'] = [];

  const systemUserId = getSystemUserId();

  for (const t of candidates) {
    try {
      await suspendTenant(t.id, 'payment_delinquent', systemUserId);
      // 成功時にスケジュール時刻をクリア (= cron 再実行で同じテナントを処理しないように)
      await prisma.tenant.update({
        where: { id: t.id },
        data: { autoSuspendScheduledAt: null },
      });
      suspended++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (
        message === 'ALREADY_SUSPENDED' ||
        message === 'TENANT_DELETED' ||
        message === 'TENANT_NOT_FOUND' ||
        message === 'MANAGEMENT_TENANT_FORBIDDEN'
      ) {
        skipped++;
      } else {
        errors.push({ tenantId: t.id, error: message });
      }
    }
  }

  return {
    candidates: candidates.length,
    suspended,
    skipped,
    errors,
  };
}
