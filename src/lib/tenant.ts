/**
 * テナント関連の定数とヘルパー (PR #2 / T-03 提案エンジン v2)
 *
 * 本ファイルはマルチテナント基盤の最初の応用層 (lib) であり、
 * すべてのサービス / API ルート / cron handler が tenantId を扱う際の
 * 単一の真実源 (single source of truth) となる。
 *
 * 設計判断:
 *   - v1 (2026-06-01) は default-tenant という単一テナントのみで稼働する。
 *   - schema.prisma 側で各エンティティの tenantId カラムに DB DEFAULT
 *     ('00000000-0000-0000-0000-000000000001'::uuid) を設定し、既存コードを
 *     書き換えずに単一テナント運用を継続できるようにしている。
 *   - 本定数 DEFAULT_TENANT_ID は migration 20260502_multi_tenant_base/migration.sql
 *     で挿入される default-tenant の固定 UUID と完全一致 (両者の同期が必須)。
 *   - v1.x のマルチテナント UI 提供時に DB DEFAULT を外し、本定数の参照箇所は
 *     リクエスト context (requestContext.tenantId) に置き換わる移行計画。
 */

/**
 * デフォルトテナントの固定 UUID。
 *
 * **必ず migration 20260502_multi_tenant_base の INSERT 文と同じ値を保持すること**。
 * 値を変える場合は migration ファイル + DB 上の既存データの両方を同時更新する必要がある。
 */
export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';

/**
 * デフォルトテナントの slug (URL ルーティング用)。
 * v1.x で `tasukiba.vercel.app/{tenantSlug}/...` のルーティングに移行する際の起点。
 */
export const DEFAULT_TENANT_SLUG = 'default';

/**
 * 課金プランの判別ユニオン。Tenant.plan カラムの値域。
 *
 * - `beginner`: 月間 100 回上限・最大 5 席・無料・Claude Haiku
 * - `expert`:   無制限従量課金 (¥10/call)・Claude Haiku
 * - `pro`:      無制限従量課金 (¥30/call)・Claude Sonnet
 */
export type TenantPlan = 'beginner' | 'expert' | 'pro';

export const TENANT_PLANS = ['beginner', 'expert', 'pro'] as const;

/**
 * 文字列が有効な TenantPlan かを判定する type guard。
 * DB から取得した plan 値の検証や、設定変更 API のバリデーションで使う。
 */
export function isTenantPlan(value: unknown): value is TenantPlan {
  return typeof value === 'string' && (TENANT_PLANS as readonly string[]).includes(value);
}
