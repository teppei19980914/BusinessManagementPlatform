/**
 * cron ジョブのメタデータ定義 (PR feat/cron-execution-log / 2026-05-18, PR-V8 2026-05-19 改修)
 *
 * 役割:
 *   各 cron の「人間向け説明」「スケジュール」「エンドポイント」「期待最大ギャップ」を中央集約する。
 *   super_admin ダッシュボードの cron 履歴画面で「この cron が何をしているか」を
 *   開発者以外でも一目で把握できるようにするための情報源。
 *   PR-V8 で `expectedMaxGapHours` を追加 → cron 不実行 watchdog の閾値として使う。
 *
 * 設計判断:
 *   - **cron_execution_log.cron_name の文字列値と一致**: テーブル列の自由文字列ではなく、
 *     本 file で定義した key と一致するもののみ意味のある表示が出る。typo した cron 名は
 *     UI 上で「未登録の cron」扱いになる (= 開発時に気付ける)
 *   - **schedule は JST 表記**: cron-job.org が JST タイムゾーンで運用されている前提
 *     (詳細: docs/operations/DEPLOYMENT.md §6.1)
 *   - **endpoint は path のみ**: フルドメイン URL は環境依存のため含めない。表示時に必要なら
 *     画面側で `https://tasukiba.netlify.app` を結合する
 *   - **expectedMaxGapHours** (PR-V8): 「最後の成功実行から N 時間以上経過していたら異常」の閾値。
 *     daily は 25h (= 1 日 + 1h 余裕)、monthly は 35 日 * 24h = 840h (= 月跨ぎ + 余裕)。
 *     診断ダッシュボードで「未登録 / 長期停止」を検知するために使う。
 *
 * 関連:
 *   - DB model: prisma/schema.prisma model CronExecutionLog
 *   - ヘルパ: src/lib/cron-execution-log.ts withCronExecutionLogging
 *   - 可視化 UI: src/app/(dashboard)/admin/super/cron-history/page.tsx
 *   - watchdog: src/services/cron-health.service.ts (PR-V8 新設)
 *   - スケジュール仕様: docs/operations/DEPLOYMENT.md §6.1
 */

export type CronJobMetadata = {
  /** 人間向けの動作概要 (1-2 行)。super_admin UI に表示される。 */
  description: string;
  /** cron-job.org に登録した実行スケジュール (JST 表記)。 */
  schedule: string;
  /** Netlify 上の path (フルドメインは含めない)。 */
  endpoint: string;
  /**
   * PR-V8 (2026-05-19): 最後の成功実行から何時間経過したら「長期停止」とみなすか。
   *
   * - daily cron: 25 (= 1 日 + 1h 余裕、cron-job.org 起動遅延を吸収)
   * - monthly cron: 840 (= 35 日 * 24h、月跨ぎ + 余裕。月初実行が遅延しても 35 日以内に動けば OK)
   *
   * この値を超えると `cron-health.service.ts` の `detectStaleCron` が異常検知する。
   */
  expectedMaxGapHours: number;
};

/**
 * cron 名 → メタデータの対応表。
 * key は `withCronExecutionLogging(name, ...)` で渡す cron 名と一致する必要がある。
 *
 * 注: `/api/health` は health-check 用途で本テーブルにロギングしない方針のため未掲載。
 *   死活監視は cron-job.org 側の history で確認する。
 */
