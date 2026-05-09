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
import { MANAGEMENT_TENANT_ID } from '@/lib/tenant';
import { TenantDeleteButton } from './tenant-delete-button';

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

      {/* Storage add-on (Phase 2 / 2026-05-08): 容量 + 課金統合表示 */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">ストレージ + 月次課金</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <DetailCard
            label="ストレージプラン"
            value={`${tenant.storageAddonPlan} (+¥${tenant.storageAddonMonthlyJpy.toLocaleString()}/月)`}
          />
          <DetailCard
            label="使用量 / 上限"
            value={`${formatBytesSuper(tenant.storageBytesUsed)} / ${formatBytesSuper(tenant.storageLimitBytes)} (${Math.round(tenant.storageUsageRatio * 100)}%)`}
            highlight={tenant.storageUsageRatio > 1.0}
          />
          <DetailCard
            label="当月予想合計課金"
            value={`¥${tenant.totalCurrentMonthJpy.toLocaleString()} (LLM ¥${tenant.currentMonthApiCostJpy.toLocaleString()} + Storage ¥${tenant.storageAddonMonthlyJpy.toLocaleString()})`}
          />
        </div>
        {tenant.storageGracePeriodStartedAt && (
          <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs dark:bg-amber-900/30">
            ⚠ Grace period 開始: {tenant.storageGracePeriodStartedAt.toISOString().split('T')[0]} (7 日経過で write 停止)
          </p>
        )}
        {tenant.storageScheduledAt && tenant.storageScheduledNext && (
          <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs dark:bg-amber-900/30">
            予約: {tenant.storageScheduledAt.toISOString().split('T')[0]} に{' '}
            <span className="font-mono">{tenant.storageScheduledNext}</span> へ変更予定
          </p>
        )}
      </section>

      {/* P-G (2026-05-08): 請求先情報 / PR C (2026-05-09 #5/#8/#10) で個人法人 + 住所構造化 */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">請求先情報</h2>
        {tenant.billingContactName == null ? (
          <p className="rounded border bg-muted/30 p-4 text-sm text-muted-foreground">
            ℹ 請求先情報が未登録です (= 運営内部テナント、または旧データ)。請求業務には使用できません。
          </p>
        ) : (
          <dl className="grid grid-cols-1 gap-2 rounded border p-3 text-sm sm:grid-cols-2">
            {/* 2026-05-09 (PR C / #5): billingType 表示 + 個人プランは会社名行を出さない */}
            <BillingRow
              label="種別"
              value={tenant.billingType === 'individual' ? '個人' : '法人'}
            />
            {tenant.billingType !== 'individual' && tenant.billingCompanyName && (
              <BillingRow label="会社名 / 法人名" value={tenant.billingCompanyName} />
            )}
            <BillingRow
              label={tenant.billingType === 'individual' ? 'お名前' : '請求担当者'}
              value={tenant.billingContactName}
            />
            <BillingRow label="請求先メール" value={tenant.billingContactEmail} />
            <BillingRow label="電話番号" value={tenant.billingPhoneNumber ?? '(未設定)'} />
            <BillingRow label="支払い方法" value={paymentMethodLabel(tenant.paymentMethod)} />
            {/* 2026-05-09 (PR C / #8): 構造化住所優先、未設定時は legacy billingAddress フォールバック */}
            <BillingRow
              label="請求書送付先住所"
              value={formatBillingAddress(tenant)}
              fullWidth
            />
          </dl>
        )}
      </section>

      {tenant.scheduledPlanChangeAt && tenant.scheduledNextPlan && (
        <section className="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-900/30">
          <strong>プラン変更予約:</strong> {tenant.scheduledPlanChangeAt.toISOString().split('T')[0]}{' '}
          に {tenant.scheduledNextPlan} へ変更予定
        </section>
      )}

      {/* P-C (2026-05-08): データ代行エクスポート (顧客サポート用途) */}
      {tenant.id !== MANAGEMENT_TENANT_ID && (
        <section className="space-y-2 rounded border p-4">
          <h2 className="text-lg font-semibold">データ代行エクスポート</h2>
          <p className="text-sm text-muted-foreground">
            このテナントの全業務データを ZIP ファイルで取得します。顧客サポート (例:
            「自分でログインできない、データを送ってほしい」依頼) や監査用途で使用してください。
            実行は監査ログに記録されます。
          </p>
          <a
            href={`/api/admin/super/tenants/${tenant.id}/export`}
            className="inline-flex items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
            download
          >
            📦 データを ZIP でダウンロード (代行)
          </a>
        </section>
      )}

      {/* P-A (2026-05-08): テナント削除セクション (管理テナントは表示しない = 自爆防止 UI 強化) */}
      {tenant.id !== MANAGEMENT_TENANT_ID && (
        <section className="space-y-2 rounded border border-destructive/30 p-4">
          <h2 className="text-lg font-semibold text-destructive">危険な操作</h2>
          <p className="text-sm text-muted-foreground">
            テナントを論理削除し、配下のユーザのログイン・業務操作を遮断します。取り消しできません。
          </p>
          <div className="pt-2">
            <TenantDeleteButton tenantId={tenant.id} tenantName={tenant.name} />
          </div>
        </section>
      )}
    </div>
  );
}

function formatBytesSuper(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
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

/** P-G (2026-05-08): 請求先 1 行 */
function BillingRow({
  label,
  value,
  fullWidth = false,
}: {
  label: string;
  value: string | null;
  fullWidth?: boolean;
}) {
  return (
    <div className={fullWidth ? 'sm:col-span-2' : ''}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-line font-medium">{value ?? '(未設定)'}</dd>
    </div>
  );
}

/** P-G (2026-05-08): paymentMethod の人間可読ラベル変換 */
function paymentMethodLabel(method: string): string {
  switch (method) {
    case 'invoice':
      return '請求書送付';
    case 'bank_transfer':
      return '銀行振込';
    case 'credit_card':
      return 'クレジットカード';
    default:
      return method;
  }
}

/**
 * 2026-05-09 (PR C / #8): 構造化住所を 1 行に整形。
 *   構造化フィールドが揃っていれば優先、未設定なら legacy billing_address にフォールバック、
 *   どちらもなければ '(未設定)'。
 */
function formatBillingAddress(t: {
  billingPostalCode: string | null;
  billingPrefecture: string | null;
  billingCity: string | null;
  billingStreetAddress: string | null;
  billingBuildingName: string | null;
  billingAddress: string | null;
}): string | null {
  if (t.billingPostalCode || t.billingPrefecture || t.billingCity || t.billingStreetAddress) {
    const postal = t.billingPostalCode ? `〒${t.billingPostalCode} ` : '';
    const main = [t.billingPrefecture, t.billingCity, t.billingStreetAddress]
      .filter(Boolean)
      .join('');
    const building = t.billingBuildingName ? ` ${t.billingBuildingName}` : '';
    return `${postal}${main}${building}`;
  }
  return t.billingAddress;
}
