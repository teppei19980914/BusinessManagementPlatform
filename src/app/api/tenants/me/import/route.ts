/**
 * POST /api/tenants/me/import (P-D / 2026-05-08)
 *
 * テナント管理者が P-C で出力した ZIP を自テナントに一括取り込みする。
 *
 * 認可:
 *   - admin role 必須 (general / super_admin はアクセス不可)
 *   - 自テナント (= user.tenantId) のみ対象
 *
 * 入力: multipart/form-data の "file" フィールドに ZIP
 * 出力: { ok: true, summary: ImportSummary } | { ok: false, error, message }
 *
 * 注意:
 *   - Beginner プラン期限切れテナントはインポート不可 (= 書込操作)。
 *     middleware で write methods が弾かれる前提なので、本ファイルでは個別チェックしない。
 *   - 大量データを扱うため Node runtime + force-dynamic が必須 (jszip + bcrypt は Node 専用)。
 *
 * 関連:
 *   - サービス: src/services/data-import.service.ts (importTenantData)
 *   - UI: src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx (インポートセクション)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { importTenantData } from '@/services/data-import.service';
import { recordAuditLog } from '@/services/audit.service';
import { runImportStoragePrecheck } from '@/services/import-storage-precheck.service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** インポート 1 リクエストの最大 ZIP サイズ (= 50MB)。
 *  容量制限は後続タスクで設計するが、明らかな悪意/誤操作 (数百 MB の濫用) は本上限で防ぐ。 */
const MAX_IMPORT_ZIP_BYTES = 50 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  // multipart/form-data から file を取り出す
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_FORMAT', message: 'multipart/form-data として読み込めませんでした' } },
      { status: 400 },
    );
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_FORMAT', message: 'file フィールドが見つかりません' } },
      { status: 400 },
    );
  }

  if (file.size === 0) {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_FORMAT', message: 'ファイルが空です' } },
      { status: 400 },
    );
  }

  if (file.size > MAX_IMPORT_ZIP_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'FILE_TOO_LARGE',
          message: `アップロードサイズが上限 (${MAX_IMPORT_ZIP_BYTES / 1024 / 1024} MB) を超えています`,
        },
      },
      { status: 413 },
    );
  }

  const zipBuffer = Buffer.from(await file.arrayBuffer());

  // 4 巡目フルスキャン (2026-05-28): DB 容量事前判定。ZIP 解凍前なので正確な row count は
  //   分からないが、ZIP→JSON 解凍は典型 3-5 倍。conservative に file.size × 3 を推定値として
  //   Beginner プラン 50MB 無料枠を超える取込を事前ブロックする。
  //   解凍後の正確な値は data-import.service の assertStorageLimitInTx (post-check) で担保。
  const estimatedAddedBytesFromZip = zipBuffer.length * 3;
  const storage = await runImportStoragePrecheck({
    tenantId: user.tenantId,
    entity: 'knowledge', // placeholder (override 使用のため)
    newRowCount: 0,
    estimatedAddedBytesOverride: estimatedAddedBytesFromZip,
  });
  if (storage.isBlocker && storage.errorBody) {
    return NextResponse.json(
      { ok: false, error: storage.errorBody.error },
      { status: 403 },
    );
  }

  const result = await importTenantData(user.tenantId, zipBuffer, user.id);

  if (!result.ok) {
    const status =
      result.error === 'TENANT_NOT_FOUND'
        ? 404
        : result.error === 'IMPORT_IN_PROGRESS'
          ? 409
          : result.error === 'BEGINNER_SEAT_LIMIT'
            ? 422
            : result.error === 'DECOMPRESSED_TOO_LARGE'
              ? 413 // Payload Too Large (= ZIP bomb 二重防御の D-1)
              // ADR-0025 (2026-05-29): Beginner プラン超過は容量制限のため 403 Forbidden で統一
              //   (= 他経路 sync-import 5 / attachments-upload / attachments-finalize と整合)
              : result.error === 'BEGINNER_QUOTA_EXCEEDED'
                ? 403
                // 2026-05-31: 50GB 累積ハードキャップ (STORAGE_LIMIT_EXCEEDED) 分岐は撤去 (ADR-0030)
                : 400;
    return NextResponse.json(
      { ok: false, error: { code: result.error, message: result.message } },
      { status },
    );
  }

  // 監査ログ: テナント全体に影響する取込操作なので必ず記録
  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'CREATE',
    entityType: 'tenant_data_import',
    entityId: user.tenantId,
    afterValue: {
      importedAt: result.summary.importedAt,
      counts: result.summary.counts,
    },
  });

  return NextResponse.json({ ok: true, summary: result.summary }, { status: 200 });
}
