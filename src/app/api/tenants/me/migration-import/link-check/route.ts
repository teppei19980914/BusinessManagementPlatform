/**
 * POST /api/tenants/me/migration-import/link-check (ADR-0034)
 *
 * CSV選択段階の軽量リンクチェック。プロジェクトの顧客 / WBS のプロジェクトが
 * 「既存テナントデータ + 取り込み CSV」で解決できるかを確認し、未解決を **警告** で返す。
 * プレビュー(csv-preview) と違い DB 書き込み・preview 保存は行わない。
 *
 * 認可: admin role 必須 + 自テナント。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import {
  checkMigrationCsvLinks,
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

/** CSV 合計サイズの上限 (DoS 緩和)。csv-preview と同等。 */
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const body = (await req.json().catch(() => ({}))) as { sources?: unknown };
  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    // 取り込み対象が無いときは警告なしで正常終了 (CSV 選択前の状態)
    return NextResponse.json({ ok: true, warnings: [] }, { status: 200 });
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

  const result = await checkMigrationCsvLinks({ tenantId: user.tenantId, sources });
  return NextResponse.json({ ok: true, warnings: result.warnings }, { status: 200 });
}
