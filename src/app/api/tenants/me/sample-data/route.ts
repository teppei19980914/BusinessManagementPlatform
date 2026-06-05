/**
 * /api/tenants/me/sample-data (feat/starter-data-import / 2026-06-05)
 *
 * POST   : スターターデータを自テナントへ一括取込 (管理テナントからクローン)
 * DELETE : 自テナントのスターターデータ (isSeedSample=true) を一括削除
 *
 * 認可: admin role 必須 + 自テナントのみ (external-import/apply と同じガード順)。
 * 容量判定 / Beginner block は service 内の precheckImportStorage に委譲。
 *   - Expert/Pro の従量課金警告は UI 側で確認ダイアログ → 承認後に POST される (警告レベルは block しない)。
 *
 * 関連:
 *   - service: src/services/sample-clone.service.ts
 *   - UI: src/app/(dashboard)/settings/tenant/sample-data-section.tsx
 */

import { NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { importSampleData, deleteSampleData } from '@/services/sample-clone.service';
import type { PlanCode } from '@/services/import-storage-precheck.service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const tenant = await prisma.tenant.findUnique({
    where: { id: user.tenantId },
    select: { plan: true },
  });
  const plan = (tenant?.plan ?? 'beginner') as PlanCode;

  const result = await importSampleData({ tenantId: user.tenantId, userId: user.id, plan });
  if (!result.ok) {
    const status =
      result.error === 'STORAGE_BLOCKED' ? 403 : result.error === 'NO_SAMPLE_DATA' ? 404 : 400;
    return NextResponse.json(
      { ok: false, error: { code: result.error, message: result.message } },
      { status },
    );
  }
  return NextResponse.json({ ok: true, summary: result.summary }, { status: 200 });
}

export async function DELETE() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const result = await deleteSampleData({ tenantId: user.tenantId, userId: user.id });
  return NextResponse.json({ ok: true, summary: result.summary }, { status: 200 });
}
