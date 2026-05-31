/**
 * POST /api/csp-report — CSP (Content Security Policy) violation report 受信
 *   security/phase-1 (2026-05-31)
 *
 * 役割:
 *   `next.config.ts` の Content-Security-Policy ヘッダで指定した `report-uri /api/csp-report`
 *   経由で browser から自動 POST される CSP 違反通知を受け、system_error_logs に記録する。
 *   発火元 (script-src 違反 / iframe block / object-src 違反 等) を可視化することで、
 *   CSP 強化 (= 将来の `unsafe-inline` 撤廃 / nonce 化判断) の根拠データを蓄積する。
 *
 * 認可:
 *   未認証アクセス可 (browser が CSP 違反検知時に anonymous で POST するため)。
 *   src/config/routes.ts の PUBLIC_PATHS に列挙済。
 *
 * 防御:
 *   - IP ベース rate limit (`csp-report` バケット) で違反爆発による DoS / DB 圧迫を抑止。
 *     1 ページで複数 violation が並ぶケースもあるため、in-memory rate-limit 既定値 (5 分 10 件)
 *     をそのまま採用。
 *   - body が malformed JSON でも 204 で打ち切る (browser は応答 body を読まないため)。
 *   - 機密含み得る context は `recordError` 経由で system_error_logs (機密保護対象テーブル) のみへ。
 *
 * Body 形式 (CSP Level 2 仕様):
 *   `{ "csp-report": { "document-uri": ..., "violated-directive": ..., "blocked-uri": ..., ... } }`
 *
 * 関連:
 *   - CSP 設定本体: next.config.ts (`Content-Security-Policy` ヘッダ)
 *   - PUBLIC_PATHS: src/config/routes.ts
 *   - エラーログ閲覧: /admin/super/diagnostics (system_error_logs)
 */

import { NextRequest, NextResponse } from 'next/server';
import { applyRateLimit } from '@/lib/rate-limit';
import { recordError } from '@/services/error-log.service';

export async function POST(req: NextRequest) {
  // CSP 違反爆発時の DB 圧迫 / DoS を抑止
  const limited = applyRateLimit(req, { key: 'csp-report' });
  if (limited) return limited;

  let parsed: unknown = null;
  try {
    parsed = await req.json();
  } catch {
    // CSP report が malformed でも 204 で打ち切る (browser は応答を気にしない)
    return new NextResponse(null, { status: 204 });
  }

  // browser が送る形式: `{ "csp-report": {...} }`。fallback で root object 自体も許容。
  const cspReport =
    parsed && typeof parsed === 'object' && 'csp-report' in parsed
      ? (parsed as { 'csp-report': unknown })['csp-report']
      : parsed;

  await recordError({
    severity: 'warn',
    source: 'client',
    message: '[csp-report] CSP violation reported',
    context: { kind: 'csp_violation', cspReport },
  });

  // 204 No Content (browser は応答 body を読まない仕様)
  return new NextResponse(null, { status: 204 });
}
