/**
 * /admin/super (super_admin ダッシュボードのトップ) (PR-X2 / 2026-05-07)
 *
 * 全テナント横断のサマリを表示。詳細はサブナビゲーションから。
 *
 * P-5a (2026-05-08): DB 容量モニタカードを追加。Supabase プラン上限到達による
 *   データ登録不能事故を未然に防ぐためのリアルタイム可視化。
 * P-6 (2026-05-08): 休眠テナント警告セクションを追加。90 日連続休眠テナントの
 *   早期発見・解約営業判断材料に。
 * P-H (2026-05-08): メール送信モニタカードを追加。Brevo 等の無料プラン送信上限
 *   (300 通/日) 超過事故を未然に検知する。
 */

import Link from 'next/link';
import {
  getCrossTenantUsageSummary,
  listDormantTenants,
  DORMANT_TENANT_THRESHOLD_DAYS,
  listStorageUsageTop,
  type StorageUsageTopRow,
} from '@/services/super-admin.service';
import { getDatabaseCapacityReport } from '@/services/db-capacity.service';
import { getEmailSendStats } from '@/services/email-send-log.service';
import type { DbCapacityStatus } from '@/config/db-capacity';
import type { EmailLimitStatus } from '@/config/email-limit';

export default async function SuperAdminTopPage() {
  const [summary, capacity, dormant, emailStats, storageTop] = await Promise.all([
    getCrossTenantUsageSummary(),
    getDatabaseCapacityReport(),
    listDormantTenants(),
    getEmailSendStats(),
    listStorageUsageTop(10),
  ]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">システム管理者ダッシュボード</h1>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="顧客テナント数" value={summary.tenantCount.toString()} />
        <SummaryCard label="アクティブユーザ総数" value={summary.totalActiveUsers.toString()} />
        <SummaryCard
          label="今月の API 呼出 (合計)"
          value={summary.totalCurrentMonthApiCalls.toLocaleString()}
        />
        <SummaryCard
          label="今月の API 費用 (合計)"
          value={`¥${summary.totalCurrentMonthApiCostJpy.toLocaleString()}`}
        />
      </section>

      {/* P-5a: DB 容量モニタ */}
      <DatabaseCapacityCard capacity={capacity} />

      {/* P-H (2026-05-08): メール送信モニタ */}
      <EmailSendMonitorCard stats={emailStats} />

      {/* P-6 (2026-05-08): 休眠テナント警告 */}
      <DormantTenantsCard dormant={dormant} />

      {/* Storage add-on (Phase 2 / 2026-05-08): テナント別容量 TOP 10 */}
      <StorageUsageTopCard rows={storageTop} />

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">プラン別テナント数</h2>
        <ul className="rounded border p-3 text-sm">
          {summary.planDistribution.length === 0 ? (
            <li className="text-muted-foreground">テナントがありません</li>
          ) : (
            summary.planDistribution.map((p) => (
              <li key={p.plan} className="flex justify-between border-b py-1 last:border-b-0">
                <span className="font-medium capitalize">{p.plan}</span>
                <span>{p.count} 件</span>
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}

/**
 * P-5a (2026-05-08): DB 容量カード。
 *
 * - 現在の使用量 / 上限 / 使用率を表示
 * - status (ok / warn / alert) で背景色を変化
 * - 上位テーブル内訳 (総容量降順) を併記
 * - alert 時は「データ登録に失敗する可能性あり」の注意喚起
 */
function DatabaseCapacityCard({
  capacity,
}: {
  capacity: Awaited<ReturnType<typeof getDatabaseCapacityReport>>;
}) {
  const styles = STATUS_STYLES[capacity.status];
  const percent = (capacity.utilizationRatio * 100).toFixed(1);

  return (
    <section className={`space-y-3 rounded border p-4 ${styles.bg}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">DB 容量モニタ</h2>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${styles.badge}`}>
          {STATUS_LABEL[capacity.status]}
        </span>
      </div>

      <div className="space-y-1">
        <p className="text-sm">
          使用量: <strong>{formatBytes(capacity.usedBytes)}</strong> / 上限{' '}
          <strong>{formatBytes(capacity.limitBytes)}</strong>
          {' '}
          (<span className={styles.text}>{percent}%</span>)
        </p>
        {/* シンプルなプログレスバー */}
        <div className="h-2 w-full overflow-hidden rounded bg-muted">
          <div
            className={`h-full ${styles.bar}`}
            style={{ width: `${Math.min(100, capacity.utilizationRatio * 100)}%` }}
          />
        </div>
      </div>

      {capacity.status === 'alert' && (
        <p className="text-sm font-medium text-destructive">
          ⚠️ 容量上限に近づいています。プランのアップグレードまたは不要データの削除を検討してください。
          このまま放置するとデータ登録に失敗する可能性があります。
        </p>
      )}
      {capacity.status === 'warn' && (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          ⚠️ 使用率が 80% を超えました。容量推移を継続監視してください。
        </p>
      )}

      {capacity.topTables.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            容量上位テーブル ({capacity.topTables.length} 件)
          </summary>
          <ul className="mt-2 space-y-1 rounded border bg-background/50 p-2">
            {capacity.topTables.map((t) => (
              <li key={t.tableName} className="flex justify-between">
                <span className="font-mono text-xs">{t.tableName}</span>
                <span className="text-xs text-muted-foreground">{formatBytes(t.totalBytes)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="text-xs text-muted-foreground">
        計測時刻: {capacity.measuredAt.toLocaleString('ja-JP')}
        {' ・ '}
        上限変更は環境変数 <code className="rounded bg-muted px-1">DB_CAPACITY_LIMIT_BYTES</code> で可能
      </p>
    </section>
  );
}

/**
 * P-6 (2026-05-08): 休眠テナント警告カード。
 *
 * - 90 日 (= DORMANT_TENANT_THRESHOLD_DAYS) 以上ログインがないテナントを一覧表示
 * - 解約営業 / 顧客サポート / 利用状況確認のトリガーとして使用
 * - 0 件 (= 全テナント健全) なら緑色で「健全」表示
 */
function DormantTenantsCard({
  dormant,
}: {
  dormant: Awaited<ReturnType<typeof listDormantTenants>>;
}) {
  if (dormant.length === 0) {
    return (
      <section className="space-y-2 rounded border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900/40 dark:bg-emerald-950/30">
        <h2 className="text-lg font-semibold">休眠テナント警告</h2>
        <p className="text-sm text-emerald-800 dark:text-emerald-300">
          ✅ 全テナントが {DORMANT_TENANT_THRESHOLD_DAYS} 日以内に活動しています。健全な状態です。
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-2 rounded border border-destructive/30 bg-destructive/5 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">休眠テナント警告</h2>
        <span className="rounded-full bg-destructive px-2 py-0.5 text-xs font-semibold text-destructive-foreground">
          {dormant.length} 件
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {DORMANT_TENANT_THRESHOLD_DAYS} 日以上ログインがないテナントです。解約営業・顧客サポートの判断材料に。
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="text-left">
            <tr className="border-b">
              <th className="p-2">テナント</th>
              <th className="p-2">プラン</th>
              <th className="p-2">最終ログイン</th>
              <th className="p-2 text-right">休眠日数</th>
            </tr>
          </thead>
          <tbody>
            {dormant.map((t) => (
              <tr key={t.id} className="border-b hover:bg-accent/40">
                <td className="p-2">
                  <Link
                    href={`/admin/super/tenants/${t.id}`}
                    className="text-info hover:underline"
                  >
                    {t.tenantSeq != null && (
                      <span className="mr-1 text-xs text-muted-foreground">#{t.tenantSeq}</span>
                    )}
                    {t.name}
                  </Link>
                </td>
                <td className="p-2 capitalize">{t.plan}</td>
                <td className="p-2 text-xs">
                  {t.lastUserLoginAt
                    ? t.lastUserLoginAt.toISOString().split('T')[0]
                    : `未ログイン (作成: ${t.createdAt.toISOString().split('T')[0]})`}
                </td>
                <td className="p-2 text-right font-mono">{t.daysSinceLastActivity} 日</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const STATUS_STYLES: Record<DbCapacityStatus, { bg: string; bar: string; badge: string; text: string }> = {
  ok: {
    bg: 'bg-background',
    bar: 'bg-emerald-500',
    badge: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200',
    text: 'text-emerald-700 dark:text-emerald-400',
  },
  warn: {
    bg: 'bg-amber-50 dark:bg-amber-950/30',
    bar: 'bg-amber-500',
    badge: 'bg-amber-200 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
    text: 'text-amber-700 dark:text-amber-400',
  },
  alert: {
    bg: 'bg-destructive/10',
    bar: 'bg-destructive',
    badge: 'bg-destructive text-destructive-foreground',
    text: 'text-destructive',
  },
};

const STATUS_LABEL: Record<DbCapacityStatus, string> = {
  ok: '正常',
  warn: '要注意',
  alert: '緊急',
};

/** バイト数を人間可読な単位 (KB/MB/GB) に整形。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ================================================================
// P-H (2026-05-08): メール送信モニタカード
// ================================================================

const EMAIL_STATUS_STYLES: Record<EmailLimitStatus, { bg: string; bar: string; badge: string; text: string }> = {
  ok: {
    bg: 'bg-background',
    bar: 'bg-emerald-500',
    badge: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200',
    text: 'text-emerald-700 dark:text-emerald-400',
  },
  warn: {
    bg: 'bg-amber-50 dark:bg-amber-950/30',
    bar: 'bg-amber-500',
    badge: 'bg-amber-200 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
    text: 'text-amber-700 dark:text-amber-400',
  },
  alert: {
    bg: 'bg-destructive/10',
    bar: 'bg-destructive',
    badge: 'bg-destructive text-destructive-foreground',
    text: 'text-destructive',
  },
};

function EmailSendMonitorCard({
  stats,
}: {
  stats: Awaited<ReturnType<typeof getEmailSendStats>>;
}) {
  // 日次のステータスをカード全体に適用 (= 当日の上限到達が最も緊急)
  const styles = EMAIL_STATUS_STYLES[stats.dailyStatus];
  const dailyPercent = (stats.dailyUtilizationRatio * 100).toFixed(1);
  const monthlyPercent =
    stats.monthlyUtilizationRatio != null ? (stats.monthlyUtilizationRatio * 100).toFixed(1) : null;

  return (
    <section className={`space-y-3 rounded border p-4 ${styles.bg}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">メール送信モニタ (日次)</h2>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${styles.badge}`}>
          {STATUS_LABEL[stats.dailyStatus]}
        </span>
      </div>

      <div className="space-y-1">
        <p className="text-sm">
          本日の送信: <strong>{stats.dailySent.toLocaleString()}</strong> / 上限{' '}
          <strong>{stats.dailyLimit.toLocaleString()}</strong> 件{' '}
          (<span className={styles.text}>{dailyPercent}%</span>){' '}
          <span className="text-xs text-muted-foreground">
            (成功: {stats.dailySuccessful.toLocaleString()}、失敗: {stats.dailyFailed.toLocaleString()})
          </span>
        </p>
        <div className="h-2 w-full overflow-hidden rounded bg-muted">
          <div
            className={`h-full ${styles.bar}`}
            style={{ width: `${Math.min(100, stats.dailyUtilizationRatio * 100)}%` }}
          />
        </div>
      </div>

      {/* 月次は limit があれば表示 */}
      {stats.monthlyLimit != null && monthlyPercent != null && (
        <div className="space-y-1 border-t pt-2">
          <p className="text-sm">
            今月の送信: <strong>{stats.monthlySent.toLocaleString()}</strong> / 上限{' '}
            <strong>{stats.monthlyLimit.toLocaleString()}</strong> 件{' '}
            (<span className={EMAIL_STATUS_STYLES[stats.monthlyStatus].text}>{monthlyPercent}%</span>)
          </p>
          <div className="h-2 w-full overflow-hidden rounded bg-muted">
            <div
              className={`h-full ${EMAIL_STATUS_STYLES[stats.monthlyStatus].bar}`}
              style={{
                width: `${Math.min(100, (stats.monthlyUtilizationRatio ?? 0) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {stats.monthlyLimit == null && (
        <p className="text-xs text-muted-foreground border-t pt-2">
          今月の送信: <strong>{stats.monthlySent.toLocaleString()}</strong> 件 (月次上限未設定)
        </p>
      )}

      {stats.dailyStatus === 'alert' && (
        <p className="text-sm font-medium text-destructive">
          ⚠️ 日次上限に近づいています ({dailyPercent}%)。上限到達後はメール送信が自動的に
          ブロックされ、招待・パスワードリセット等の重要メールも送信できなくなります。
          上限値の引き上げまたは上位プラン契約をご検討ください。
        </p>
      )}
      {stats.dailyStatus === 'warn' && (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          ⚠️ 日次送信件数が 80% を超えました。送信パターンの監視を強化してください。
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        計測時刻: {stats.measuredAt.toLocaleString('ja-JP')}
        {' ・ '}
        日次上限変更は環境変数{' '}
        <code className="rounded bg-muted px-1">EMAIL_DAILY_LIMIT</code>、
        月次上限は <code className="rounded bg-muted px-1">EMAIL_MONTHLY_LIMIT</code> で可能
      </p>
    </section>
  );
}


// ================================================================
// Storage add-on (Phase 2 / 2026-05-08): 容量 TOP 10 ランキングカード
// ================================================================

function StorageUsageTopCard({ rows }: { rows: StorageUsageTopRow[] }) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <section className="space-y-2 rounded border p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">ストレージ使用量 TOP 10</h2>
        <p className="text-xs text-muted-foreground">
          ⚠ 80% 超 / 🚨 100% 超 (Grace period 中)
        </p>
      </div>
      <ul className="rounded border text-sm">
        {rows.map((r, idx) => {
          const usagePct = Math.round(r.storageUsageRatio * 100);
          const isOver = r.storageUsageRatio > 1.0;
          const isWarn = !isOver && r.storageUsageRatio >= 0.8;
          return (
            <li
              key={r.id}
              className={`flex items-center gap-3 border-b p-2 last:border-b-0 ${
                isOver ? "bg-destructive/5" : isWarn ? "bg-amber-50 dark:bg-amber-900/20" : ""
              }`}
            >
              <span className="w-6 text-right text-xs text-muted-foreground">{idx + 1}.</span>
              <div className="flex-1">
                <Link
                  href={`/admin/super/tenants/${r.id}`}
                  className="font-medium text-info hover:underline"
                >
                  {r.name}
                </Link>
                {r.tenantSeq != null && (
                  <span className="ml-2 text-xs text-muted-foreground">#{r.tenantSeq}</span>
                )}
                <p className="text-xs text-muted-foreground">
                  LLM: {r.llmPlan} / Storage: {r.storageAddonPlan}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs">
                  {formatBytes(r.storageBytesUsed)} / {formatBytes(r.storageLimitBytes)}
                </p>
                <p
                  className={`text-xs font-semibold ${
                    isOver ? "text-destructive" : isWarn ? "text-amber-700 dark:text-amber-400" : ""
                  }`}
                >
                  {usagePct}%
                  {r.graceState === "grace_active" && " ⚠"}
                  {r.graceState === "write_blocked" && " 🚨"}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
