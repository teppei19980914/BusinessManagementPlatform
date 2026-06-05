/**
 * POST /api/tenants/me/migration-import/csv-preview (ADR-0034)
 *
 * 手動CSV経路のプレビュー。エンティティごとの CSV テキスト + マッピングを受け取り、
 * サーバ側でロバストにパース・正規化して ImportPreview を返す。DB 書き込みなし。
 *
 * 認可: admin role 必須 + 自テナント。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import {
  previewMigrationFromCsv,
  type CsvSourceInput,
} from '@/services/import/migration-import.service';
import type { ImportEntityKind } from '@/services/import/normalized-batch';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VALID_ENTITIES: ImportEntityKind[] = [
  'customer',
  'project',
  'wbs',
  'risk',
  'knowledge',
  'retrospective',
];

/** CSV 合計サイズの上限 (DoS 緩和)。external-import の 50MB と同等。 */
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const body = (await req.json().catch(() => ({}))) as { sources?: unknown };
  // 業務エラーは HTTP 200 + { ok:false } で返す (ブラウザのコンソールに 4xx を出さない方針)。
  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_FORMAT', message: '取り込むCSVがありません' } },
      { status: 200 },
    );
  }

  let totalBytes = 0;
  const sources: CsvSourceInput[] = [];
  for (const raw of body.sources as unknown[]) {
    const s = raw as Partial<CsvSourceInput>;
    if (
      !s
      || typeof s.csvText !== 'string'
      || typeof s.entity !== 'string'
      || !VALID_ENTITIES.includes(s.entity as ImportEntityKind)
      || typeof s.columnMap !== 'object'
      || s.columnMap == null
    ) {
      return NextResponse.json(
        { ok: false, error: { code: 'INVALID_FORMAT', message: 'CSVソースの形式が不正です' } },
        { status: 200 },
      );
    }
    totalBytes += Buffer.byteLength(s.csvText, 'utf8');
    sources.push({
      entity: s.entity as ImportEntityKind,
      csvText: s.csvText,
      columnMap: s.columnMap as Record<string, string>,
      fixedMap: (s.fixedMap as Record<string, string> | undefined) ?? {},
      fileName: typeof s.fileName === 'string' ? s.fileName : undefined,
    });
  }

  if (totalBytes > MAX_TOTAL_BYTES) {
    return NextResponse.json(
      { ok: false, error: { code: 'FILE_TOO_LARGE', message: 'アップロードサイズが上限を超えています' } },
      { status: 200 },
    );
  }

  const result = await previewMigrationFromCsv({
    tenantId: user.tenantId,
    userId: user.id,
    sources,
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: { code: result.error, message: result.message } },
      { status: 200 },
    );
  }

  return NextResponse.json(
    { ok: true, previewId: result.previewId, preview: result.preview, expiresAt: result.expiresAt },
    { status: 200 },
  );
}
