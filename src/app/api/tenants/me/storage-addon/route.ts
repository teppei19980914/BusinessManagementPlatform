/**
 * /api/tenants/me/storage-addon (Phase 2 / 2026-05-08)
 *
 * テナント管理者が自テナントの Storage add-on プランを管理する API。
 *
 * 認可: admin role 必須 + 自テナント
 *
 * GET: 現在のストレージ情報を取得 (使用量・上限・プラン・Grace 状態・予約)
 * PATCH: プラン変更 (アップグレード即時 / ダウングレード翌月予約)
 *   body: { plan: 'standard' | 'plus' | 'pro_storage' | 'enterprise' }
 * DELETE: ダウングレード予約をキャンセル
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isTenantAdmin } from '@/lib/permissions';
import {
  getStorageInfo,
  updateStorageAddonPlan,
  cancelScheduledStorageAddon,
} from '@/services/tenant-storage.service';
import { STORAGE_ADDON_PLANS } from '@/config/storage-addon';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (!isTenantAdmin(user)) {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const info = await getStorageInfo(user.tenantId);
  if (!info) {
    return NextResponse.json(
      { error: { code: 'TENANT_NOT_FOUND', message: 'テナントが見つかりません' } },
      { status: 404 },
    );
  }

  // BigInt は JSON 化できないので Number に変換 (storageBytesUsed は < 2^53 で十分)
  return NextResponse.json({ data: info });
}

const patchBodySchema = z.object({
  plan: z.enum(STORAGE_ADDON_PLANS as unknown as readonly [string, ...string[]]),
});

export async function PATCH(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (!isTenantAdmin(user)) {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = patchBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const result = await updateStorageAddonPlan(
    user.tenantId,
    parsed.data.plan as Parameters<typeof updateStorageAddonPlan>[1],
  );

  if (!result.ok) {
    const status =
      result.error === 'TENANT_NOT_FOUND'
        ? 404
        : result.error === 'DOWNGRADE_BLOCKED_BY_USAGE'
          ? 422
          : 400;
    return NextResponse.json(
      { error: { code: result.error, message: result.message } },
      { status },
    );
  }

  return NextResponse.json({
    data: {
      ok: true,
      appliedImmediately: result.appliedImmediately,
      scheduledFor: result.scheduledFor?.toISOString() ?? null,
    },
  });
}

export async function DELETE() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (!isTenantAdmin(user)) {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  await cancelScheduledStorageAddon(user.tenantId);
  return NextResponse.json({ data: { ok: true } });
}
