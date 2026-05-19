/**
 * /admin/super/email-failures (PR-V7a / 2026-05-19)
 *
 * super_admin 向け「メール送付失敗 alert」詳細画面。
 * 直近 24 時間 (デフォルト) で success=false な EmailSendLog を一覧表示する。
 *
 * 用途:
 *   1. 請求書送付 (invoice テナント) の到達失敗を即時検知
 *   2. 招待 / パスワードリセット / 警告通知 の到達失敗を検知
 *   3. 1 件の失敗が大量発生する場合 (= プロバイダ障害) を可視化
 *
 * 認可: layout.tsx (super_admin guard) + middleware Basic Auth (= PR-V7 #7) で多層防御済。
 *
 * 関連:
 *   - サービス: src/services/email-send-log.service.ts getRecentFailedEmails
 *   - top dashboard カード: src/app/(dashboard)/admin/super/page.tsx EmailSendMonitorCard
 *   - PII 保護: recipient はハッシュ化済 (= ドメイン部のみ表示)
 */

import Link from 'next/link';
import { getRecentFailedEmails } from '@/services/email-send-log.service';

const DEFAULT_HOURS_BACK = 24;
const DEFAULT_LIMIT = 100;

export default async function EmailFailuresPage({
  searchParams,
}: {
  searchParams: Promise<{ hours?: string; limit?: string }>;
}) {
  const sp = await searchParams;
  const hoursBack = clampInt(sp.hours, DEFAULT_HOURS_BACK, 1, 168);
  const limit = clampInt(sp.limit, DEFAULT_LIMIT, 10, 500);
  const rows = await getRecentFailedEmails(hoursBack, limit);

  // type 別の集計 (= プロバイダ全体障害 vs 個別 type の失敗を区別)
  const byType = new Map<string, number>();
  for (const r of rows) {
    byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
  }

  return (
    <div className="space-y-4">
      <nav className="text-sm">
        <Link href="/admin/super" className="text-info hover:underline">
          ← サマリへ戻る
        </Link>
      </nav>

      <h1 className="text-xl font-semibold">
        メール送付失敗一覧 (直近 {hoursBack} 時間)
      </h1>

      <p className="text-sm text-muted-foreground">
        PII 保護のため、宛先メールアドレスは SHA-256 ハッシュ化済でドメイン部のみ表示。
        詳細な宛先確認は <code className="rounded bg-muted px-1">email_send_logs</code>
        テーブルへの直接クエリ + テナント情報 (tenant_id) の突合で実施してください。
      </p>

      <div className="rounded-md border bg-muted/30 p-3 text-sm">
        合計: <strong>{rows.length} 件</strong>
        {byType.size > 0 && (
          <span className="ml-3 text-xs">
            (type 別:{' '}
            {Array.from(byType.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([t, c]) => `${t} ${c}`)
              .join(' / ')}
            )
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          直近 {hoursBack} 時間で送付失敗したメールはありません。
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-3 py-2 text-left">送信日時 (JST)</th>
                <th className="px-3 py-2 text-left">テナント</th>
                <th className="px-3 py-2 text-left">種別</th>
                <th className="px-3 py-2 text-left">宛先ドメイン</th>
                <th className="px-3 py-2 text-left">プロバイダ</th>
                <th className="px-3 py-2 text-left">エラー</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t bg-destructive/5">
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {formatDateTime(r.sentAt)}
                  </td>
                  <td className="px-3 py-2 text-xs font-mono">
                    {r.tenantId ?? <span className="text-muted-foreground">(システム)</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">{r.type}</td>
                  <td className="px-3 py-2 text-xs font-mono">{r.recipientDomain}</td>
                  <td className="px-3 py-2 text-xs">{r.providerName}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.errorMessage ? (
                      <code className="text-destructive">{r.errorMessage}</code>
                    ) : (
                      <span className="text-muted-foreground">(エラーメッセージなし)</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <details className="rounded border p-3 text-xs">
        <summary className="cursor-pointer font-medium">フィルタオプション</summary>
        <form method="get" className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span>過去 N 時間 (1〜168)</span>
            <input
              type="number"
              name="hours"
              min={1}
              max={168}
              defaultValue={hoursBack}
              className="rounded border bg-background px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>表示上限 (10〜500)</span>
            <input
              type="number"
              name="limit"
              min={10}
              max={500}
              defaultValue={limit}
              className="rounded border bg-background px-2 py-1"
            />
          </label>
          <button
            type="submit"
            className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
          >
            適用
          </button>
        </form>
      </details>
    </div>
  );
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function formatDateTime(d: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(d);
}
