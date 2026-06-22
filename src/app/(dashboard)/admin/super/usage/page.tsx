/**
 * /admin/super/usage (PR-X2 / 2026-05-07)
 *
 * 全テナント横断の使用量サマリ + CSV エクスポート + 過去月履歴 (P-5b / 2026-05-08)。
 *
 * - 当月のサマリカード (顧客テナント数 / アクティブユーザ / コール数 / 費用)
 * - プラン別分布
 * - **CSV ダウンロード** (当月 = 現在値、過去月 = 履歴テーブル)
 * - **過去 6 ヶ月の使用量履歴テーブル** (テナント x 月)
 *
 * 2026-05-11 改訂:
 *   - 「今月の費用」を LLM + Storage add-on 合算に変更し、内訳を補助行で併記
 *   - Default テナント (運営者自身) のサマリを別セクションで表示 (請求対象外)
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  getCrossTenantUsageSummary,
  getDefaultTenantOwnSummary,
  listMonthlyUsageHistory,
  type DefaultTenantOwnSummary,
} from '@/services/super-admin.service';

export default async function SuperAdminUsagePage() {
  const t = await getTranslations('adminUsage');
  const [summary, defaultTenant, history] = await Promise.all([
    getCrossTenantUsageSummary(),
    getDefaultTenantOwnSummary(),
    listMonthlyUsageHistory(6),
  ]);

  // history を yearMonth ごとにグルーピング (テーブル表示用)
  const byYearMonth = new Map<string, typeof history>();
  for (const row of history) {
    const list = byYearMonth.get(row.yearMonth) ?? [];
    list.push(row);
    byYearMonth.set(row.yearMonth, list);
  }
  // yearMonth は降順 (新しい月から)
  const yearMonths = Array.from(byYearMonth.keys()).sort().reverse();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t('pageTitle')}</h1>
      <p className="text-sm text-muted-foreground">
        {t('pageDesc')}
      </p>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <UsageCard
          label={t('cardTenantCount')}
          value={summary.tenantCount.toString()}
          unit={t('unitCount')}
        />
        <UsageCard
          label={t('cardActiveUsers')}
          value={summary.totalActiveUsers.toString()}
          unit={t('unitPeople')}
        />
        <UsageCard
          label={t('cardApiCalls')}
          value={summary.totalCurrentMonthApiCalls.toLocaleString()}
          unit={t('unitTimes')}
          subValue={t('cardApiCallsSubValue')}
        />
        {/* chore/storage-addon-backend-removal (2026-05-26): 旧 4 段階プラン Storage 月額は撤去。
            ApiCallLog 集計 (DB / file storage 超過の従量課金も含む) に統合
            ADR-0022 (2026-06-01): Embedding 課金も統合されたため totalCurrentMonthApiCostJpy が
            LLM + Embedding + Storage の総和を表す */}
        <UsageCard
          label={t('cardTotalCost')}
          value={`¥${summary.totalCurrentMonthApiCostJpy.toLocaleString()}`}
          unit=""
          subValue={t('cardTotalCostSubValue')}
        />
        {/* ADR-0022 (2026-06-01): Embedding 内訳 KPI カード (= 全体課金のうち Embedding 部分) */}
        <UsageCard
          label={t('cardEmbeddingCalls')}
          value={summary.totalCurrentMonthEmbeddingCalls.toLocaleString()}
          unit={t('unitTimes')}
          subValue={t('cardEmbeddingCallsSubValue')}
        />
        <UsageCard
          label={t('cardEmbeddingCost')}
          value={`¥${summary.totalCurrentMonthEmbeddingCostJpy.toLocaleString()}`}
          unit=""
          subValue={t('cardEmbeddingCostSubValue')}
        />
      </section>

      {/* 2026-05-11: Default テナント (運営者自身) サマリを別セクション */}
      <DefaultTenantUsageSection defaultTenant={defaultTenant} />

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t('planDistributionTitle')}</h2>
        <p className="text-xs text-muted-foreground">
          {t('planDistributionDesc')}
        </p>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="p-2">{t('colPlan')}</th>
              <th className="p-2 text-right">{t('colTenantCount')}</th>
            </tr>
          </thead>
          <tbody>
            {summary.planDistribution.length === 0 ? (
              <tr>
                <td colSpan={2} className="p-4 text-center text-muted-foreground">
                  {t('noTenants')}
                </td>
              </tr>
            ) : (
              summary.planDistribution.map((p) => (
                <tr key={p.plan} className="border-b">
                  <td className="p-2 capitalize">{p.plan}</td>
                  <td className="p-2 text-right">{p.count}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {/* P-5b (2026-05-08): CSV エクスポート / 2026-05-14: 解約済テナント込みエクスポート追加 */}
      <section className="space-y-2 rounded border p-4">
        <h2 className="text-lg font-semibold">{t('csvExportTitle')}</h2>
        <p className="text-xs text-muted-foreground">
          {t('csvExportDesc')}
        </p>

        {/* 通常 (アクティブテナントのみ) */}
        <div className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground">{t('csvActiveOnly')}</p>
          <div className="flex flex-wrap gap-2 text-sm">
            <a
              href="/api/admin/super/usage/export"
              className="inline-flex items-center rounded border px-3 py-1.5 hover:bg-accent"
              download
            >
              {t('csvDownloadCurrent')}
            </a>
            {yearMonths.map((ym) => (
              <a
                key={ym}
                href={`/api/admin/super/usage/export?yearMonth=${ym}`}
                className="inline-flex items-center rounded border px-3 py-1.5 hover:bg-accent"
                download
              >
                📥 {ym}
              </a>
            ))}
          </div>
        </div>

        {/* 2026-05-14: 解約済テナント込み (月途中解約の請求漏れ検知用) */}
        <div className="mt-3 space-y-1 rounded border border-amber-300 bg-amber-50 p-3 dark:bg-amber-900/20">
          <p className="text-xs font-semibold text-amber-900 dark:text-amber-100">
            {t('csvWithDeletedTitle')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('csvWithDeletedDescPre')}
            <code className="text-xs">docs/operations/BILLING_MONTHLY_OPERATIONS.md</code>
            {t('csvWithDeletedDescSuffix')}
          </p>
          <div className="flex flex-wrap gap-2 text-sm">
            <a
              href="/api/admin/super/usage/export?includeDeleted=true"
              className="inline-flex items-center rounded border border-amber-400 bg-white px-3 py-1.5 hover:bg-accent dark:bg-amber-950/40"
              download
            >
              {t('csvDownloadCurrentWithDeleted')}
            </a>
            {yearMonths.map((ym) => (
              <a
                key={`with-deleted-${ym}`}
                href={`/api/admin/super/usage/export?yearMonth=${ym}&includeDeleted=true`}
                className="inline-flex items-center rounded border border-amber-400 bg-white px-3 py-1.5 hover:bg-accent dark:bg-amber-950/40"
                download
              >
                {t('csvDownloadMonthWithDeleted', { yearMonth: ym })}
              </a>
            ))}
          </div>
        </div>

        {yearMonths.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t('csvNoHistory')}
          </p>
        )}
      </section>

      {/* P-5b (2026-05-08): 過去 6 ヶ月の履歴テーブル */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t('historyTitle')}</h2>
        {yearMonths.length === 0 ? (
          <p className="rounded border bg-muted/30 p-4 text-sm text-muted-foreground">
            {t('historyNoData')}
          </p>
        ) : (
          <div className="overflow-x-auto rounded border">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-left">{t('colMonth')}</th>
                  <th className="p-2 text-left">{t('colTenant')}</th>
                  <th className="p-2 text-left">{t('colPlan')}</th>
                  <th className="p-2 text-right" title={t('colApiCallsTooltip')}>{t('colApiCalls')}</th>
                  <th className="p-2 text-right">{t('colApiCost')}</th>
                  {/* ADR-0022 (2026-06-01): Embedding 内訳 (ADR-0022 適用前の過去月は - 表示) */}
                  <th className="p-2 text-right" title={t('colEmbeddingCallsTooltip')}>{t('colEmbeddingCalls')}</th>
                  <th className="p-2 text-right" title={t('colEmbeddingCostTooltip')}>{t('colEmbeddingCost')}</th>
                  <th className="p-2 text-right">{t('colActiveUsers')}</th>
                </tr>
              </thead>
              <tbody>
                {yearMonths.flatMap((ym) =>
                  (byYearMonth.get(ym) ?? []).map((r) => (
                    <tr key={`${ym}-${r.tenantId}`} className="border-t">
                      <td className="p-2 font-mono text-xs">{ym}</td>
                      <td className="p-2">
                        {r.tenantSeq != null && (
                          <span className="mr-1 text-xs text-muted-foreground">#{r.tenantSeq}</span>
                        )}
                        {r.tenantName}
                      </td>
                      <td className="p-2 capitalize">{r.plan}</td>
                      <td className="p-2 text-right">{r.apiCallCount.toLocaleString()}</td>
                      <td className="p-2 text-right">¥{r.apiCostJpy.toLocaleString()}</td>
                      {/* ADR-0022: 適用前の過去月は null → '-' 表示 */}
                      <td className="p-2 text-right text-muted-foreground">
                        {r.embeddingCallCount != null ? r.embeddingCallCount.toLocaleString() : '-'}
                      </td>
                      <td className="p-2 text-right text-muted-foreground">
                        {r.embeddingCostJpy != null ? `¥${r.embeddingCostJpy.toLocaleString()}` : '-'}
                      </td>
                      <td className="p-2 text-right">{r.activeUserCount}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function UsageCard({
  label,
  value,
  unit,
  subValue,
}: {
  label: string;
  value: string;
  unit: string;
  /** 2026-05-11: 内訳など補助テキスト */
  subValue?: string;
}) {
  return (
    <div className="rounded border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1">
        <span className="text-2xl font-bold">{value}</span>
        {unit && <span className="ml-1 text-sm text-muted-foreground">{unit}</span>}
      </p>
      {subValue && <p className="mt-1 text-xs text-muted-foreground">{subValue}</p>}
    </div>
  );
}

/**
 * 2026-05-11: Default テナント (運営者自身) の使用量サマリを別セクションで表示。
 */
async function DefaultTenantUsageSection({
  defaultTenant,
}: {
  defaultTenant: DefaultTenantOwnSummary | null;
}) {
  const t = await getTranslations('adminUsage');
  return (
    <section className="space-y-2 rounded border border-info/40 bg-info/5 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('defaultTenantTitle')}</h2>
        {defaultTenant && (
          <Link
            href={`/admin/super/tenants/${defaultTenant.id}`}
            className="text-xs text-info hover:underline"
          >
            {t('defaultTenantLink')}
          </Link>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {t('defaultTenantDesc')}
      </p>
      {!defaultTenant ? (
        <p className="text-sm text-muted-foreground">
          {t('defaultTenantNotFound')}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <UsageCard
            label={t('cardDefaultActiveUsers')}
            value={defaultTenant.activeUserCount.toString()}
            unit={t('unitPeople')}
          />
          <UsageCard
            label={t('cardDefaultApiCalls')}
            value={defaultTenant.currentMonthApiCallCount.toLocaleString()}
            unit={t('unitTimes')}
          />
          <UsageCard
            label={t('cardDefaultApiCost')}
            value={`¥${defaultTenant.currentMonthApiCostJpy.toLocaleString()}`}
            unit=""
            subValue={t('cardDefaultFree')}
          />
          {/* ADR-0022 (2026-06-01): Embedding 内訳カード (Default テナントも件数記録、参考) */}
          <UsageCard
            label={t('cardDefaultEmbeddingCalls')}
            value={defaultTenant.currentMonthEmbeddingCallCount.toLocaleString()}
            unit={t('unitTimes')}
          />
          <UsageCard
            label={t('cardDefaultEmbeddingCost')}
            value={`¥${defaultTenant.currentMonthEmbeddingCostJpy.toLocaleString()}`}
            unit=""
            subValue={t('cardDefaultFree')}
          />
          {/* 2026-05-31 (ADR-0030): 累積ハードキャップ撤去。50GB は L3 監視アラート閾値として進捗表示に使用 */}
          <UsageCard
            label={t('cardDefaultStorage')}
            value={formatBytesLocal(defaultTenant.storageBytesUsed)}
            unit=""
            subValue={t('cardDefaultStorageSubValue', { ratio: (defaultTenant.storageUsageRatio * 100).toFixed(1) })}
          />
        </div>
      )}
    </section>
  );
}

function formatBytesLocal(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
