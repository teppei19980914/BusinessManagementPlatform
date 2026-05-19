/**
 * /admin/super/tenants/[id] (PR-X2 / 2026-05-07)
 *
 * テナント詳細画面。entity 数と当月使用量を表示。
 *
 * P-6 (2026-05-08): 最終ログイン日時 + 休眠日数を表示。休眠 (90 日以上) は警告色。
 */

import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import {
  getTenantDetail,
  DORMANT_TENANT_THRESHOLD_DAYS,
} from '@/services/super-admin.service';
import { MANAGEMENT_TENANT_ID, DEFAULT_TENANT_ID } from '@/lib/tenant';
import { TenantDeleteButton } from './tenant-delete-button';
import { TenantSuspendButton } from './tenant-suspend-button';
// 2026-05-14: テナント詳細遷移時に該当テナントの DB 容量 + API 利用量を即時再集計。
//   旧仕様 (cron 日次キャッシュ) はキャッシュ依存だったため、ここで明示的に最新化する。
import { updateStorageBytesUsedForTenant } from '@/services/tenant-storage.service';
import { reconcileTenantApiUsage } from '@/services/api-usage-recalc.service';
import { RecalculateButton } from '@/components/recalculate-button';
import { UsageDriftBadge } from '@/components/usage-drift-badge';

