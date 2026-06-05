/**
 * POST /api/tenants/me/migration-import/apply (ADR-0034)
 *
 * previewId から検証済データを取り込む (新規作成のみ)。完了後 preview を即削除 (二度押し冪等)。
 *
 * 認可: admin role 必須 + 自テナント + 自分が作成した preview のみ。
 * 入力: { previewId: string }
 * 監査ログ: テナント全体に影響するため必ず記録。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { applyMigration } from '@/services/import/migration-import.service';
import { recordAuditLog } from '@/services/audit.service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const body = (await req.json().catch(() => ({}))) as { previewId?: unknown };
  // 業務エラーは HTTP 200 + { ok:false } で返す (ブラウザのコンソールに 4xx を出さない方針)。
  if (typeof body.previewId !== 'string' || body.previewId.length === 0) {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_FORMAT', message: 'previewId が必要です' } },
      { status: 200 },
    );
  }

  const result = await applyMigration({
    tenantId: user.tenantId,
    userId: user.id,
    previewId: body.previewId,
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: { code: result.error, message: result.message } },
      { status: 200 },
    );
  }

  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'CREATE',
    entityType: 'tenant_migration_import',
    entityId: user.tenantId,
    afterValue: { ...result.result },
  });

  return NextResponse.json({ ok: true, result: result.result }, { status: 200 });
}
