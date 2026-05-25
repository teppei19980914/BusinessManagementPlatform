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

import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  getCrossTenantUsageSummary,
  listDormantTenants,
  DORMANT_TENANT_THRESHOLD_DAYS,
  listStorageUsageTop,
  // 2026-05-09 (PR E / #12 #14 #15): Voyage / Anthropic / Beginner サマリ
  getVoyageUsageSummary,
  getAnthropicUsageSummary,
  getBeginnerUsageSummary,
  // 2026-05-11: Default テナント (運営者自身) サマリ
  getDefaultTenantOwnSummary,
  type StorageUsageTopRow,
  type VoyageUsageSummary,
  type AnthropicUsageSummary,
  type BeginnerUsageSummary,
  type DefaultTenantOwnSummary,
} from '@/services/super-admin.service';
import { getDatabaseCapacityReport } from '@/services/db-capacity.service';
// ADR-0020 (2026-05-25): DB 容量従量課金アラート (R12-admin / R14)
import { DbCapacityAlertsCard } from './db-capacity-alerts-card';
import { getEmailSendStats } from '@/services/email-send-log.service';
import type { DbCapacityStatus } from '@/config/db-capacity';
import type { EmailLimitStatus } from '@/config/email-limit';
// 2026-05-14: ダッシュボード遷移時に DB 容量 + API 利用量を即時再集計する。
//   旧仕様 (cron 日次キャッシュ) では本番で storage_bytes_used_at = NULL のまま
//   滞留する事象が発生したため、画面遷移を再集計トリガーに切替えた。
import { updateAllStorageBytesUsed } from '@/services/tenant-storage.service';
import {
  reconcileAllTenantsApiUsage,
  type ApiUsageReconcileResult,
} from '@/services/api-usage-recalc.service';
import { RecalculateButton } from '@/components/recalculate-button';
import { UsageDriftBadge } from '@/components/usage-drift-badge';
// PR-V8 (2026-05-19): 診断ダッシュボードへの誘導バナー
import { getDiagnosticsSummary } from '@/services/diagnostics.service';
// PR #425 (2026-05-22): Netlify ビルドクレジット消費の可視化
import { getNetlifyMetrics, type NetlifyMetrics as NetlifyMetricsType } from '@/services/netlify-metrics.service';

