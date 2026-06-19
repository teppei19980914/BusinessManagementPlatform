/**
 * /admin/super/stripe-dlq (PR-V7 #6 / 2026-05-19)
 *
 * super_admin 向け Stripe DLQ (Dead Letter Queue) 監視ダッシュボード。
 *
 * 表示内容:
 *   1. サマリパネル: webhook 未処理 / webhook DLQ / usage 未送信 / usage DLQ の 4 件数
 *   2. Webhook DLQ + 未処理一覧 (retryCount 高順 → 受信時刻新しい順)
 *   3. Usage Record Queue DLQ + 未送信一覧 (retryCount 高順 → occurred 順)
 *
 * 認可: layout.tsx (super_admin guard) で担保。
 *
 * UI 設計:
 *   - server component で初期データ取得
 *   - 「再投入」ボタンは client component に分離し fetch で POST 呼出
 *   - 再投入成功時に router.refresh() で reload (= 一覧更新)
 */

import { getTranslations } from 'next-intl/server';
import { listWebhookDlq, listUsageQueueDlq } from '@/services/stripe-dlq.service';
import { StripeDlqRetryButton } from './retry-button';

const STRIPE_DASHBOARD_BASE = 'https://dashboard.stripe.com';

export default async function StripeDlqPage() {
  const t = await getTranslations('superAdmin');
  const [webhook, usage] = await Promise.all([listWebhookDlq(), listUsageQueueDlq()]);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Stripe DLQ (Dead Letter Queue)</h1>
      <p className="text-sm text-muted-foreground">
        {t('stripeDlqDescription1')}
        {t('stripeDlqDescription2')}
        {t('stripeDlqDescription3')}
      </p>

      {/* サマリ */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryCard label={t('stripeDlqWebhookUnprocessedLabel')} value={webhook.totalUnprocessed} />
        <SummaryCard
          label="Webhook DLQ"
          value={webhook.totalDlq}
          tone={webhook.totalDlq > 0 ? 'error' : 'success'}
        />
        <SummaryCard label={t('stripeDlqUsageUnsentLabel')} value={usage.totalPending} />
        <SummaryCard
          label="Usage DLQ"
          value={usage.totalDlq}
          tone={usage.totalDlq > 0 ? 'error' : 'success'}
        />
      </section>

      {/* Webhook 一覧 */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t('stripeDlqWebhookTitle')}</h2>
        {webhook.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('stripeDlqWebhookEmpty')}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="px-3 py-2 text-left">event.id</th>
                  <th className="px-3 py-2 text-left">type</th>
                  <th className="px-3 py-2 text-left">{t('stripeDlqColReceived')}</th>
                  <th className="px-3 py-2 text-left">retryCount</th>
                  <th className="px-3 py-2 text-left">nextRetryAt</th>
                  <th className="px-3 py-2 text-left">{t('stripeDlqColError')}</th>
                  <th className="px-3 py-2 text-left">{t('stripeDlqColActions')}</th>
                </tr>
              </thead>
              <tbody>
                {webhook.entries.map((e) => (
                  <tr
                    key={e.id}
                    className={`border-t ${e.isDlq ? 'bg-destructive/5' : ''}`}
                  >
                    <td className="px-3 py-2 font-mono text-xs">
                      <a
                        href={`${STRIPE_DASHBOARD_BASE}/events/${e.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-info underline-offset-2 hover:underline"
                      >
                        {e.id}
                      </a>
                    </td>
                    <td className="px-3 py-2 text-xs">{e.type}</td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">{formatDateTime(e.receivedAt)}</td>
                    <td className="px-3 py-2 text-xs">
                      {e.retryCount}{e.isDlq && <span className="ml-1 text-destructive">DLQ</span>}
                    </td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">
                      {e.nextRetryAt ? formatDateTime(e.nextRetryAt) : '—'}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {e.errorMessage && (
                        <details>
                          <summary className="cursor-pointer text-destructive">{t('stripeDlqErrorSummary')}</summary>
                          <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-muted p-2 text-[11px]">
                            {e.errorMessage}
                          </pre>
                        </details>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <StripeDlqRetryButton
                        kind="webhook"
                        id={e.id}
                        label={e.isDlq ? t('stripeDlqReplayLabel') : t('stripeDlqRetryResetLabel')}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Usage Queue 一覧 */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t('stripeDlqUsageTitle')}</h2>
        {usage.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('stripeDlqUsageEmpty')}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="px-3 py-2 text-left">id</th>
                  <th className="px-3 py-2 text-left">tenantId</th>
                  <th className="px-3 py-2 text-left">type</th>
                  <th className="px-3 py-2 text-left">qty</th>
                  <th className="px-3 py-2 text-left">occurred</th>
                  <th className="px-3 py-2 text-left">retryCount</th>
                  <th className="px-3 py-2 text-left">nextSendAt</th>
                  <th className="px-3 py-2 text-left">{t('stripeDlqColError')}</th>
                  <th className="px-3 py-2 text-left">{t('stripeDlqColActions')}</th>
                </tr>
              </thead>
              <tbody>
                {usage.entries.map((u) => (
                  <tr
                    key={u.id}
                    className={`border-t ${u.isDlq ? 'bg-destructive/5' : ''}`}
                  >
                    <td className="px-3 py-2 font-mono text-xs">{u.id.slice(0, 8)}…</td>
                    <td className="px-3 py-2 font-mono text-xs">{u.tenantId.slice(0, 8)}…</td>
                    <td className="px-3 py-2 text-xs">{u.callType}</td>
                    <td className="px-3 py-2 text-xs">{u.quantity}</td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">{formatDateTime(u.occurredAt)}</td>
                    <td className="px-3 py-2 text-xs">
                      {u.retryCount}{u.isDlq && <span className="ml-1 text-destructive">DLQ</span>}
                    </td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">
                      {u.nextSendAt ? formatDateTime(u.nextSendAt) : '—'}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {u.lastError && (
                        <details>
                          <summary className="cursor-pointer text-destructive">{t('stripeDlqErrorSummary')}</summary>
                          <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-muted p-2 text-[11px]">
                            {u.lastError}
                          </pre>
                        </details>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <StripeDlqRetryButton
                        kind="usage"
                        id={u.id}
                        label={u.isDlq ? t('stripeDlqReplayLabel') : t('stripeDlqRetryResetLabel')}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'success' | 'error' | 'neutral';
}) {
  const toneClass
    = tone === 'success'
      ? 'border-success/30 bg-success/5'
      : tone === 'error'
        ? 'border-destructive/30 bg-destructive/5'
        : 'border-input';
  return (
    <div className={`rounded-md border p-3 ${toneClass}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function formatDateTime(d: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}
