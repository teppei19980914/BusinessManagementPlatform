/**
 * /admin/super (super_admin ダッシュボードのトップ) (PR-X2 / 2026-05-07)
 *
 * 全テナント横断のサマリを表示。詳細はサブナビゲーションから。
 *
 * P-5a (2026-05-08): DB 容量モニタカードを追加。Supabase プラン上限到達による
 *   データ登録不能事故を未然に防ぐためのリアルタイム可視化。
 */

import { getCrossTenantUsageSummary } from '@/services/super-admin.service';
import { getDatabaseCapacityReport } from '@/services/db-capacity.service';
import type { DbCapacityStatus } from '@/config/db-capacity';

export default async function SuperAdminTopPage() {
  const [summary, capacity] = await Promise.all([
    getCrossTenantUsageSummary(),
    getDatabaseCapacityReport(),
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
