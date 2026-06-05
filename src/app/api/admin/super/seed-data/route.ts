/**
 * /api/admin/super/seed-data (feat/starter-data-import / 2026-06-05)
 *
 * super_admin 専用。スターターデータ取込元 (管理テナント) の Project/Knowledge の
 * isSampleData フラグをキュレーションする。
 *
 * GET   : 管理テナントの Project/Knowledge を一覧 (isSampleData 付き)
 * PATCH : { entityType: 'project'|'knowledge', entityId, isSampleData } で切替
 *
 * 認可: super_admin 限定 (isSuperAdmin)。service 側で更新対象を MANAGEMENT_TENANT_ID に限定。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { recordAuditLog } from '@/services/audit.service';
import {
  listManagementSeedCandidates,
  setManagementSampleFlag,
} from '@/services/sample-curation.service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (!isSuperAdmin(user)) {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }
  const candidates = await listManagementSeedCandidates();
  return NextResponse.json({ ok: true, candidates }, { status: 200 });
}

export async function PATCH(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (!isSuperAdmin(user)) {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    entityType?: unknown;
    entityId?: unknown;
    isSampleData?: unknown;
  };
  if (
    (body.entityType !== 'project' && body.entityType !== 'knowledge') ||
    typeof body.entityId !== 'string' ||
    typeof body.isSampleData !== 'boolean'
  ) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: '入力が不正です' } },
      { status: 400 },
    );
  }

  const result = await setManagementSampleFlag({
    entityType: body.entityType,
    entityId: body.entityId,
    isSampleData: body.isSampleData,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません (管理テナントの行のみ操作可能です)' } },
      { status: 404 },
    );
  }

  // 監査ログ: 取込元の変更は全テナントの取込内容に影響するため記録する。entityId は対象 UUID。
  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'UPDATE',
    entityType: `seed_curation_${body.entityType}`,
    entityId: body.entityId,
    afterValue: { isSampleData: body.isSampleData },
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
