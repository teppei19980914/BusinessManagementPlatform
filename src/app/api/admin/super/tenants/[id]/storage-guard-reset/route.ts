/**
 * POST /api/admin/super/tenants/[id]/storage-guard-reset (ADR-0020 / 2026-05-25)
 *
 * 役割:
 *   storage-guard circuit breaker が open 状態のテナントを通常運用へ復旧させる。
 *
 *   ⚠ 2026-05-31 (ADR-0030「データはたすきばの命」): 累積ハードキャップ撤去に伴い circuit-breaker
 *      (fail-close) は撤去され、計測失敗は fail-open に変更。以降 storageGuardCircuitOpenedAt が
 *      立つことはなく、本 route は **dormant** (= 常に 409 CIRCUIT_NOT_OPEN)。schema 列
 *      (storageGuardCircuit*) を残している間の保守用として存置し、列削除と同 PR で本 route も撤去予定。
 *
 *   super_admin が以下の手順で実行:
 *     1. recordError ログで `kind: 'storage_guard_circuit', circuitOpened: true` 確認
 *     2. 原因 (DB connection / pg_column_size 計算失敗等) を運用ログから調査
 *     3. 解消後に本 endpoint を実行 → storageGuardCircuitFailCount=0 + storageGuardCircuitOpenedAt=NULL
 *
 * Request body: 不要 (空オブジェクト or なし)
 *
 * Response:
 *   200 { data: { tenantId, resetAt, previousFailCount, previousOpenedAt } }
 *
 * 認可:
 *   - super_admin role 必須
 *
 * エラー:
 *   - 401: 未認証
 *   - 403: super_admin 以外
 *   - 404: テナント不在
 *   - 409: circuit open でないテナントへの reset 試行 (誤操作検知)
 *
 * 関連:
 *   - circuit breaker 実装: src/services/storage-guard.service.ts (StorageGuardCircuitOpenError)
 *   - schema: prisma/schema.prisma (storageGuardCircuitFailCount / storageGuardCircuitOpenedAt)
 *   - ADR: docs/adr/0020-db-capacity-usage-based-billing.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { prisma } from '@/lib/db';
import { recordError } from '@/services/error-log.service';
import { MANAGEMENT_TENANT_ID } from '@/lib/tenant';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  if (!isSuperAdmin(user)) {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const { id: tenantId } = await params;

  // 4 回目検証 (G-4) で発見した整合性ギャップ修正: 管理テナントへの操作は明示拒否。
  //   delete tenant ([../route.ts]) と同じ MANAGEMENT_TENANT_FORBIDDEN 経路で誤操作防止。
  if (tenantId === MANAGEMENT_TENANT_ID) {
    return NextResponse.json(
      {
        error: {
          code: 'MANAGEMENT_TENANT_FORBIDDEN',
          message: '管理テナント (運営内部) の storage-guard reset はサポートされていません',
        },
      },
      { status: 403 },
    );
  }

  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      id: true,
      storageGuardCircuitFailCount: true,
      storageGuardCircuitOpenedAt: true,
    },
  });

  if (!tenant) {
    return NextResponse.json(
      { error: { code: 'TENANT_NOT_FOUND', message: 'テナントが見つかりません' } },
      { status: 404 },
    );
  }

  // circuit が open でない場合は誤操作 (409) として返す。failCount > 0 でも openedAt=null なら未 open
  if (tenant.storageGuardCircuitOpenedAt == null) {
    return NextResponse.json(
      {
        error: {
          code: 'CIRCUIT_NOT_OPEN',
          message:
            'このテナントの storage-guard circuit breaker は open 状態ではありません (= reset 不要)',
        },
      },
      { status: 409 },
    );
  }

  const now = new Date();
  const previousFailCount = tenant.storageGuardCircuitFailCount;
  const previousOpenedAt = tenant.storageGuardCircuitOpenedAt;

  // 1. circuit reset + audit_log を同一 transaction で確定
  await prisma.$transaction([
    prisma.tenant.update({
      where: { id: tenantId },
      data: {
        storageGuardCircuitFailCount: 0,
        storageGuardCircuitOpenedAt: null,
      },
    }),
    prisma.auditLog.create({
      data: {
        tenantId,
        userId: user.id,
        action: 'UPDATE',
        entityType: 'tenant',
        entityId: tenantId,
        beforeValue: {
          storageGuardCircuitFailCount: previousFailCount,
          storageGuardCircuitOpenedAt: previousOpenedAt.toISOString(),
        },
        afterValue: {
          operation: 'storage-guard-reset',
          storageGuardCircuitFailCount: 0,
          storageGuardCircuitOpenedAt: null,
          resetAt: now.toISOString(),
          adr: 'ADR-0020 (B-2 fix)',
        },
      },
    }),
  ]);

  // 2. 運用ログにも記録 (super_admin が後で見返す監査用)
  await recordError({
    severity: 'info',
    source: 'server',
    message: `[storage-guard] CIRCUIT RESET by super_admin (tenant=${tenantId}, performer=${user.id})`,
    context: {
      kind: 'storage_guard_circuit_reset',
      tenantId,
      performerId: user.id,
      previousFailCount,
      previousOpenedAt: previousOpenedAt.toISOString(),
    },
  });

  return NextResponse.json({
    data: {
      tenantId,
      resetAt: now.toISOString(),
      previousFailCount,
      previousOpenedAt: previousOpenedAt.toISOString(),
    },
  });
}
