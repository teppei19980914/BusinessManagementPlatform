/**
 * Tenant 解決ヘルパ (ADR-0016 / 2026-05-20)
 *
 * Pre-auth フロー (= ログイン / パスワードリセット / lock-status) で
 * tenant_slug → tenantId を解決するための共通ヘルパ。
 *
 * Option B (= 組織 ID 入力欄方式) 採用:
 *   - request の URL クエリパラメタ `tenant` から tenant_slug を取得
 *   - または form body (= NextAuth credentials) の `tenantSlug` フィールドから取得
 *
 * 将来 Option A (= サブドメイン方式) への移行容易化:
 *   - 本ファイルの resolveTenantSlugFromRequest() の内部実装のみを差し替え
 *     (= subdomain 抽出ロジックに変更)
 *   - 呼出元コードは変更不要
 *
 * 関連:
 *   - 設計判断: docs/adr/0016-multi-tenant-user-membership.md
 *   - URL ビルダ: src/lib/url-builder.ts (= ペアで使用)
 */

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * Request から tenant_slug を抽出する。
 *
 * Option B 実装:
 *   - URL クエリパラメタ `tenant` を最優先 (= メールリンク経由)
 *   - 見つからない場合は null を返す (= 呼出側で form body から取得 等)
 *
 * @param req NextRequest (= App Router の API route の req)
 * @returns tenant_slug 文字列、または null
 */
export function resolveTenantSlugFromRequest(req: NextRequest): string | null {
  // Option B: URL クエリパラメタから取得
  const fromQuery = req.nextUrl.searchParams.get('tenant');
  if (fromQuery && fromQuery.length > 0) {
    return fromQuery;
  }
  return null;

  // ============================================================
  // 将来 Option A (= サブドメイン方式) 移行時の実装イメージ:
  //
  // const hostname = req.headers.get('host') ?? '';
  // const subdomain = extractSubdomain(hostname);
  // if (subdomain && subdomain !== 'www' && subdomain !== 'app') {
  //   return subdomain;
  // }
  // return null;
  // ============================================================
}

/**
 * tenant_slug から tenantId を解決する。
 *
 * - tenant が存在しない or 論理削除済の場合は null を返す
 * - 呼出側で「tenant 不存在」エラーをハンドリングする
 *
 * @param tenantSlug 組織 ID (= Tenant.slug)
 * @returns tenantId (UUID)、または null
 */
export async function resolveTenantIdBySlug(tenantSlug: string): Promise<string | null> {
  if (!tenantSlug) return null;
  const tenant = await prisma.tenant.findFirst({
    where: { slug: tenantSlug, deletedAt: null },
    select: { id: true },
  });
  return tenant?.id ?? null;
}

/**
 * Request から tenant_slug + tenantId をまとめて解決する。
 *
 * 多くの場面で「クエリから slug 取る → DB lookup で id 解決」のセットで使うため、
 * 1 関数にまとめた。
 *
 * @returns { tenantSlug, tenantId } の組、または null (= slug 不在 or 不存在)
 */
export async function resolveTenantFromRequest(
  req: NextRequest,
): Promise<{ tenantSlug: string; tenantId: string } | null> {
  const tenantSlug = resolveTenantSlugFromRequest(req);
  if (!tenantSlug) return null;

  const tenantId = await resolveTenantIdBySlug(tenantSlug);
  if (!tenantId) return null;

  return { tenantSlug, tenantId };
}
