/**
 * POST /api/admin/super/recalculate-all (2026-05-14)
 *
 * super_admin ダッシュボード遷移時 / 手動「全カード再集計」ボタンで呼ばれる。
 *
 * 動作:
 *   1. 全テナント (削除済除外) の `Tenant.storageBytesUsed` を `pg_column_size`
 *      集計で更新 (= 旧 cron が日次でやっていた処理を即時実行)
 *   2. 全テナントの ApiCallLog SUM と Tenant counter の整合性チェック (drift 検出)
 *   3. 結果をまとめて返す
 *
 * 認可: super_admin role 必須 (全テナント横断アクセス)。テナント越境問題は
 *   存在しない (= 元々 cross-tenant な操作のため、role gate だけで十分)。
 *
 * 関連:
 *   - 計画: docs/plans/2026-05-14_dashboard_realtime_recalc.md
 *   - UI: src/app/(dashboard)/admin/super/page.tsx (集計中表示 + 再集計ボタン)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { updateAllStorageBytesUsed } from '@/services/tenant-storage.service';
import { reconcileAllTenantsApiUsage } from '@/services/api-usage-recalc.service';
import { recordAuditLog } from '@/services/audit.service';
// PR-V8 (2026-05-19): audit_logs.entity_id は @db.Uuid のため、'all-tenants' のような
//   文字列リテラルは 22P02 invalid input syntax for type uuid で silent fail する。
//   全テナント横断操作は actor (super_admin) の所属する MANAGEMENT_TENANT_ID を entityId に
//   入れ、afterValue 内で operation='recalculate-all' として識別する。
import { MANAGEMENT_TENANT_ID } from '@/lib/tenant';

/**
 * 全テナント集計は Function timeout に収まらない可能性があるため最大値を確保。
 * 現行の Netlify Personal Sync Function 上限は 10 秒固定 (Pro 以上で 26 秒まで configurable)。
 * 個別失敗は Promise.allSettled で吸収するため、タイムアウト時の影響範囲を限定。
 * 長期的には Pro 昇格 + Background Functions (15 分) への分離を検討。
 */
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  if (!isSuperAdmin(user)) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN' } },
      { status: 403 },
    );
  }

  // ストレージ再集計 + API 利用量整合性チェックを並列実行。
  // updateAllStorageBytesUsed は内部で個別失敗を吸収するので throw しない。
  // reconcileAllTenantsApiUsage は Promise.allSettled で並列 + 個別失敗を除外。
  const [storageUpdated, apiReconciles] = await Promise.all([
    updateAllStorageBytesUsed(),
    reconcileAllTenantsApiUsage(),
  ]);

  // 監査ログ: system 全体への操作として記録 (tenantId は actor の management tenant)
  // PR-V8 (2026-05-19): entityId='all-tenants' は uuid 違反で silent fail していたため、
  //   MANAGEMENT_TENANT_ID で記録する。afterValue.operation で識別可能。
  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'UPDATE',
    entityType: 'system',
    entityId: MANAGEMENT_TENANT_ID,
    afterValue: {
      operation: 'recalculate-all',
      storageTenantsUpdated: storageUpdated,
      apiReconcileCount: apiReconciles.length,
      tenantsWithDrift: apiReconciles.filter((r) => r.hasDrift).length,
    },
  });

  return NextResponse.json({
    data: {
      storage: { tenantsUpdated: storageUpdated },
      apiUsage: {
        tenantsChecked: apiReconciles.length,
        tenantsWithDrift: apiReconciles.filter((r) => r.hasDrift).length,
      },
    },
  });
}