export const CRON_JOBS: Record<string, CronJobMetadata> = {
  'lock-inactive-users': {
    description:
      '最終ログインから 30 日経過した非管理者ユーザを一括で isActive=false にロックする。'
      + 'ナレッジ参照のためアカウント自体は残し、ログインのみ不可にする。',
    schedule: '日次 21:00 JST',
    endpoint: '/api/admin/users/lock-inactive',
    expectedMaxGapHours: 25,
  },
  'daily-notifications': {
    description:
      'ACT (活動) の予定開始日/予定終了日リマインダ通知を生成。'
      + ' 加えて 30 日経過済の既読通知を物理削除、tenant_import_preview の TTL 削除、'
      + ' 全テナントの storage 容量更新 + Grace period 判定を併走実行する。',
    schedule: '日次 07:00 JST',
    endpoint: '/api/cron/daily-notifications',
    expectedMaxGapHours: 25,
  },
  'daily-usage-aggregation': {
    description:
      '昨日 (UTC) の ApiCallLog をテナント別に集計、過去 7 日平均から spike 検出、'
      + ' 月次予算 80% / 100% / 150% 到達を判定。Beginner プラン期限警告メール送信 +'
      + ' Day 180 自動物理削除も併走。',
    schedule: '日次 11:00 JST',
    endpoint: '/api/cron/daily-usage-aggregation',
    expectedMaxGapHours: 25,
  },
  'tenant-monthly-reset': {
    description:
      '月初にテナントの API 呼出カウンタ + 課金額を 0 にリセット。リセット直前スナップショット保存、'
      + ' ストレージアドオン適用、Beginner プラン期限超過テナントの物理削除、'
      + ' 月初 embedding 補完バッチも実行。',
    schedule: '月初 1 日 09:00 JST',
    endpoint: '/api/cron/tenant-monthly-reset',
    // 月 1 回 → 35 日 (= 約 5 週) 以内に動いていなければ異常。
    // 例: 月末解約・cron 失敗等で 1 ヶ月飛んでも次月で復旧できる猶予。
    expectedMaxGapHours: 35 * 24,
  },
  'stripe-usage-flush': {
    description:
      'stripe_usage_record_queue の未送信行を Stripe Subscription Item の Usage Record として'
      + ' 実送信する。STRIPE_ENABLED=false の環境では no-op 早期 return。',
    schedule: '日次 14:00 JST',
    endpoint: '/api/cron/stripe-usage-flush',
    expectedMaxGapHours: 25,
  },
  'stripe-auto-suspend': {
    description:
      'autoSuspendScheduledAt 到来テナントに対し suspendTenant(\'payment_delinquent\') を呼出し、'
      + ' read-only モードへ強制移行。STRIPE_ENABLED=false の環境では no-op 早期 return。',
    schedule: '日次 13:00 JST',
    endpoint: '/api/cron/stripe-auto-suspend',
    expectedMaxGapHours: 25,
  },
  // PR-V7 #5 (2026-05-19): Stripe ↔ DB 状態照合
  'stripe-reconcile': {
    description:
      'credit_card 払いテナント全件について Stripe Subscription 状態を取得し、'
      + ' DB の tenant.stripeSubscriptionStatus と乖離があれば Stripe 値で上書き + auditLog 記録。'
      + ' Webhook 配信遅延 / DLQ 永続失敗による DB-Stripe 乖離を月次で自動補正する。'
      + ' STRIPE_ENABLED=false の環境では no-op 早期 return。',
    schedule: '月初 1 日 15:00 JST',
    endpoint: '/api/cron/stripe-reconcile',
    expectedMaxGapHours: 35 * 24,
  },
  // PR-V7a (2026-05-19): 期日超過 alert / cron 失敗 alert
  'billing-overdue-alert': {
    description:
      'BillingHistory.payment_due_date + 5日 超過の pending 行を検知し、super_admin にメール送信。'
      + ' 24h 以内の重複送信を抑制 (overdueAlertSentAt で dedup)。',
    schedule: '日次 10:00 JST',
    endpoint: '/api/cron/billing-overdue-alert',
    expectedMaxGapHours: 25,
  },
  'cron-failure-alert': {
    description:
      '直近 24h で status=failure の cron を集約し、super_admin にメール送信。'
      + ' 自身 (cron-failure-alert) の前回成功 > 25h ならサイレント停止警告も付与。',
    schedule: '日次 12:00 JST',
    endpoint: '/api/cron/cron-failure-alert',
    expectedMaxGapHours: 25,
  },
  // PR-V8.4 (2026-05-19): 診断ダッシュボード anomalies の日次 push 通知
  'diagnostics-daily-alert': {
    description:
      '診断ダッシュボードの 9 検知 (API drift / cron 健全性 / 縮退モード / メール失敗 / alert 空打ち / Stripe queue / plan 滞留 / super_admin 数 / 請求書計算ミス) を集約し、'
      + ' 1 件以上あれば super_admin にメール通知。ダッシュボード未閲覧期間の無音対策。',
    schedule: '日次 11:30 JST',
    endpoint: '/api/cron/diagnostics-daily-alert',
    expectedMaxGapHours: 25,
  },
  // ADR-0021 (2026-05-26): 添付ファイル本文 embedding の背景処理 cron
  'attachment-embedding': {
    description:
      'embeddingStatus=pending の Attachment を batch 処理 (最大 20 件/回)。'
      + ' Supabase Storage から download → file-text-extraction (PDF/Excel/CSV/text/docx)'
      + ' → Voyage embedding 生成 → contentEmbedding カラム更新。指数 backoff (1/5min)'
      + ' で 3 回までリトライ、それ以降は failed 確定。per-tenant=5 / global=50 throttle。',
    schedule: '15 分毎 (00:00,15,30,45 JST)',
    endpoint: '/api/cron/attachment-embedding',
    expectedMaxGapHours: 2, // 15min 間隔 + 余裕 (= 2h 経過なら異常)
  },
} as const;

/**
 * cron 名から description を取得する。未登録の cron 名 (= ロギング後に CRON_JOBS から削除された等) は
 * フォールバックで cron 名そのものを返す。
 */
export function getCronDescription(cronName: string): string {
  return CRON_JOBS[cronName]?.description ?? `(未登録の cron: ${cronName})`;
}
