/**
 * POST /api/admin/super/tenants/[id]/regenerate-monthly-history (PR-V8 / 2026-05-19)
 *
 * super_admin が特定テナント × 特定月の月次履歴 (tenant_monthly_usage_history) を
 * ApiCallLog SUM から再生成する。
 *
 * Body: { yearMonth: 'YYYY-MM' }
 *
 * 認可: super_admin role 必須。
 * 監査: regenerateMonthlyHistoryFromApiCallLog が内部で audit_log を 1 transaction で記録。
 *
 * 関連:
 *   - service: src/services/monthly-history-regenerate.service.ts
 *   - UI: src/app/(dashboard)/admin/super/tenants/[id]/diagnostics/page.tsx (= 月次履歴セクション)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { regenerateMonthlyHistoryFromApiCallLog } from '@/services/monthly-history-regenerate.service';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  yearMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  if (!isSuperAdmin(user)) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN' } },
      { status: 403 },
    );
  }

  const { id } = await params;
  const json = await req.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'invalid body',
        },
      },
      { status: 400 },
    );
  }

  const result = await regenerateMonthlyHistoryFromApiCallLog(
    id,
    parsed.data.yearMonth,
    user.id,
  );

  if (result === null) {
    return NextResponse.json(
      { error: { code: 'TENANT_NOT_FOUND' } },
      { status: 404 },
    );
  }

  return NextResponse.json({ data: result });
}