export default async function SuperAdminTenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // 2026-05-14: getTenantDetail でキャッシュ値を SELECT する前に最新値で書き戻す。
  //   テナント不在 (= deletedAt 立ち / 改ざん) は updateStorageBytesUsedForTenant が
  //   null を返し、後続の getTenantDetail も null を返して notFound() に到達する。
  //   失敗時はキャッシュ値表示にフォールバック (= 既存挙動を維持)。
  await Promise.allSettled([
    updateStorageBytesUsedForTenant(id),
  ]);
  const [tenant, apiReconcile] = await Promise.all([
    getTenantDetail(id),
    reconcileTenantApiUsage(id).catch(() => null),
  ]);
  if (!tenant) notFound();

  // P-6: 休眠状態は service 側で計算済 (render 中の Date.now() を回避)
  const { daysSinceLastActivity, isDormant } = tenant;
  // 2026-05-11: Default テナント (= 運営者自身) は請求対象外。費用表示にラベル併記する
  const isDefaultTenant = tenant.id === DEFAULT_TENANT_ID;
  const nonBillableSuffix = isDefaultTenant ? ' (請求対象外)' : '';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
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
        </div>
        {/* 2026-05-14: テナント単体の DB 容量 + API 利用量を即時再集計 */}
        <RecalculateButton
          endpoint={`/api/admin/super/tenants/${tenant.id}/recalculate`}
          label="このテナントを再集計"
          size="default"
        />
      </div>
      {isDefaultTenant && (
        <p className="rounded border border-info/30 bg-info/5 p-2 text-xs text-info">
          このテナントは運営者自身のテナント (Default) です。費用集計は内部記録値であり、
          実際の請求は発生しません。顧客テナントの請求書合計には含まれません。
        </p>
      )}

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
        {/* ★ PR-V8.1 (2026-05-19) 請求 invariant: ApiCallLog SUM (真値) を表示。
            テナント管理者画面 + システム管理者画面で同じ SUM 値を共有し、表示乖離を防ぐ。
            counter 値はテナント詳細画面 (本画面) のみ参考表示。 */}
        <DetailCard
          label={
            <span>
              今月 API 呼出
              <UsageDriftBadge reconcile={apiReconcile} showDiagnosticsLink={true} />
            </span>
          }
          value={(
            apiReconcile?.reconciledCallCount ?? tenant.currentMonthApiCallCount
          ).toLocaleString()}
          tooltip="当月の LLM/Embedding 呼出回数 (ApiCallLog 集計 = 請求書根拠と同じ真値、PR-V8.1)"
        />
        <DetailCard
          label={`今月 API 費用${nonBillableSuffix}`}
          value={`¥${(
            apiReconcile?.reconciledCostJpy ?? tenant.currentMonthApiCostJpy
          ).toLocaleString()}`}
          tooltip={
            isDefaultTenant
              ? 'ApiCallLog 集計値。Default テナントは請求対象外のため実際の請求は発生しません (PR-V8.1)'
              : 'ApiCallLog 集計値 = 請求書根拠と同じ真値。プラン別固定単価で計算 (PR-V8.1)'
          }
        />
        {/* 2026-05-14: drift 検出時の詳細情報 (整合性検証) */}
        {apiReconcile?.hasDrift && (
          <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs dark:bg-amber-900/30 sm:col-span-2 lg:col-span-3">
            <p className="font-semibold text-amber-900 dark:text-amber-200">
              ⚠ API 利用量の整合性 drift を検出 ({(apiReconcile.driftRatio * 100).toFixed(1)}%)
            </p>
            <p className="mt-1 text-muted-foreground">
              Tenant counter: <strong>¥{apiReconcile.cachedCostJpy.toLocaleString()}</strong> ({apiReconcile.cachedCallCount.toLocaleString()} 回)
              {' / '}
              ApiCallLog SUM: <strong>¥{apiReconcile.reconciledCostJpy.toLocaleString()}</strong> ({apiReconcile.reconciledCallCount.toLocaleString()} 回)
              {' / '}
              差分: <strong>{apiReconcile.driftCostJpy >= 0 ? '+' : ''}¥{apiReconcile.driftCostJpy.toLocaleString()}</strong>
            </p>
          </div>
        )}
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
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">ストレージ + 月次課金</h2>
          {/* 2026-05-14: ストレージ単体の再集計 (= 同 endpoint だが UX 上明示) */}
          <RecalculateButton
            endpoint={`/api/admin/super/tenants/${tenant.id}/recalculate`}
            label="ストレージを再集計"
          />
        </div>
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
          {/* ★ PR-V8.1 (2026-05-19) 請求 invariant: LLM 部分は ApiCallLog SUM (真値) を使う。
              同画面の「今月 API 費用」(line 130-134) と一致させ、合算式も整合させる。 */}
          <DetailCard
            label={`当月予想合計課金${nonBillableSuffix}`}
            value={(() => {
              const llmCost = apiReconcile?.reconciledCostJpy ?? tenant.currentMonthApiCostJpy;
              const total = llmCost + tenant.storageAddonMonthlyJpy;
              return `¥${total.toLocaleString()} (LLM ¥${llmCost.toLocaleString()} + Storage ¥${tenant.storageAddonMonthlyJpy.toLocaleString()})`;
            })()}
            tooltip={
              isDefaultTenant
                ? 'ApiCallLog 集計値。Default テナントは請求対象外のため顧客請求書合計には含まれません (PR-V8.1)'
                : 'ApiCallLog SUM (真値) + Storage add-on (固定月額) の合算 = 請求書根拠と完全一致 (PR-V8.1)'
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

      {/* PR #372 (2026-05-14): read-only 強制移行セクション (管理テナントは表示しない) */}
      {tenant.id !== MANAGEMENT_TENANT_ID && (
        <section className="space-y-2 rounded border border-amber-500/40 p-4">
          <h2 className="text-lg font-semibold text-amber-700 dark:text-amber-300">
            read-only 強制移行 (停止 / 再開)
          </h2>
          <p className="text-sm text-muted-foreground">
            支払い滞納 / 利用規約違反等で write 系操作を遮断します。停止中も閲覧・エクスポート・
            プラン変更・セルフ解約は引き続き可能。削除より軽い措置として運用してください。
          </p>
          <div className="pt-2">
            <TenantSuspendButton
              tenantId={tenant.id}
              tenantName={tenant.name}
              suspendedAt={tenant.suspendedAt?.toISOString() ?? null}
              suspendReason={tenant.suspendReason}
            />
          </div>
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
  // 2026-05-14: ReactNode 許容 (drift badge を label に併記するため)
  label: ReactNode;
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
// 2026-05-15: 'bank_transfer' は廃止し 'invoice' に統合 (UI ラベル「銀行振込」)。
//   既存 DB の旧 'bank_transfer' 値も「銀行振込」と表示するため case を残す。
function paymentMethodLabel(method: string): string {
  switch (method) {
    case 'invoice':
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
