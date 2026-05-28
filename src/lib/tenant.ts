/**
 * テナント関連の定数とヘルパー (PR #2 / T-03 提案エンジン v2)
 *
 * 本ファイルはマルチテナント基盤の最初の応用層 (lib) であり、
 * すべてのサービス / API ルート / cron handler が tenantId を扱う際の
 * 単一の真実源 (single source of truth) となる。
 *
 * 設計判断:
 *   - 旧仕様 (v1 〜 2026-05-28 以前): schema.prisma の各 tenantId カラムに DB DEFAULT
 *     ('00000000-0000-0000-0000-000000000001'::uuid) を設定していた。
 *     → コードが tenantId を渡し忘れると **silent に Default テナントに混入** する
 *        severity-1 セキュリティバグ (ADR-0024 / fix/tenant-id-default-removal で発覚)。
 *   - 新仕様 (2026-05-28 以降, ADR-0024): DB DEFAULT を全 13 モデルから撤去。
 *     未指定時は Prisma が NOT NULL 違反でエラーを投げる (loud fail 化)。
 *   - 本定数 DEFAULT_TENANT_ID は引き続き存在するが、**用途は pre-auth エラーログ
 *     (SystemErrorLog) や migration seed の明示的な紐付け先のみ** に限定する。
 *     業務エンティティ (RiskIssue, Knowledge, Memo 等) の create 時は必ず
 *     リクエスト context (user.tenantId) を渡すこと。
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
 * v1.x で `tasukiba.netlify.app/{tenantSlug}/...` のルーティングに移行する際の起点。
 */
export const DEFAULT_TENANT_SLUG = 'default';

/**
 * 管理テナントの固定 UUID (PR-X1 / 2026-05-07)。
 *
 * **プラットフォーム運営者専用テナント**。super_admin user のみ所属し、全テナント横断の
 * 監視・管理機能はこのテナントに所属する user からのみ実行可能。
 *
 * **特殊扱い**:
 *   - tenantSeq は null (顧客連番外)
 *   - 集計クエリでは原則として除外する (`tenantId != MANAGEMENT_TENANT_ID`)
 *   - プランは 'pro' (課金対象外、内部運用)
 *
 * 詳細仕様: docs/roadmap/ROLE_REFACTORING_PLAN.md §2.3
 */
export const MANAGEMENT_TENANT_ID = '00000000-0000-0000-0000-ffffffffffff';

/**
 * 管理テナントの slug (URL ルーティング用)。
 */
export const MANAGEMENT_TENANT_SLUG = 'platform-admin';

/**
 * 指定された tenantId が管理テナントかを判定する。
 * 集計・レポーティング系のクエリで「管理テナントを除外する」フィルタとして使う。
 */
export function isManagementTenant(tenantId: string): boolean {
  return tenantId === MANAGEMENT_TENANT_ID;
}

/**
 * 課金プランの判別ユニオン。Tenant.plan カラムの値域。
 *
 * ADR-0019 (2026-05-24) 改定後:
 * - `beginner`: プロジェクト作成/更新 月 50 回まで無料・最大 5 席・Claude Haiku
 *               (資産入力・チャット検索は無料・無制限、課金対象 call のみ上限カウント)
 * - `expert`:   プロジェクト作成/更新 ¥10/call・Claude Haiku (資産入力・チャットは無料)
 * - `pro`:      プロジェクト作成/更新 + なぜ機能 ¥15/call・Claude Sonnet (資産入力・チャットは無料)
 *
 * 履歴:
 * - 2026-05-15 (ADR-0002): Expert ¥10 → ¥5 / Pro ¥30 → ¥15 (半額化)
 * - 2026-05-24 (ADR-0019): Expert ¥5 → ¥10 / Pro ¥15 据置、課金対象を縮小
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
