/**
 * POST /api/tenants/me/external-import/apply (Phase 1 / 2026-05-08)
 *
 * preview で生成された previewId を元に、検証済データを取込実行する。
 * Voyage 呼出 (embedding 全件即時生成) はここで初めて実行される (= 課金発生)。
 *
 * 認可: admin role 必須 + 自テナント + 自分が作成した preview のみ実行可
 * 入力: { previewId: string }
 * 出力: ApplyResult (summary or error)
 *
 * 注意:
 *   - apply 直前にコスト再試算する (preview からの状況変化に対応)
 *   - 取込本体は transaction、embedding 生成は transaction 外 (失敗は warn のみ)
 *   - 監査ログ: tenant 全体に影響するため必ず記録
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { applyImport } from '@/services/external-data-import.service';
import { recordAuditLog } from '@/services/audit.service';
import { prisma } from '@/lib/db';
import {
  AVG_BYTES_PER_IMPORTED_ROW,
  runImportStoragePrecheck,
} from '@/services/import-storage-precheck.service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const body = (await req.json().catch(() => ({}))) as { previewId?: unknown };
  if (typeof body.previewId !== 'string' || body.previewId.length === 0) {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_FORMAT', message: 'previewId が必要です' } },
      { status: 400 },
    );
  }

  // 4 巡目フルスキャン (2026-05-28): apply 前に DB 容量事前判定 (Beginner block / L3 block)。
  //   preview から parsed.knowledge / parsed.risksIssues の件数を取得して見積もる。
  const previewInfo = await prisma.tenantImportPreview.findUnique({
    where: { id: body.previewId },
    select: { tenantId: true, parsedJson: true },
  });
  if (previewInfo && previewInfo.tenantId === user.tenantId) {
    const parsed = previewInfo.parsedJson as unknown as {
      knowledge?: unknown[];
      risksIssues?: unknown[];
    };
    const estimatedAddedBytes =
      (parsed.knowledge?.length ?? 0) * AVG_BYTES_PER_IMPORTED_ROW.knowledge +
      (parsed.risksIssues?.length ?? 0) * AVG_BYTES_PER_IMPORTED_ROW.risksIssues;
    const storage = await runImportStoragePrecheck({
      tenantId: user.tenantId,
      entity: 'knowledge', // placeholder (override 使用のため)
      newRowCount: 0,
      estimatedAddedBytesOverride: estimatedAddedBytes,
    });
    if (storage.isBlocker && storage.errorBody) {
      return NextResponse.json(
        { ok: false, error: storage.errorBody.error },
        { status: 403 },
      );
    }
  }

  const result = await applyImport({
    tenantId: user.tenantId,
    userId: user.id,
    previewId: body.previewId,
  });

  if (!result.ok) {
    const status =
      result.error === 'PREVIEW_NOT_FOUND'
        ? 404
        : result.error === 'PREVIEW_EXPIRED' || result.error === 'PREVIEW_NOT_OWNED'
          ? 410
          : result.error === 'BEGINNER_CALL_LIMIT' || result.error === 'BUDGET_CAP_EXCEEDED'
            ? 422
            : 400;
    return NextResponse.json(
      { ok: false, error: { code: result.error, message: result.message } },
      { status },
    );
  }

  // 監査ログ
  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'CREATE',
    entityType: 'tenant_external_import',
    entityId: user.tenantId,
    afterValue: { ...result.summary },
  });

  return NextResponse.json({ ok: true, summary: result.summary }, { status: 200 });
}
