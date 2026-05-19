/**
 * /admin/super/diagnostics 診断ダッシュボード (PR-V8 / 2026-05-19)
 *
 * 役割:
 *   super_admin が「人間が想定していない事象が起きたときに何が起きているかを画面上で
 *   理解できる」ようにするための中核 UI。システム全体の健全性を 1 画面に集約表示。
 *
 *   表示セクション:
 *     1. 全体サマリ (異常件数バナー)
 *     2. API 利用量 drift テナント (counter vs ApiCallLog SUM)
 *     3. cron 健全性 (期待 vs 最終成功実行)
 *     4. 縮退モード突入テナント
 *     5. 直近メール送信失敗
 *     6. alert 機構の空打ち警告 (super_admin 通知の不達履歴)
 *
 *   各セクションには「個別診断」リンクや「修復する」ボタンが付き、対応操作にすぐ移れる。
 *
 * 認可: super_admin のみ。
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { getDiagnosticsSummary } from '@/services/diagnostics.service';
import { RepairDriftButton } from './repair-drift-button';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export default async function DiagnosticsPage() {
  const user = await getAuthenticatedUser();
  if (user instanceof Response || !user || !isSuperAdmin(user)) {
    notFound();
  }

  const summary = await getDiagnosticsSummary();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">診断ダッシュボード</h1>
        <span className="text-xs text-muted-foreground">
          検査時刻: {summary.measuredAt.toISOString()}
        </span>
      </div>

      <p className="text-sm text-muted-foreground">
        想定外の事象が起きたときに何が起きているかを 1 画面で把握するための運営者専用画面です。
        異常を検知した項目は赤枠で強調表示されます。修復可能な事象には「修復する」ボタンが付与されます。
      </p>

      {/* ============ 全体サマリ ============ */}
      <SummaryBanner totalAnomalies={summary.totalAnomalies} />

      {/* ============ 1. API 利用量 drift ============ */}
      <Section
        title="🚨 API 利用量 drift"
        description="Tenant.currentMonthApiCallCount (リアルタイム counter) と ApiCallLog SUM の乖離を検知。再集計や月初リセットの不整合、手動操作などで発生。"
        count={summary.driftedTenants.length}
        emptyMessage="✅ 異常なし — 全テナントで counter と ApiCallLog SUM は整合しています。"
      >
        {summary.driftedTenants.map((d) => (
          <div
            key={d.tenantId}
            className="rounded border border-red-300 bg-red-50 p-4 dark:border-red-700 dark:bg-red-900/20"
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="font-semibold">テナント {d.tenantId}</div>
              <div className="flex gap-2">
                <Link
                  href={`/admin/super/tenants/${d.tenantId}/diagnostics`}
                  className="rounded border px-3 py-1 text-xs hover:bg-background"
                >
                  詳細を見る
                </Link>
                <RepairDriftButton tenantId={d.tenantId} />
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <Stat label="counter (現在値)" value={d.cachedCallCount.toLocaleString()} />
              <Stat label="ApiCallLog SUM (真値)" value={d.reconciledCallCount.toLocaleString()} />
              <Stat
                label="呼出回数の差"
                value={`${d.driftCallCount >= 0 ? '+' : ''}${d.driftCallCount.toLocaleString()} 件`}
                emphasis
              />
              <Stat label="費用の差" value={`¥${d.driftCostJpy.toLocaleString()}`} />
              <Stat
                label="呼出 drift 比率"
                value={`${(d.driftCallRatio * 100).toFixed(1)}%`}
              />
              <Stat
                label="費用 drift 比率"
                value={`${(d.driftCostRatio * 100).toFixed(1)}%`}
              />
              <Stat
                label="月境界 (TZ ベース)"
                value={d.monthStart.toISOString().split('T')[0]}
              />
            </dl>
          </div>
        ))}
      </Section>

      {/* ============ 2. cron 健全性 ============ */}
      <Section
        title="🚨 cron 健全性"
        description="期待スケジュールに対し最後の成功実行から N 時間以上経過した cron を検知。cron-job.org への未登録 / 障害 / endpoint 誤りなどで発生。"
        count={summary.cronHealth.filter((c) => c.isUnhealthy).length}
        emptyMessage="✅ 異常なし — 全 cron が期待スケジュール内に成功実行されています。"
      >
        {summary.cronHealth
          .filter((c) => c.isUnhealthy)
          .map((c) => (
            <div
              key={c.cronName}
              className="rounded border border-red-300 bg-red-50 p-4 dark:border-red-700 dark:bg-red-900/20"
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-mono text-sm font-semibold">{c.cronName}</div>
                  <div className="text-xs text-muted-foreground">{c.metadata.description}</div>
                </div>
                <Link
                  href="/admin/super/cron-history"
                  className="rounded border px-3 py-1 text-xs hover:bg-background"
                >
                  cron 履歴を見る
                </Link>
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <Stat
                  label="状態"
                  value={c.status === 'never_recorded' ? '⚠️ 記録なし' : '⚠️ 長期停止'}
                  emphasis
                />
                <Stat label="期待スケジュール" value={c.metadata.schedule} />
                <Stat
                  label="期待最大ギャップ"
                  value={`${c.metadata.expectedMaxGapHours} 時間`}
                />
                <Stat
                  label="最後の成功"
                  value={
                    c.lastSuccessAt
                      ? `${c.lastSuccessAt.toISOString()} (${c.hoursSinceLastSuccess?.toFixed(1)}h 前)`
                      : '記録なし'
                  }
                />
              </dl>
            </div>
          ))}
        {/* healthy な cron も一覧で確認できるよう、折りたたみ表示 */}
        <details className="rounded border bg-muted/30 p-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            ✅ 健全な cron ({summary.cronHealth.filter((c) => !c.isUnhealthy).length} 件)
          </summary>
          <ul className="mt-2 space-y-1">
            {summary.cronHealth
              .filter((c) => !c.isUnhealthy)
              .map((c) => (
                <li key={c.cronName} className="font-mono text-xs">
                  {c.cronName} — {c.metadata.schedule} —{' '}
                  最終成功 {c.hoursSinceLastSuccess?.toFixed(1)}h 前
                </li>
              ))}
          </ul>
        </details>
      </Section>

      {/* ============ 3. 縮退モード突入テナント ============ */}
      <Section
        title="⚠️ 縮退モード突入テナント"
        description="API 呼出が停止状態になっているテナント。Beginner プランの上限到達 or 月額予算上限超過で発生。"
        count={summary.degradedTenants.length}
        emptyMessage="✅ 縮退モードに突入しているテナントはありません。"
      >
        {summary.degradedTenants.map((t) => (
          <div
            key={t.tenantId}
            className="rounded border border-orange-300 bg-orange-50 p-4 dark:border-orange-700 dark:bg-orange-900/20"
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="font-semibold">{t.tenantName}</div>
              <Link
                href={`/admin/super/tenants/${t.tenantId}/diagnostics`}
                className="rounded border px-3 py-1 text-xs hover:bg-background"
              >
                詳細を見る
              </Link>
            </div>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <Stat label="プラン" value={t.plan} />
              <Stat
                label="理由"
                value={
                  t.reason === 'beginner_limit_exceeded'
                    ? 'Beginner 上限到達'
                    : '月額予算超過'
                }
                emphasis
              />
              <Stat label="当月 API 呼出" value={t.currentMonthApiCallCount.toLocaleString()} />
              <Stat
                label={t.plan === 'beginner' ? '上限' : '予算上限'}
                value={
                  t.plan === 'beginner'
                    ? (t.beginnerMonthlyCallLimit?.toLocaleString() ?? '-')
                    : t.monthlyBudgetCapJpy != null
                      ? `¥${t.monthlyBudgetCapJpy.toLocaleString()}`
                      : '-'
                }
              />
            </dl>
          </div>
        ))}
      </Section>

      {/* ============ 4. ★請求重要★ Stripe Usage Record 送信滞留 / DLQ ============ */}
      <Section
        title="💸 Stripe Usage Record 送信滞留 / DLQ ★請求重要★"
        description="ApiCallLog → Stripe 送信キュー (StripeUsageRecordQueue) で 24h 以上送信遅延 / リトライ上限到達のレコード。Stripe 側の請求書に反映されない = 請求漏れに直結します。"
        count={summary.stripeUsageQueueIssues.reduce((s, i) => s + i.count, 0)}
        emptyMessage="✅ Stripe Usage Record の滞留 / DLQ はありません (= 全 ApiCallLog が Stripe に送信済 or 送信予定)。"
      >
        {summary.stripeUsageQueueIssues.map((issue) => (
          <div
            key={issue.category}
            className="rounded border border-red-400 bg-red-50 p-4 dark:border-red-600 dark:bg-red-900/30"
          >
            <div className="mb-2 flex items-center justify-between">
              <div>
                <div className="text-base font-semibold text-red-900 dark:text-red-100">
                  {issue.category === 'delayed' ? '⏳ 送信遅延 (24h+)' : '🪦 DLQ (リトライ上限到達)'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {issue.category === 'delayed'
                    ? 'cron 障害や Stripe API 障害が長時間続いている可能性。stripe-usage-flush cron の健全性確認 + 復旧後に再送信される'
                    : 'Stripe Subscription Item ID 誤り / 既存キャンセル等で恒久失敗。手動 retry (/admin/super/stripe-dlq) または Stripe Dashboard で直接記録追加が必要'}
                </div>
              </div>
              <div className="text-3xl font-bold text-red-700 dark:text-red-300">
                {issue.count.toLocaleString()}
              </div>
            </div>
            <div className="overflow-x-auto rounded border bg-white text-sm dark:bg-black/30">
              <table className="w-full">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left">tenantId</th>
                    <th className="px-3 py-2 text-left">callType</th>
                    <th className="px-3 py-2 text-left">occurredAt</th>
                    <th className="px-3 py-2 text-right">retry</th>
                    <th className="px-3 py-2 text-left">エラー</th>
                  </tr>
                </thead>
                <tbody>
                  {issue.samples.map((s) => (
                    <tr key={s.id} className="border-t">
                      <td className="px-3 py-1 font-mono text-xs">{s.tenantId}</td>
                      <td className="px-3 py-1">{s.callType}</td>
                      <td className="px-3 py-1 font-mono text-xs">
                        {s.occurredAt.toISOString()}
                      </td>
                      <td className="px-3 py-1 text-right">{s.retryCount}</td>
                      <td className="px-3 py-1 text-xs text-red-700 dark:text-red-300">
                        {s.lastError ?? '(エラーなし)'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {issue.count > issue.samples.length && (
              <div className="mt-2 text-xs text-muted-foreground">
                {issue.count - issue.samples.length} 件 さらに存在 (上位 {issue.samples.length} 件のみ表示)
                {issue.category === 'dlq' && (
                  <>
                    {' / '}
                    <Link href="/admin/super/stripe-dlq" className="underline">
                      Stripe DLQ 管理画面で全件確認 →
                    </Link>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </Section>

      {/* ============ 4.1 ★請求重要★ プラン変更予約の過去日付滞留 ============ */}
      <Section
        title="📅 プラン変更予約の過去日付滞留 ★請求重要★"
        description="scheduledPlanChangeAt が過去日付なのに反映されていないテナント。tenant-monthly-reset cron 失敗時の典型症状で、旧プランで課金継続 = 過剰/過少請求に直結します。"
        count={summary.stalledPlanChanges.length}
        emptyMessage="✅ プラン変更予約の滞留はありません。"
      >
        {summary.stalledPlanChanges.map((p) => (
          <div
            key={p.tenantId}
            className="rounded border border-red-300 bg-red-50 p-4 dark:border-red-700 dark:bg-red-900/20"
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="font-semibold">{p.tenantName}</div>
              <Link
                href={`/admin/super/tenants/${p.tenantId}/diagnostics`}
                className="rounded border px-3 py-1 text-xs hover:bg-background"
              >
                詳細を見る
              </Link>
            </div>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <Stat label="現在プラン" value={p.currentPlan} />
              <Stat label="予約プラン" value={p.scheduledNextPlan} emphasis />
              <Stat label="予約日時" value={p.scheduledAt.toISOString()} />
              <Stat
                label="経過時間"
                value={`${p.hoursSinceScheduled.toFixed(1)} 時間`}
                emphasis
              />
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">
              対応: tenant-monthly-reset cron を手動実行するか、tenants テーブルを直接更新してください。
            </p>
          </div>
        ))}
      </Section>

      {/* ============ 4.2 super_admin 数 ≤ 1 警告 ============ */}
      {summary.superAdminCountStatus.isAtRisk && (
        <Section
          title={`👤 super_admin user 数の警告 (現在: ${summary.superAdminCountStatus.count} 人)`}
          description="super_admin が 0 人 / 1 人だと alert 機構の単一障害点になります。退職 / lock / 端末紛失等で全 alert が無音化するため、冗長化必須。"
          count={1}
          emptyMessage=""
        >
          <div className="rounded border border-amber-400 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-900/20">
            <div className="font-semibold text-amber-900 dark:text-amber-100">
              ⚠️ {summary.superAdminCountStatus.warningMessage}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              対応: /admin/users から新規 super_admin user を追加してください。
            </p>
          </div>
        </Section>
      )}

      {/* ============ 5. メール送信失敗 (直近 24h) ============ */}
      <Section
        title="📧 メール送信失敗 (直近 24h)"
        description="プロバイダ拒否 / 上限超過 / 一時障害などで送信失敗したメール。請求書送付やパスワードリセット等の業務メールは特に注意。"
        count={summary.recentFailedEmails.length}
        emptyMessage="✅ 直近 24 時間で送信失敗はありません。"
      >
        {summary.recentFailedEmails.length > 0 && (
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-left">時刻</th>
                  <th className="px-3 py-2 text-left">種別</th>
                  <th className="px-3 py-2 text-left">ドメイン</th>
                  <th className="px-3 py-2 text-left">プロバイダ</th>
                  <th className="px-3 py-2 text-left">エラー</th>
                </tr>
              </thead>
              <tbody>
                {summary.recentFailedEmails.map((m) => (
                  <tr key={m.id} className="border-t">
                    <td className="px-3 py-2 font-mono text-xs">
                      {m.sentAt.toISOString()}
                    </td>
                    <td className="px-3 py-2">{m.type}</td>
                    <td className="px-3 py-2">{m.recipientDomain}</td>
                    <td className="px-3 py-2">{m.providerName}</td>
                    <td className="px-3 py-2 text-xs text-red-700 dark:text-red-300">
                      {m.errorMessage ?? '(message なし)'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ============ 5. alert 機構の空打ち警告 ============ */}
      <Section
        title="🔇 alert 機構の空打ち警告 (直近 7 日)"
        description="super_admin への通知メールが宛先 0 人で送信できなかった履歴。alert 機構自体が機能していない状態を意味するため、super_admin user を作成するか env SUPER_ADMIN_INITIAL_EMAIL を設定してください。"
        count={summary.alertNoRecipientWarnings.length}
        emptyMessage="✅ alert 機構の空打ち警告はありません (= 通知先が正常に解決できています)。"
      >
        {summary.alertNoRecipientWarnings.map((w, i) => (
          <div
            key={`${w.recordedAt.toISOString()}-${i}`}
            className="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-900/20"
          >
            <div className="font-mono text-xs text-muted-foreground">
              {w.recordedAt.toISOString()}
            </div>
            <div className="mt-1">{w.message}</div>
          </div>
        ))}
      </Section>
    </div>
  );
}

// ================================================================
// 内部コンポーネント
// ================================================================

function SummaryBanner({ totalAnomalies }: { totalAnomalies: number }) {
  if (totalAnomalies === 0) {
    return (
      <div className="rounded border border-green-300 bg-green-50 p-4 text-green-900 dark:border-green-700 dark:bg-green-900/20 dark:text-green-100">
        <div className="text-lg font-semibold">✅ 検知された異常はありません</div>
        <div className="mt-1 text-sm">
          API 利用量 drift / cron 健全性 / 縮退モード / メール失敗 / alert 機構の 5 観点すべて正常です。
        </div>
      </div>
    );
  }
  return (
    <div className="rounded border border-red-400 bg-red-50 p-4 text-red-900 dark:border-red-600 dark:bg-red-900/30 dark:text-red-100">
      <div className="text-lg font-semibold">⚠️ {totalAnomalies} 件の異常を検知</div>
      <div className="mt-1 text-sm">
        下記の各セクションで詳細を確認してください。修復可能な項目には「修復する」ボタンが付与されます。
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  count,
  emptyMessage,
  children,
}: {
  title: string;
  description: string;
  count: number;
  emptyMessage: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-lg font-bold">
          {title}{' '}
          <span className="text-sm text-muted-foreground">
            ({count} 件)
          </span>
        </h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {count === 0 ? (
        <div className="rounded border bg-muted/30 p-3 text-sm text-muted-foreground">
          {emptyMessage}
        </div>
      ) : (
        <div className="space-y-2">{children}</div>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={
          emphasis
            ? 'font-mono text-base font-semibold text-red-700 dark:text-red-300'
            : 'font-mono text-sm'
        }
      >
        {value}
      </dd>
    </div>
  );
}
