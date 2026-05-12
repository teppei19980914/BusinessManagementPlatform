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
import { MANAGEMENT_TENANT_ID, DEFAULT_TENANT_ID } from '@/lib/tenant';
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
  // 2026-05-11: Default テナント (= 運営者自身) は請求対象外。費用表示にラベル併記する
  const isDefaultTenant = tenant.id === DEFAULT_TENANT_ID;
  const nonBillableSuffix = isDefaultTenant ? ' (請求対象外)' : '';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">
          {tenant.name}
          {isDefaultTenant && (
            <span className="ml-2 rounded bg-info/20 px-2 py-0.5 align-middle text-xs font-medium text-info">
              運営者自身 / 請求対象外
            </span>
          )}
        </h1>
        <p className="text-sm text-muted-foreground">
          tenantSeq: {tenant.tenantSeq ?? '-'} / slug: {tenant.slug} / 作成日:{' '}
          {tenant.createdAt.toISOString().split('T')[0]}
        </p>
        {isDefaultTenant && (
          <p className="mt-2 rounded border border-info/30 bg-info/5 p-2 text-xs text-info">
            このテナントは運営者自身のテナント (Default) です。費用集計は内部記録値であり、
            実際の請求は発生しません。顧客テナントの請求書合計には含まれません。
          </p>
        )}
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
        {/* 2026-05-09 (PR E): 全 DetailCard にツールチップ */}
        <DetailCard
          label="プラン"
          value={tenant.plan}
          tooltip="現在の契約プラン (beginner / expert / pro)。プラン変更はテナント管理者が /settings/tenant で実施"
        />
        <DetailCard
          label="アクティブユーザ数"
          value={tenant.activeUserCount.toString()}
          tooltip="isActive=true かつ deletedAt=null のユーザ数。Beginner プランは 5 席上限"
        />
        <DetailCard
          label="最終ログイン (テナント内)"
          value={
            tenant.lastUserLoginAt
              ? `${tenant.lastUserLoginAt.toISOString().split('T')[0]} (${daysSinceLastActivity} 日前)`
              : '未ログイン'
          }
          highlight={isDormant}
          tooltip="テナント内のいずれかのユーザの最新 lastLoginAt。90 日以上経過で「休眠テナント」候補"
        />
        <DetailCard
          label="今月 API 呼出"
          value={tenant.currentMonthApiCallCount.toLocaleString()}
          tooltip="当月の LLM/Embedding 呼出回数 (withMeteredLLM 経由)。月初 (UTC) にリセット"
        />
        <DetailCard
          label={`今月 API 費用${nonBillableSuffix}`}
          value={`¥${tenant.currentMonthApiCostJpy.toLocaleString()}`}
          tooltip={
            isDefaultTenant
              ? '内部記録値。Default テナントは請求対象外のため実際の請求は発生しません'
              : '当月の内部請求額 (プラン別固定単価)。Anthropic 実コストとは別系統'
          }
        />
        <DetailCard
          label="月次予算上限"
          value={tenant.monthlyBudgetCapJpy != null ? `¥${tenant.monthlyBudgetCapJpy.toLocaleString()}` : '無制限'}
          tooltip="テナント管理者が設定した月次予算 (円)。超過時は LLM 呼び出しがブロックされる"
        />
        <DetailCard
          label="Beginner 月間呼出上限"
          value={tenant.beginnerMonthlyCallLimit.toString()}
          tooltip="Beginner プラン時の月間 API 呼出上限 (default 100)。Expert/Pro では適用されない"
        />
      </section>

      <section className="space-y-2" title="テナント所属の業務データ件数 (deletedAt=null のものを集計)">
        <h2 className="text-lg font-semibold">エンティティ数</h2>
        <ul className="rounded border p-3 text-sm">
          <EntityRow
            label="プロジェクト"
            count={tenant.entityCounts.projects}
            tooltip="テナント内の active プロジェクト数 (削除済みを除く)。is_sample_data=true のシードは除外済"
          />
          <EntityRow
            label="ナレッジ"
            count={tenant.entityCounts.knowledges}
            tooltip="ナレッジ件数。複数プロジェクトで共有されるため Project と件数は独立"
          />
          <EntityRow
            label="リスク/課題"
            count={tenant.entityCounts.risksIssues}
            tooltip="type='risk' (リスク) と 'issue' (課題) の合計"
          />
          <EntityRow
            label="振り返り"
            count={tenant.entityCounts.retrospectives}
            tooltip="プロジェクト振り返り (Retrospective) 件数。各プロジェクトに 1 件以上"
          />
          <EntityRow
            label="メモ"
            count={tenant.entityCounts.memos}
            tooltip="個人メモ件数。private/public visibility で公開範囲を制御"
          />
        </ul>
      </section>

      {/* Storage add-on (Phase 2 / 2026-05-08): 容量 + 課金統合表示 */}
      <section className="space-y-2" title="Storage add-on プラン (Phase 2 / 2026-05-08) と容量・月次課金の統合表示">
        <h2 className="text-lg font-semibold">ストレージ + 月次課金</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <DetailCard
            label="ストレージプラン"
            value={`${tenant.storageAddonPlan} (+¥${tenant.storageAddonMonthlyJpy.toLocaleString()}/月)`}
            tooltip="standard (LLM プラン連動 50/150/300MB) / plus (+200MB ¥500) / pro_storage (+1GB ¥1500)"
          />
          <DetailCard
            label="使用量 / 上限"
            value={`${formatBytesSuper(tenant.storageBytesUsed)} / ${formatBytesSuper(tenant.storageLimitBytes)} (${Math.round(tenant.storageUsageRatio * 100)}%)`}
            highlight={tenant.storageUsageRatio > 1.0}
            tooltip="添付ファイル合算サイズ。100% 超で Grace period (7 日)、未対応で write 停止"
          />
          <DetailCard
            label={`当月予想合計課金${nonBillableSuffix}`}
            value={`¥${tenant.totalCurrentMonthJpy.toLocaleString()} (LLM ¥${tenant.currentMonthApiCostJpy.toLocaleString()} + Storage ¥${tenant.storageAddonMonthlyJpy.toLocaleString()})`}
            tooltip={
              isDefaultTenant
                ? '内部記録値。Default テナントは請求対象外のため顧客請求書合計には含まれません'
                : 'LLM 部分 (従量課金) + Storage add-on (固定月額) の合算。請求書根拠'
            }
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
  tooltip,
}: {
  label: string;
  value: string;
  /** P-6: 休眠警告などで強調表示したい場合 true */
  highlight?: boolean;
  // 2026-05-09 (PR E): 全カードにツールチップ
  tooltip?: string;
}) {
  return (
    <div
      className={`rounded border p-4 ${highlight ? 'border-destructive/30 bg-destructive/5' : ''}${tooltip ? ' cursor-help' : ''}`}
      title={tooltip}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-xl font-bold ${highlight ? 'text-destructive' : ''}`}>{value}</p>
    </div>
  );
}

function EntityRow({
  label,
  count,
  tooltip,
}: {
  label: string;
  count: number;
  tooltip?: string;
}) {
  return (
    <li
      className={`flex justify-between border-b py-1 last:border-b-0${tooltip ? ' cursor-help' : ''}`}
      title={tooltip}
    >
      <span>{label}</span>
      <span className="font-mono">{count.toLocaleString()}</span>
    </li>
  );
}

/** P-G (2026-05-08): 請求先 1 行 (2026-05-09 PR E でツールチップ追加) */
function BillingRow({
  label,
  value,
  fullWidth = false,
  tooltip,
}: {
  label: string;
  value: string | null;
  fullWidth?: boolean;
  tooltip?: string;
}) {
  return (
    <div className={fullWidth ? 'sm:col-span-2' : ''} title={tooltip}>
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
