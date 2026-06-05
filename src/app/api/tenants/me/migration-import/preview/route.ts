/**
 * POST /api/tenants/me/migration-import/preview (ADR-0034)
 *
 * 外部移行インポートのプレビュー。クライアントがマッピング済みの NormalizedBatch を送り、
 * サーバが検証・値解決して ImportPreview (件数サマリ・エラー・警告) を返す。DB 書き込みなし。
 *
 * 認可: admin role 必須 + 自テナント。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { previewMigration } from '@/services/import/migration-import.service';
import type { NormalizedBatch } from '@/services/import/normalized-batch';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const body = (await req.json().catch(() => ({}))) as { batch?: unknown };
  const batch = body.batch as NormalizedBatch | undefined;
  if (
    !batch
    || typeof batch !== 'object'
    || !Array.isArray((batch as NormalizedBatch).customers)
    || !Array.isArray((batch as NormalizedBatch).projects)
  ) {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_FORMAT', message: '取り込みデータの形式が不正です' } },
      { status: 400 },
    );
  }

  const result = await previewMigration({
    tenantId: user.tenantId,
    userId: user.id,
    batch,
  });

  if (!result.ok) {
    const status = result.error === 'TOO_MANY_ROWS' ? 413 : 400;
    return NextResponse.json(
      { ok: false, error: { code: result.error, message: result.message } },
      { status },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      previewId: result.previewId,
      preview: result.preview,
      expiresAt: result.expiresAt,
    },
    { status: 200 },
  );
}
