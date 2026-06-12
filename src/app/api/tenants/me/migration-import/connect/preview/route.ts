/**
 * POST /api/tenants/me/migration-import/connect/preview (ADR-0034)
 *
 * 外部サービスからマッピングに従い全件取得 → 既存CSV経路 (buildBatchFromCsv) で正規化・検証し、
 * ImportPreview を保存 (TTL 24h) して previewId を返す。取り込み確定 (apply) は既存の
 * /migration-import/apply を流用 (認証情報不要)。
 *
 * 認証情報 (token) は取得処理の間だけ使用し、**永続保存しない**。保存するのは検証済みプレビューのみ。
 * 認可: admin role 必須 + 自テナント。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { CONNECTORS, isApiImportSource } from '@/services/import/connectors/registry';
import { ConnectorHttpError } from '@/services/import/connectors/http';
import { previewMigrationFromSources } from '@/services/import/migration-import.service';
import type { ConnectorAuth, ConnectorMapping } from '@/services/import/connectors/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function parseAuth(raw: unknown): ConnectorAuth | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.token !== 'string') return null;
  const auth: ConnectorAuth = { token: a.token };
  if (typeof a.baseUrl === 'string') auth.baseUrl = a.baseUrl;
  if (a.extra && typeof a.extra === 'object') auth.extra = a.extra as Record<string, string>;
  return auth;
}

function parseMapping(raw: unknown): ConnectorMapping | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as { mappings?: unknown };
  if (!Array.isArray(m.mappings) || m.mappings.length === 0) return null;
  return { mappings: m.mappings as ConnectorMapping['mappings'] };
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const body = (await req.json().catch(() => ({}))) as { source?: unknown; auth?: unknown; mapping?: unknown };
  if (!isApiImportSource(body.source)) {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_FORMAT', message: '対応していない連携先です' } },
      { status: 200 },
    );
  }
  const auth = parseAuth(body.auth);
  const mapping = parseMapping(body.mapping);
  if (!auth || auth.token === '') {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_FORMAT', message: 'トークン/APIキーを入力してください' } },
      { status: 200 },
    );
  }
  if (!mapping) {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_FORMAT', message: '取り込む対象とマッピングを指定してください' } },
      { status: 200 },
    );
  }

  let fetched: { sources: import('@/services/import/csv-to-batch').CsvEntitySource[]; warnings: string[] };
  try {
    fetched = await CONNECTORS[body.source].fetchSources(auth, mapping);
  } catch (e) {
    const message =
      e instanceof ConnectorHttpError
        ? `連携先からの取得に失敗しました (HTTP ${e.status})。トークン・URL・共有設定をご確認ください。`
        : '連携先からの取得に失敗しました。入力内容をご確認ください。';
    return NextResponse.json({ ok: false, error: { code: 'FETCH_FAILED', message } }, { status: 200 });
  }

  const result = await previewMigrationFromSources({
    tenantId: user.tenantId,
    userId: user.id,
    sources: fetched.sources,
    warnings: fetched.warnings,
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: { code: result.error, message: result.message } }, { status: 200 });
  }

  return NextResponse.json(
    { ok: true, previewId: result.previewId, preview: result.preview, expiresAt: result.expiresAt },
    { status: 200 },
  );
}
