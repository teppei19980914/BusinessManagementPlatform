/**
 * /admin/super/tenants/[id] (PR-X2 / 2026-05-07)
 *
 * テナント詳細画面。entity 数と当月使用量を表示。
 *
 * P-6 (2026-05-08): 最終ログイン日時 + 休眠日数を表示。休眠 (90 日以上) は警告色。
 */

import { notFound } from 'next/navigation';
import {
  getTenantDetail,
  DORMANT_TENANT_THRESHOLD_DAYS,
} from '@/services/super-admin.service';

export default async function SuperAdminTenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tenant = await getTenantDetail(id);
  if (!tenant) notFound();

  // P-6: 休眠状態は service 側で計算済 (render 中の Date.now() を回避)
  const { daysSinceLastActivity, isDormant } = tenant;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{tenant.name}</h1>
        <p className="text-sm text-muted-foreground">
          tenantSeq: {tenant.tenantSeq ?? '-'} / slug: {tenant.slug} / 作成日:{' '}
          {tenant.createdAt.toISOString().split('T')[0]}
        </p>
      </div>

      {/* P-6 (2026-05-08): 休眠警告 */}
      {isDormant && (
        <section className="rounded border border-destructive/30 bg-destructive/10 p-3 text-sm">
          <strong className="text-destructive">⚠ 休眠テナントの可能性</strong>
          <p className="mt-1 text-muted-foreground">
            {tenant.lastUserLoginAt
              ? `最終ログインから ${daysSinceLastActivity} 日経過しています (しきい値: ${DORMANT_TENANT_THRESHOLD_DAYS} 日)。`
              : `テナント作成から ${daysSinceLastActivity} 日経過していますが、まだいずれのユーザもログインしていません。`}
          </p>
        </section>
      )}

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <DetailCard label="プラン" value={tenant.plan} />
        <DetailCard label="アクティブユーザ数" value={tenant.activeUserCount.toString()} />
        {/* P-6: 最終ログイン日時 */}
        <DetailCard
          label="最終ログイン (テナント内)"
          value={
            tenant.lastUserLoginAt
              ? `${tenant.lastUserLoginAt.toISOString().split('T')[0]} (${daysSinceLastActivity} 日前)`
              : '未ログイン'
          }
          highlight={isDormant}
        />
        <DetailCard
          label="今月 API 呼出"
          value={tenant.currentMonthApiCallCount.toLocaleString()}
        />
        <DetailCard
          label="今月 API 費用"
          value={`¥${tenant.currentMonthApiCostJpy.toLocaleString()}`}
        />
        <DetailCard
          label="月次予算上限"
          value={tenant.monthlyBudgetCapJpy != null ? `¥${tenant.monthlyBudgetCapJpy.toLocaleString()}` : '無制限'}
        />
        <DetailCard
          label="Beginner 月間呼出上限"
          value={tenant.beginnerMonthlyCallLimit.toString()}
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">エンティティ数</h2>
        <ul className="rounded border p-3 text-sm">
          <EntityRow label="プロジェクト" count={tenant.entityCounts.projects} />
          <EntityRow label="ナレッジ" count={tenant.entityCounts.knowledges} />
          <EntityRow label="リスク/課題" count={tenant.entityCounts.risksIssues} />
          <EntityRow label="振り返り" count={tenant.entityCounts.retrospectives} />
          <EntityRow label="メモ" count={tenant.entityCounts.memos} />
        </ul>
      </section>

      {tenant.scheduledPlanChangeAt && tenant.scheduledNextPlan && (
        <section className="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-900/30">
          <strong>プラン変更予約:</strong> {tenant.scheduledPlanChangeAt.toISOString().split('T')[0]}{' '}
          に {tenant.scheduledNextPlan} へ変更予定
        </section>
      )}
    </div>
  );
}

function DetailCard({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  /** P-6: 休眠警告などで強調表示したい場合 true */
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded border p-4 ${highlight ? 'border-destructive/30 bg-destructive/5' : ''}`}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-xl font-bold ${highlight ? 'text-destructive' : ''}`}>{value}</p>
    </div>
  );
}

function EntityRow({ label, count }: { label: string; count: number }) {
  return (
    <li className="flex justify-between border-b py-1 last:border-b-0">
      <span>{label}</span>
      <span className="font-mono">{count.toLocaleString()}</span>
    </li>
  );
}
