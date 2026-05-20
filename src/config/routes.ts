/**
 * ルートパス定数 (PR #75 Phase 1):
 *
 *   認証・認可の判定ロジックで使うパスリスト、および NextAuth がリダイレクト先として
 *   使う正規ルートをここに集約する。
 *
 *   ページ間遷移の Link / push 先など「カスタム CSS / JSX 内の通常 href」は
 *   URL 文字列のリテラルが可読性に寄与するためそのまま維持する (§21.3 判断基準 2 に基づく)。
 *   本ファイルでは「ミドルウェア / 認可判定で参照する制御用パス」のみ集約する。
 */

/**
 * 未認証でもアクセス可能なパス。ログイン・パスワード再設定・ヘルスチェック等。
 * middleware の authorized コールバックで前方一致判定に使う。
 */
export const PUBLIC_PATHS = [
  '/login',
  '/reset-password',
  '/setup-password',
  // P-G (2026-05-08): 外部ユーザのセルフサインアップ。テナント未所属でアクセスする
  // 唯一の経路。Rate limit + honeypot で bot 投稿を抑止。
  '/signup',
  // 2026-05-19 (docs/2026-05-19-roadmap-archive): 公開ページ群 (利用規約・プライバシーポリシー)。
  //   未認証ユーザがフッタリンクからアクセスする経路。
  //   本文は src/app/(public)/{terms,privacy}/page.tsx で配信 (現在はドラフト)。
  '/terms',
  '/privacy',
  '/api/auth',
  '/api/health', // 外部 cron から定期 ping されるため認証不要
  // PR #89 (feat/account-lock で endpoint rename): Vercel Cron から
  // Authorization: Bearer <CRON_SECRET> で実行される。middleware のセッション検査は
  // 通過させ、route.ts 側で CRON_SECRET 検証 + admin 認証を行う。
  '/api/admin/users/lock-inactive',
  // PR-S4 (2026-05-14): Stripe Webhook (= 外部から Stripe が POST)。
  // Cookie 認証ではなく Stripe signature 検証が唯一の認可なので、middleware は通過させ
  // route.ts 側で `stripe.webhooks.constructEvent()` で署名検証を行う。
  // 詳細: docs/design/STRIPE_TECHNICAL_DESIGN.md §B-2 / docs/business/STRIPE_BILLING.md §7.1
  '/api/webhooks/stripe',
  // PR-S6 (2026-05-14): Stripe Usage Record queue flush cron (5 分間隔)。
  // Vercel Cron から `Authorization: Bearer <CRON_SECRET>` で実行される。
  // route.ts 側で CRON_SECRET 検証 (定数時間比較) を行う。
  '/api/cron/stripe-usage-flush',
  // PR-S6 (2026-05-14): Stripe 引落失敗による自動 suspend cron (日次)。
  // autoSuspendScheduledAt 到来テナントに対し suspendTenant('payment_delinquent') を呼出。
  '/api/cron/stripe-auto-suspend',
  // 2026-05-18 (fix/cron-public-paths-and-stripe-disabled-guard):
  //   Vercel → Netlify 移行 (PR #394) + cron-job.org 外部 cron 化に伴い、これらは外部から
  //   `Authorization: Bearer <CRON_SECRET>` で呼ばれる。middleware の Cookie セッション検査は
  //   通過させ、route.ts 側で `isCronAuthorized()` (定数時間比較) を行う。
  //   Vercel Cron 時代は内部呼出だったため `/api/auth` 系で吸収できていたが、外部 HTTP では
  //   通常の保護パス扱いで /login へ 302 redirect されていた (cron-job.org test run で発覚)。
  //   詳細: docs/knowledge/KDD_PATTERNS.md §5.X+70
  '/api/cron/daily-notifications',
  '/api/cron/daily-usage-aggregation',
  '/api/cron/tenant-monthly-reset',
  // PR-V7 #5 (2026-05-19): Stripe ↔ DB 状態照合 cron (月初)。
  //   Webhook 配信遅延 / DLQ 永続失敗による DB-Stripe 乖離を自動補正する。
  //   route.ts 側で isCronAuthorized() を行う。
  '/api/cron/stripe-reconcile',
  // PR-V7a (2026-05-19): invoice/bank_transfer 月次集計 cron (月初 2 日)。
  //   ApiCallLog + Storage add-on を集計して BillingHistory に upsert する。
  //   credit_card は Stripe Webhook で別途同期されるため対象外。
  '/api/cron/billing-monthly-aggregation',
  // PR-V7a (2026-05-19): 銀行振込 期日超過 alert cron (日次)。
  //   payment_due_date + 5 日超過 + status='pending' を検知し super_admin にメール通知。
  //   24h dedup で同一行の連続通知を抑制。
  '/api/cron/billing-overdue-alert',
  // PR-V7a (2026-05-19): cron 失敗 alert cron (日次)。
  //   直近 24h で status='failure' な cron を cron 名別集約して super_admin にメール通知。
  '/api/cron/cron-failure-alert',
  // PR-V8.4 (2026-05-19): 診断ダッシュボード anomalies 日次 push alert (日次)。
  //   getDiagnosticsSummary を実行し totalAnomalies > 0 なら super_admin にメール通知。
  //   ダッシュボード未閲覧期間の無音対策。
  '/api/cron/diagnostics-daily-alert',
] as const;

/**
 * PR #67: MFA 検証フロー中だけアクセスを許可するパス。
 *   /login/mfa ページ本体と TOTP 検証 API を含む。
 *   セッションは必要だが mfaVerified=false でもアクセス可能。
 *
 * fix/session-clearance follow-up (2026-05-20): MFA 検証中のキャンセル経路は
 *   `mfa-form.tsx` で `/api/auth/explicit-signout` を fetch するパターンに統一済 (KDD §5.X+84)。
 *   旧 `/api/auth/signout` (NextAuth 既定) は本サービスのコードから一切呼ばれなくなったため
 *   MFA_PENDING_PATHS からも除去。
 */
export const MFA_PENDING_PATHS = [
  '/login/mfa',
  '/api/auth/mfa/verify',
  '/api/auth/explicit-signout', // MFA 検証中にログアウト (=キャンセル) できるように
] as const;

/** 認証失敗時 / 未認証時のリダイレクト先。 */
export const LOGIN_PATH = '/login';

/** MFA 検証フロー誘導先。 */
export const MFA_LOGIN_PATH = '/login/mfa';
