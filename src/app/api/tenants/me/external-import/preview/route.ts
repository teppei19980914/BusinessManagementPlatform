/**
 * POST /api/tenants/me/external-import/preview (Phase 1 / 2026-05-08)
 *
 * 外部データ移行 (Knowledge / RiskIssue) の preview API。
 * ファイルをパース + バリデーション + コスト試算を行い、結果を 24 時間 TTL で保存する。
 *
 * Voyage AI への呼出は行わない (= 課金なし、件数 × 単価で見積のみ)。
 *
 * 認可: admin role 必須 + 自テナント
 * 入力: multipart/form-data
 *   - file: CSV (UTF-8 BOM 自動除去)
 *   - mappings: JSON 文字列 ([{ entity, fieldMapping, defaultProjectId? }])
 * 出力: PreviewResult (previewId, summary, errors, costEstimate, expiresAt)
 *
 * 受付フォーマットは CSV のみ。Excel (.xlsx) は xlsx ライブラリの未パッチ脆弱性により Phase 1 では非対応。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { previewImport, type EntityMapping } from '@/services/external-data-import.service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_FILE_BYTES = 50 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_FORMAT', message: 'multipart/form-data として読み込めません' } },
      { status: 400 },
    );
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_FORMAT', message: 'file フィールドが必要です' } },
      { status: 400 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_FORMAT', message: 'ファイルが空です' } },
      { status: 400 },
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'FILE_TOO_LARGE',
          message: `アップロードサイズが上限 (${MAX_FILE_BYTES / 1024 / 1024} MB) を超えています`,
        },
      },
      { status: 413 },
    );
  }

  const mappingsRaw = formData.get('mappings');
  if (typeof mappingsRaw !== 'string') {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_FORMAT', message: 'mappings フィールドが必要です' } },
      { status: 400 },
    );
  }

  let mappings: EntityMapping[];
  try {
    mappings = JSON.parse(mappingsRaw) as EntityMapping[];
    if (!Array.isArray(mappings) || mappings.length === 0) {
      throw new Error('mappings empty');
    }
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_FORMAT', message: 'mappings の JSON が不正です' } },
      { status: 400 },
    );
  }

  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const result = await previewImport({
    tenantId: user.tenantId,
    userId: user.id,
    fileBuffer,
    mappings,
  });

  if (!result.ok) {
    const status =
      result.error === 'TENANT_NOT_FOUND'
        ? 404
        : result.error === 'FILE_TOO_LARGE'
          ? 413
          : result.error === 'TOO_MANY_ROWS'
            ? 413
            : 400;
    return NextResponse.json(
      { ok: false, error: { code: result.error, message: result.message } },
      { status },
    );
  }

  // result.ok=true は既に確定しているので分割代入で使う
  const { ok: _ok, ...rest } = result;
  void _ok;
  return NextResponse.json({ ok: true, ...rest }, { status: 200 });
}
