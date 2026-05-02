/**
 * Tenant slug → tenantId 解決 helper (PR #2-d / T-03)
 *
 * 役割:
 *   v1.x で導入予定の URL パターン `tasukiba.vercel.app/{tenantSlug}/...` で
 *   slug から tenantId への解決を行う関数の **入り口** を v1 段階で先行整備。
 *   これにより、後続 PR (UI / middleware) が API を変えずに dynamic routing へ
 *   移行できる土台を作る。
 *
 * v1 段階の挙動:
 *   - `resolveTenantBySlug('default')` → DEFAULT_TENANT_ID (DB 検索なし、定数返し)
 *   - その他 slug → null (未対応 slug は 404 として扱う)
 *
 * v1.x での拡張予定:
 *   - DB 検索 (`SELECT id FROM tenants WHERE slug = ? AND deletedAt IS NULL`) に置換
 *   - キャッシュ (Upstash Redis or in-memory + TTL) で大量 traffic に対応
 *   - middleware で URL から slug を抽出し、リクエスト context に tenantId を載せる
 *
 * 設計判断:
 *   - 本ファイルは **v1 では DB を引かない**。default-tenant 単一運用なので毎回 DB
 *     クエリを走らせるコストを回避する。
 *   - `resolveDefaultTenantId()` を独立関数として切り出し、middleware からの呼び出しを
 *     簡潔にする (引数なしで session の tenantId 起点に切り替えやすい)。
 *
 * 関連:
 *   - 設計: docs/design/SUGGESTION_ENGINE.md §マルチテナント基盤
 *   - 計画: docs/roadmap/SUGGESTION_ENGINE_PLAN.md PR #2 章
 *   - 配下: src/lib/tenant.ts (DEFAULT_TENANT_ID / DEFAULT_TENANT_SLUG)
 */

import { DEFAULT_TENANT_ID, DEFAULT_TENANT_SLUG } from '@/lib/tenant';

/**
 * v1 段階の slug → tenantId 解決 (default-tenant のみ対応)。
 *
 * @returns 該当する tenantId、または null (slug 未登録)
 */
export function resolveTenantBySlug(slug: string): string | null {
  if (slug === DEFAULT_TENANT_SLUG) {
    return DEFAULT_TENANT_ID;
  }
  // v1 では default-tenant 以外は未対応。v1.x で DB 検索に置換。
  return null;
}

/**
 * デフォルトテナント (default-tenant) の ID を返す。
 *
 * 用途:
 *   - middleware の暫定実装で、認証済ユーザの tenantId が取れない経路で使う
 *   - 設定画面初期化等の bootstrap で使う
 *
 * v1.x で multi-tenant 化したら本関数は廃止し、明示的な session.user.tenantId
 * 経路に統一する予定。
 */
export function resolveDefaultTenantId(): string {
  return DEFAULT_TENANT_ID;
}
