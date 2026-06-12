/**
 * POST /api/tenants/me/migration-import/connect/discover (ADR-0034)
 *
 * 外部サービス (Notion/Backlog/kintone/Pleasanter/Google Sheets) に接続し、取得元 (DB/アプリ/
 * サイト/タブ) の一覧と項目定義を返す。マッピング画面の列候補に使う。
 *
 * 認証情報 (token) は本リクエスト処理の間だけ使用し、**永続保存しない** (ADR-0034 §9 取得後即破棄)。
 * 認可: admin role 必須 + 自テナント。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { CONNECTORS, isApiImportSource } from '@/services/import/connectors/registry';
import { ConnectorHttpError } from '@/services/import/connectors/http';
import type { ConnectorAuth } from '@/services/import/connectors/types';

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

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const body = (await req.json().catch(() => ({}))) as { source?: unknown; auth?: unknown };
  if (!isApiImportSource(body.source)) {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_FORMAT', message: '対応していない連携先です' } },
      { status: 200 },
    );
  }
  const auth = parseAuth(body.auth);
  if (!auth || auth.token === '') {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_FORMAT', message: 'トークン/APIキーを入力してください' } },
      { status: 200 },
    );
  }

  try {
    const schema = await CONNECTORS[body.source].discover(auth);
    return NextResponse.json({ ok: true, schema }, { status: 200 });
  } catch (e) {
    const message =
      e instanceof ConnectorHttpError
        ? `連携先への接続に失敗しました (HTTP ${e.status})。トークン・URL・共有設定をご確認ください。`
        : '連携先への接続に失敗しました。入力内容をご確認ください。';
    return NextResponse.json({ ok: false, error: { code: 'CONNECT_FAILED', message } }, { status: 200 });
  }
}