export default async function SuperAdminTopPage() {
  // 2026-05-14: 表示前に全テナントの最新値を作る (請求根拠なのでキャッシュ依存しない)。
  //   updateAllStorageBytesUsed は内部で個別失敗を吸収する。
  //   reconcileAllTenantsApiUsage は Promise.allSettled で並列実行。
  // PR-V8 (2026-05-19): 診断ダッシュボードの異常件数を取得 (赤バナー表示用)
  const [, apiReconciles, diagnostics, netlifyMetrics] = await Promise.all([
    updateAllStorageBytesUsed(),
    reconcileAllTenantsApiUsage(),
    getDiagnosticsSummary(),
    // PR #425 (2026-05-22): Netlify ビルドクレジット消費を取得 (= API 失敗時は空メトリクス + error メッセージで継続)
    getNetlifyMetrics(),
  ]);
  const apiReconcileByTenant = new Map<string, ApiUsageReconcileResult>(
    apiReconciles.map((r) => [r.tenantId, r]),
  );

  const [summary, defaultTenant, capacity, dormant, emailStats, storageTop, voyage, anthropic, beginner] = await Promise.all([
    getCrossTenantUsageSummary(),
    getDefaultTenantOwnSummary(),
    getDatabaseCapacityReport(),
    listDormantTenants(),
    getEmailSendStats(),
    listStorageUsageTop(10),
    // 2026-05-09 (PR E)
    getVoyageUsageSummary(),
    getAnthropicUsageSummary(),
    getBeginnerUsageSummary(),
  ]);
  const defaultTenantReconcile = defaultTenant
    ? apiReconcileByTenant.get(defaultTenant.id) ?? null
    : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">システム管理者ダッシュボード</h1>
        {/* 2026-05-14: 全テナントの DB 容量 + API 利用量を明示的に再集計 */}
        <RecalculateButton
          endpoint="/api/admin/super/recalculate-all"
          label="全テナント再集計"
          size="default"
          variant="default"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        DB 容量と API 利用量はこの画面を開いた時点で全テナントの最新値を集計しています。手動で再集計するには上のボタンを押してください。
      </p>

      {/* PR-V8 (2026-05-19): 診断ダッシュボードへの誘導バナー */}
      {diagnostics.totalAnomalies > 0 && (
        <Link
          href="/admin/super/diagnostics"
          className="block rounded border border-red-400 bg-red-50 p-4 text-red-900 hover:bg-red-100 dark:border-red-600 dark:bg-red-900/30 dark:text-red-100 dark:hover:bg-red-900/50"
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="text-lg font-semibold">
                ⚠️ {diagnostics.totalAnomalies} 件の異常を検知
              </div>
              <div className="mt-1 text-sm">
                API drift / cron 健全性 / 縮退モード / メール失敗 / alert 機構 のいずれかで異常が発生しています。詳細を確認するにはクリック →
              </div>
            </div>
            <div className="font-mono text-sm">/admin/super/diagnostics</div>
          </div>
        </Link>
      )}

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* 2026-05-09 (PR E): 全項目に title 属性でツールチップ追加 */}
        <SummaryCard
          label="顧客テナント数"
          value={summary.tenantCount.toString()}
          tooltip="現在契約中の顧客テナント数 (削除済み・管理テナント・default テナント = 運営者自身は除外。Default テナントは下部の専用セクションを参照)"
        />
        <SummaryCard
          label="アクティブユーザ総数"
          value={summary.totalActiveUsers.toString()}
          tooltip="顧客テナントに所属する isActive=true のユーザ総数 (招待未承諾 / 削除済みは除外、Default テナントのユーザも除外)"
        />
        <SummaryCard
          label="今月の API 呼出 (合計)"
          value={summary.totalCurrentMonthApiCalls.toLocaleString()}
          tooltip="顧客テナント全体の当月 LLM/Embedding 呼出回数。月初 (UTC) にリセット (Default テナント除く)"
        />
        {/* 2026-05-11: 合算課金 (LLM + Storage add-on) を表示し、内訳を補助行で併記 */}
        <SummaryCard
          label="今月の合計課金 (LLM + Storage)"
          value={`¥${summary.totalCurrentMonthCombinedJpy.toLocaleString()}`}
          subValue={`内訳: LLM ¥${summary.totalCurrentMonthApiCostJpy.toLocaleString()} + Storage ¥${summary.totalCurrentMonthStorageJpy.toLocaleString()}`}
          tooltip="顧客テナント全体の当月内部請求額。LLM 部分 (プラン別従量課金) + Storage add-on (固定月額) の合算。Default テナント (運営者自身) は請求対象外のため含まれません"
        />
      </section>

      {/* 2026-05-11: Default テナント (運営者自身) 専用セクション */}
      <DefaultTenantSection defaultTenant={defaultTenant} reconcile={defaultTenantReconcile} />

      {/* 2026-05-09 (PR E / #12): Voyage AI 無料枠モニタ */}
      <VoyageUsageCard voyage={voyage} />

      {/* 2026-05-09 (PR E / #14): Anthropic 当月使用量 */}
      <AnthropicUsageCard anthropic={anthropic} apiReconciles={apiReconciles} />

      {/* 2026-05-09 (PR E / #15): Beginner プラン使用状況 */}
      <BeginnerUsageCard beginner={beginner} />

      {/* PR #425 (2026-05-22): Netlify ビルドクレジット消費モニタ */}
      <NetlifyMetricsCard metrics={netlifyMetrics} />

      {/* P-5a: DB 容量モニタ */}
      <DatabaseCapacityCard capacity={capacity} />

      {/* P-H (2026-05-08): メール送信モニタ */}
      <EmailSendMonitorCard stats={emailStats} />

      {/* P-6 (2026-05-08): 休眠テナント警告 */}
      <DormantTenantsCard dormant={dormant} />

      {/* Storage add-on (Phase 2 / 2026-05-08): テナント別容量 TOP 10 */}
      <StorageUsageTopCard rows={storageTop} />

      {/* ADR-0020 (2026-05-25): DB 容量従量課金 L1-L4 alert + drift 検知 (R12-admin / R14) */}
      <DbCapacityAlertsCard />

      <section className="space-y-2" title="現在の契約プラン別テナント分布 (顧客テナントのみ)。営業・解約予測のベース指標">
        <h2 className="text-lg font-semibold">プラン別テナント数 (顧客テナントのみ)</h2>
        <p className="text-xs text-muted-foreground">
          Default テナント (運営者自身) は専用セクションに表示しています
        </p>
        <ul className="rounded border p-3 text-sm">
          {summary.planDistribution.length === 0 ? (
            <li className="text-muted-foreground">顧客テナントがまだ登録されていません</li>
          ) : (
            summary.planDistribution.map((p) => (
              <li
                key={p.plan}
                className="flex justify-between border-b py-1 last:border-b-0"
                title={
                  p.plan === 'beginner'
                    ? 'Beginner: プロジェクト作成/更新 月 50 回まで無料・最大 5 席・90 日試用 (資産入力・チャット検索は無料・無制限、ADR-0019)'
                    : p.plan === 'expert'
                      ? 'Expert: プロジェクト作成/更新 ¥10/call、Claude Haiku (資産入力・チャット検索は無料、ADR-0019)'
                      : p.plan === 'pro'
                        ? 'Pro: プロジェクト作成/更新 + なぜ機能 ¥15/call、Claude Sonnet (資産入力・チャット検索は無料、ADR-0019)'
                        : `プラン: ${p.plan}`
                }
              >
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

function SummaryCard({
  label,
  value,
  tooltip,
  subValue,
}: {
  // 2026-05-14: ReactNode 許容 (drift badge を label に併記するため)
  label: ReactNode;
  value: string;
  // 2026-05-09 (PR E): 全カードにツールチップ (title 属性 + cursor-help)
  tooltip?: string;
  /** 2026-05-11: 内訳など補助テキスト (例: "LLM ¥X + Storage ¥Y") */
  subValue?: string;
}) {
  return (
    <div
      className={`rounded border p-4${tooltip ? ' cursor-help' : ''}`}
      title={tooltip}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
      {subValue && <p className="mt-1 text-xs text-muted-foreground">{subValue}</p>}
    </div>
  );
}

/**
 * 2026-05-11: Default テナント (運営者自身) 専用セクション。
 *
 * 顧客テナント集計とは別枠で、運営者自身のテナント (= 請求対象外) の使用状況を表示する。
 * Default テナントが存在しない場合 (seed 未投入等) は空のメッセージを表示。
 */
function DefaultTenantSection({
  defaultTenant,
  reconcile,
}: {
  defaultTenant: DefaultTenantOwnSummary | null;
  reconcile: ApiUsageReconcileResult | null;
}) {
  if (!defaultTenant) {
    return (
      <section className="space-y-2 rounded border border-info/30 bg-info/5 p-4">
        <h2 className="text-lg font-semibold">Default テナント (運営者自身)</h2>
        <p className="text-sm text-muted-foreground">
          Default テナントが存在しません (seed 未投入または削除済)。
        </p>
      </section>
    );
  }
  const usagePercent = (defaultTenant.storageUsageRatio * 100).toFixed(2);
  return (
    <section
      className="space-y-3 rounded border border-info/40 bg-info/5 p-4"
      title="Default テナント (= 運営者自身のテナント)。請求対象外のため顧客集計には含まれず、ここで個別に状況を確認します"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Default テナント (運営者自身)</h2>
        <div className="flex items-center gap-2">
          {/* 2026-05-14: Default テナント単体の再集計 */}
          <RecalculateButton
            endpoint={`/api/admin/super/tenants/${defaultTenant.id}/recalculate`}
            label="このテナントを再集計"
          />
          <Link
            href={`/admin/super/tenants/${defaultTenant.id}`}
            className="text-xs text-info hover:underline"
          >
            詳細を見る →
          </Link>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        運営者自身のテナント。顧客課金集計には含まれません (= 請求対象外)
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          label="テナント"
          value={defaultTenant.name}
          tooltip={`slug: ${defaultTenant.slug} / plan: ${defaultTenant.plan} / 作成: ${defaultTenant.createdAt.toISOString().split('T')[0]}`}
        />
        <SummaryCard
          label="アクティブユーザ数"
          value={defaultTenant.activeUserCount.toString()}
          tooltip="Default テナント所属の isActive=true ユーザ数"
        />
        {/* ★ PR-V8.1 (2026-05-19) 請求 invariant: ApiCallLog SUM (真値) を表示。
            counter 値とのズレが請求書根拠と画面表示の乖離を生むため、両画面 (テナント管理者
            画面 + システム管理者画面) で同じ SUM 値を表示するよう統一。reconcile=null
            (=削除済等) のときのみ counter にフォールバック。 */}
        <SummaryCard
          label={
            <span>
              今月の API 呼出
              <UsageDriftBadge reconcile={reconcile} showDiagnosticsLink={true} />
            </span>
          }
          value={(
            reconcile?.reconciledCallCount ?? defaultTenant.currentMonthApiCallCount
          ).toLocaleString()}
          tooltip="当月の LLM/Embedding 呼出回数 (ApiCallLog 集計 = 請求書根拠と同じ真値、PR-V8.1)"
        />
        <SummaryCard
          label="今月の API 費用 (参考)"
          value={`¥${(
            reconcile?.reconciledCostJpy ?? defaultTenant.currentMonthApiCostJpy
          ).toLocaleString()}`}
          subValue="(請求対象外、ApiCallLog 集計値)"
          tooltip="ApiCallLog 集計値。Default テナントは請求対象外のため実際の請求は発生しません (PR-V8.1)"
        />
        <SummaryCard
          label="Storage プラン"
          value={defaultTenant.storageAddonPlan}
          tooltip="standard / plus / pro_storage / enterprise"
        />
        <SummaryCard
          label="Storage 使用量"
          value={`${formatBytes(defaultTenant.storageBytesUsed)} / ${formatBytes(defaultTenant.storageLimitBytes)}`}
          subValue={`${usagePercent}%`}
          tooltip="添付ファイル等の合算サイズ / 上限"
        />
      </div>
    </section>
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
    <section
      className={`space-y-3 rounded border p-4 ${styles.bg}`}
      title="Supabase Postgres の DB 容量。上限到達でデータ登録が失敗するため事前検知用。プラン上限変更は環境変数 DB_CAPACITY_LIMIT_BYTES で可能"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold" title="DB の物理容量を計測してプラン上限との対比を表示するモニタ (P-5a)">
          DB 容量モニタ
        </h2>
        <div className="flex items-center gap-2">
          {/* 2026-05-14: pg_database_size は元々リアルタイムだが、RSC キャッシュ更新トリガとして配置 */}
          <RecalculateButton
            endpoint="/api/admin/super/recalculate-all"
            label="DB 容量を再集計"
          />
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${styles.badge}`}
            title={
              capacity.status === 'alert'
                ? '緊急: 上限に近接。直ちにアップグレード or データ削除を'
                : capacity.status === 'warn'
                  ? '要注意: 80% 超過、推移を監視'
                  : '正常 (80% 未満)'
            }
          >
            {STATUS_LABEL[capacity.status]}
          </span>
        </div>
      </div>

      <div className="space-y-1">
        <p
          className="text-sm"
          title={`使用量 ${formatBytes(capacity.usedBytes)} / 上限 ${formatBytes(capacity.limitBytes)}`}
        >
          使用量: <strong>{formatBytes(capacity.usedBytes)}</strong> / 上限{' '}
          <strong>{formatBytes(capacity.limitBytes)}</strong>
          {' '}
          (<span className={styles.text}>{percent}%</span>)
        </p>
        {/* シンプルなプログレスバー */}
        <div
          className="h-2 w-full overflow-hidden rounded bg-muted"
          title="プログレスバー: 緑=正常, 黄=80% 超, 赤=100% 超"
        >
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
      <section
        className="space-y-2 rounded border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900/40 dark:bg-emerald-950/30"
        title={`90 日以上ログインのないテナントを検出するアラート (P-6)。現在 0 件 = 健全`}
      >
        <h2 className="text-lg font-semibold">休眠テナント警告</h2>
        <p className="text-sm text-emerald-800 dark:text-emerald-300">
          ✅ 全テナントが {DORMANT_TENANT_THRESHOLD_DAYS} 日以内に活動しています。健全な状態です。
        </p>
      </section>
    );
  }

  return (
    <section
      className="space-y-2 rounded border border-destructive/30 bg-destructive/5 p-4"
      title="90 日以上テナント内でログインがない = 解約予兆。営業・サポートのトリガーとして活用"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">休眠テナント警告</h2>
        <span
          className="rounded-full bg-destructive px-2 py-0.5 text-xs font-semibold text-destructive-foreground"
          title={`${dormant.length} 件の休眠テナントを検出 (要対応)`}
        >
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
              <th className="p-2" title="テナント名 (クリックで詳細画面へ)">テナント</th>
              <th className="p-2" title="現在の契約プラン">プラン</th>
              <th className="p-2" title="テナント内のいずれかのユーザの最終ログイン日">最終ログイン</th>
              <th className="p-2 text-right" title="最終活動日 (lastLoginAt or createdAt) からの経過日数">休眠日数</th>
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

/**
 * 2026-05-11: パーセント表示を動的精度で整形。
 *   0.0% に丸まることで「使っていない」と誤解されるのを防ぐ。
 *   - < 0.1%: 小数点 3 桁 (例: "0.030%")
 *   - < 10%:  小数点 2 桁 (例: "5.40%")
 *   - それ以外: 小数点 1 桁 (例: "48.0%")
 */
function formatPercent(percent: number): string {
  const abs = Math.abs(percent);
  if (abs < 0.1) return percent.toFixed(3);
  if (abs < 10) return percent.toFixed(2);
  return percent.toFixed(1);
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
    <section
      className={`space-y-3 rounded border p-4 ${styles.bg}`}
      title="メール送信プロバイダ (Brevo 等) の日次/月次送信上限モニタ。上限到達で招待・パスワードリセット等の重要メールが送れなくなるため事前検知 (P-H)"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold" title="MAIL_PROVIDER の送信上限を可視化。Brevo は 300 通/日 (無料プラン)">
          メール送信モニタ (日次)
        </h2>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${styles.badge}`}
          title={
            stats.dailyStatus === 'alert'
              ? '緊急: 日次上限に近接、上限到達で送信ブロック'
              : stats.dailyStatus === 'warn'
                ? '要注意: 80% 超過、推移を監視'
                : '正常 (80% 未満)'
          }
        >
          {STATUS_LABEL[stats.dailyStatus]}
        </span>
      </div>

      <div className="space-y-1">
        <p
          className="text-sm"
          title={`本日 ${stats.dailySent.toLocaleString()} 通 / 上限 ${stats.dailyLimit.toLocaleString()} 通 (成功 ${stats.dailySuccessful} / 失敗 ${stats.dailyFailed})`}
        >
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

      {/* PR-V7a (2026-05-19): 送付失敗 alert。1 件でも失敗していれば赤背景で詳細リンク表示 */}
      {stats.dailyFailed > 0 && (
        <div className="rounded border border-destructive/30 bg-destructive/10 p-2 text-sm">
          <strong className="text-destructive">
            ⚠️ 本日 {stats.dailyFailed.toLocaleString()} 件のメール送付に失敗しています
          </strong>
          <span className="ml-1 text-xs text-muted-foreground">
            (招待 / 請求書送付 / 警告通知等の到達失敗。請求業務上は特に invoice テナントへの
            請求書送付失敗を放置すると滞納に直結)
          </span>
          {' '}
          <Link
            href="/admin/super/email-failures"
            className="font-medium text-info underline-offset-2 hover:underline"
          >
            詳細を確認 →
          </Link>
        </div>
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
    <section
      className="space-y-2 rounded border p-4"
      title="顧客テナントのストレージ使用量 TOP 10 ランキング。Storage add-on プラン (standard / plus / pro_storage) と上限到達状態を表示"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold" title="Phase 2 (2026-05-08) で導入された Storage add-on のテナント別容量モニタ">
          ストレージ使用量 TOP 10
        </h2>
        <div className="flex items-center gap-3">
          <p
            className="text-xs text-muted-foreground"
            title="⚠ = 80% 超 / 🚨 = 100% 超で Grace period 中 (7 日経過で write 停止)"
          >
            ⚠ 80% 超 / 🚨 100% 超 (Grace period 中)
          </p>
          <RecalculateButton
            endpoint="/api/admin/super/recalculate-all"
            label="ストレージ全件再集計"
          />
        </div>
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
              <div className="flex items-center gap-2">
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
                {/* 2026-05-14: 個別テナント再集計 */}
                <RecalculateButton
                  endpoint={`/api/admin/super/tenants/${r.id}/recalculate`}
                  label="再集計"
                  size="xs"
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ================================================================
// 2026-05-09 (PR E / #12): Voyage AI 無料枠カード
// ================================================================

// ADR-0019 (2026-05-24): Voyage 全社監視を 3 段階 (warn 80% / critical 90% / alert 100%) に拡張。
const VOYAGE_STATUS_STYLES: Record<VoyageUsageSummary['status'], { bg: string; bar: string; badge: string; text: string }> = {
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
  critical: {
    bg: 'bg-orange-50 dark:bg-orange-950/30',
    bar: 'bg-orange-600',
    badge: 'bg-orange-200 text-orange-900 dark:bg-orange-900/40 dark:text-orange-200',
    text: 'text-orange-700 dark:text-orange-400',
  },
  alert: {
    bg: 'bg-destructive/10',
    bar: 'bg-destructive',
    badge: 'bg-destructive text-destructive-foreground',
    text: 'text-destructive',
  },
};

const VOYAGE_STATUS_LABEL: Record<VoyageUsageSummary['status'], string> = {
  ok: '正常',
  warn: '要注意 (80%+)',
  critical: '切迫 (90%+)',
  alert: '超過 (100%+)',
};

function VoyageUsageCard({ voyage }: { voyage: VoyageUsageSummary }) {
  const styles = VOYAGE_STATUS_STYLES[voyage.status];
  // 2026-05-11: 1% 未満では 0.0% に丸まって「使ってない」と誤解されるため小数点精度を動的調整
  //   例: 0.03% → "0.030%"、5.4% → "5.40%"、48% → "48.0%"
  const percent = formatPercent(voyage.utilizationRatio * 100);

  return (
    <section
      className={`space-y-3 rounded border p-4 ${styles.bg}`}
      title="Voyage AI (embedding 用) の当月トークン使用量と無料枠 (200M tokens/月) 対比。80% 超で要注意、100% 超で従量課金が発生します。"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold" title="Voyage AI は提案エンジンの類似度検索 (embedding) で利用される外部サービス">
          Voyage AI 無料枠 (当月)
        </h2>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${styles.badge}`}
          title={
            voyage.status === 'alert'
              ? '無料枠を超過。従量課金が発生中の可能性あり'
              : voyage.status === 'critical'
                ? '90% 超過、即時対応推奨 (ADR-0019)'
                : voyage.status === 'warn'
                  ? '80% 超過、推移を要監視'
                  : '健全 (80% 未満)'
          }
        >
          {VOYAGE_STATUS_LABEL[voyage.status]}
        </span>
      </div>

      <div className="space-y-1">
        <p className="text-sm" title={`累計 ${voyage.currentMonthTokens.toLocaleString()} tokens / 上限 ${voyage.freeTierTokens.toLocaleString()} tokens`}>
          使用量: <strong>{voyage.currentMonthTokens.toLocaleString()}</strong> tokens / 無料枠{' '}
          <strong>{voyage.freeTierTokens.toLocaleString()}</strong> tokens (
          <span className={styles.text}>{percent}%</span>)
        </p>
        <div
          className="h-2 w-full overflow-hidden rounded bg-muted"
          title="プログレスバー: 緑=正常, 黄=80% 超, 赤=100% 超"
        >
          <div
            className={`h-full ${styles.bar}`}
            style={{ width: `${Math.min(100, voyage.utilizationRatio * 100)}%` }}
          />
        </div>
      </div>

      {voyage.status === 'alert' && (
        <p className="text-sm font-medium text-destructive">
          ⚠️ 無料枠 200M tokens を超えました。Voyage 側で従量課金が発生している可能性があります (公式単価: $0.05/M tokens)。
        </p>
      )}
      {voyage.status === 'warn' && (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          ⚠️ 無料枠の 80% を超えました。推移を監視してください。
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        集計対象: 顧客テナント全体 (管理 + default は除外)。 計測元: ApiCallLog.embedding_tokens
      </p>
    </section>
  );
}

// ================================================================
// 2026-05-09 (PR E / #14): Anthropic 当月使用量カード
// ================================================================

function AnthropicUsageCard({
  anthropic,
  apiReconciles,
}: {
  anthropic: AnthropicUsageSummary;
  apiReconciles: ApiUsageReconcileResult[];
}) {
  const totalTokens = anthropic.currentMonthInputTokens + anthropic.currentMonthOutputTokens;
  // 2026-05-14: ApiCallLog SUM と Tenant counter の drift がある全テナント数
  const driftCount = apiReconciles.filter((r) => r.hasDrift).length;

  return (
    <section
      className="space-y-3 rounded border p-4"
      title="Anthropic Claude (LLM) の当月使用量。auto-tag-extract / suggestion-explanation の 2 経路のみで発火 (詳細: T-03 リリースノート Q6)"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold" title="Anthropic Claude は自動タグ抽出 (プロジェクト作成/更新) と「なぜ?」説明文 (Pro 限定) の 2 経路で利用">
          Anthropic 使用量 (当月)
        </h2>
        <div className="flex items-center gap-2">
          {driftCount > 0 && (
            <span
              className="inline-flex items-center rounded-full border border-amber-400 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
              title={`${driftCount} テナントで Tenant counter と ApiCallLog SUM の差分が 5% 以上です。各テナント詳細画面で確認・修復してください`}
            >
              ⚠ drift {driftCount} テナント
            </span>
          )}
          <RecalculateButton
            endpoint="/api/admin/super/recalculate-all"
            label="API 利用量を再集計"
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          label="API 呼出回数"
          value={anthropic.currentMonthCallCount.toLocaleString()}
          tooltip="featureUnit=auto-tag-extract / suggestion-explanation の合計呼出回数 (当月)"
        />
        <SummaryCard
          label="入力トークン (合計)"
          value={anthropic.currentMonthInputTokens.toLocaleString()}
          tooltip="プロンプト + システムメッセージのトークン数合計。Anthropic 課金根拠 (input 単価)"
        />
        <SummaryCard
          label="出力トークン (合計)"
          value={anthropic.currentMonthOutputTokens.toLocaleString()}
          tooltip="LLM が生成したトークン数合計。Anthropic 課金根拠 (output 単価、input より高単価)"
        />
        <SummaryCard
          label="内部請求額"
          value={`¥${anthropic.currentMonthInternalCostJpy.toLocaleString()}`}
          tooltip="プラン別固定単価で計算した内部請求額 (Beginner ¥0 / Expert ¥5/call / Pro ¥15/call、2026-05-15 改定後)。Anthropic 実コストとは別系統"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        集計対象: 顧客テナント全体 (管理 + default は除外)、合計トークン {totalTokens.toLocaleString()}
        {' ・ '}
        Anthropic 実 API 課金は Anthropic Console で別途確認 (リリースノート Q5 参照)
      </p>
    </section>
  );
}

// ================================================================
// 2026-05-09 (PR E / #15): Beginner プラン使用状況カード
// ================================================================

function BeginnerUsageCard({ beginner }: { beginner: BeginnerUsageSummary }) {
  const hasWarning = beginner.warning60Count + beginner.warning75Count + beginner.expiredCount > 0;
  return (
    <section
      className={`space-y-3 rounded border p-4 ${hasWarning ? 'bg-amber-50 dark:bg-amber-950/30' : ''}`}
      title="Beginner プラン契約中のテナント数と期限切迫サマリ。90 日試用期間後は読み取り専用モードに自動移行"
    >
      <h2 className="text-lg font-semibold" title="Beginner プラン: プロジェクト作成/更新 月 50 回まで無料・最大 5 席・90 日試用 (資産入力・チャット検索は無料・無制限、ADR-0019)">
        Beginner プラン使用状況
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <SummaryCard
          label="契約テナント数"
          value={beginner.totalTenants.toString()}
          tooltip="現在 plan='beginner' のテナント件数 (削除済み・管理 + default 除外)"
        />
        <SummaryCard
          label="60 日警告"
          value={beginner.warning60Count.toString()}
          tooltip="作成から 60 日経過し、Expert/Pro へのアップグレードを促すメールが送信されたテナント"
        />
        <SummaryCard
          label="75 日警告"
          value={beginner.warning75Count.toString()}
          tooltip="作成から 75 日経過、最終警告メールが送信されたテナント (15 日以内に上位プラン契約しないと read-only)"
        />
        <SummaryCard
          label="期限切れ"
          value={beginner.expiredCount.toString()}
          tooltip="90 日経過し読み取り専用モードに移行したテナント。Expert/Pro 契約で復帰可能"
        />
        <SummaryCard
          label="当月 API 呼出 (合計)"
          value={beginner.totalCurrentMonthCalls.toLocaleString()}
          tooltip="Beginner プランの当月課金対象 call 総数 (各テナント月 50 回上限、ADR-0019)。プロジェクト作成/更新のみカウント、資産入力・チャット検索は対象外"
        />
      </div>
    </section>
  );
}

/**
 * PR #425 (2026-05-22): Netlify ビルドクレジット消費モニタ。
 *
 * Netlify Starter Plan の integration credits 300/月 を超過しないようリアルタイム可視化する。
 * - 今月のビルド回数 (= JST 月初〜現在)
 * - 推定 credits 消費量 (= ビルド数 × 15、Netlify 公式値ではなく概算)
 * - 残 credits (= 300 - 推定消費量)
 * - 最新ビルドの状態 + コンテキスト
 *
 * API 失敗時 (= NETLIFY_API_TOKEN 未設定 / 通信エラー) は警告メッセージのみ表示し画面遷移を妨げない。
 *
 * 関連 KDD §5.X+104: 請求堅牢性多層防御 (= 本タイルは外部サービス consumed の早期検知)
 */
function NetlifyMetricsCard({ metrics }: { metrics: NetlifyMetricsType }) {
  const usagePercent = metrics.estimatedCreditsUsed > 0
    ? Math.min(100, Math.round((metrics.estimatedCreditsUsed / 300) * 100))
    : 0;
  const isWarning = usagePercent >= 70 && usagePercent < 90;
  const isCritical = usagePercent >= 90;
  const headerColor = isCritical
    ? 'border-destructive bg-destructive/10'
    : isWarning
      ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/30'
      : 'border-border';

  return (
    <section
      className={`space-y-3 rounded border p-4 ${headerColor}`}
      title="Netlify Starter Plan の integration credits (300/月) 消費を可視化。70% 超過で警告、90% 超過で critical 表示"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Netlify ビルド credits</h2>
        <a
          href="https://app.netlify.com/projects/tasukiba/deploys"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-info underline"
        >
          Netlify Dashboard を開く ↗
        </a>
      </div>

      {metrics.error ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-900/30">
          <p className="font-semibold">⚠ メトリクス取得失敗</p>
          <p className="text-muted-foreground">{metrics.error}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Netlify Personal Access Token を発行 (https://app.netlify.com/user/applications#personal-access-tokens)
            し、Netlify env vars に `NETLIFY_API_TOKEN` + `NETLIFY_SITE_ID` を設定してください。
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div
              className="cursor-help"
              title="JST 月初〜現在のビルド総数 (Production + Deploy Preview + Branch deploy 合算)"
            >
              <p className="text-xs text-muted-foreground">今月のビルド回数</p>
              <p className="text-xl font-bold">{metrics.buildsThisMonth.toLocaleString()}</p>
            </div>
            <div
              className="cursor-help"
              title="推定 integration credits 消費量 (= ビルド数 × 15、Netlify 公開仕様外の概算値)"
            >
              <p className="text-xs text-muted-foreground">推定 credits 消費</p>
              <p className={`text-xl font-bold ${isCritical ? 'text-destructive' : isWarning ? 'text-amber-600' : ''}`}>
                {metrics.estimatedCreditsUsed.toLocaleString()} / 300
              </p>
            </div>
            <div
              className="cursor-help"
              title="残り credits (= Starter Plan の今月の残量目安)"
            >
              <p className="text-xs text-muted-foreground">残 credits</p>
              <p className={`text-xl font-bold ${isCritical ? 'text-destructive' : isWarning ? 'text-amber-600' : 'text-info'}`}>
                {metrics.estimatedCreditsRemaining.toLocaleString()}
              </p>
            </div>
          </div>
          <div className="h-2 w-full overflow-hidden rounded bg-muted">
            <div
              className={`h-full ${isCritical ? 'bg-destructive' : isWarning ? 'bg-amber-500' : 'bg-info'}`}
              style={{ width: `${usagePercent}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            消化率 {usagePercent}%
            {metrics.latestBuildAt && (
              <span className="ml-3">
                最新ビルド: {new Date(metrics.latestBuildAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST
                {metrics.latestBuildContext && ` (${metrics.latestBuildContext})`}
                {' / 状態: '}
                <span className={metrics.latestBuildState === 'ready' ? 'text-info' : metrics.latestBuildState === 'error' ? 'text-destructive' : ''}>
                  {metrics.latestBuildState}
                </span>
              </span>
            )}
          </p>
          {isCritical && (
            <p className="rounded bg-destructive/10 p-2 text-xs text-destructive" role="alert">
              ⚠️ credits 90% 超過。今月のビルドを控える / 月跨ぎを待つ等を検討してください。
            </p>
          )}
        </>
      )}
    </section>
  );
}
