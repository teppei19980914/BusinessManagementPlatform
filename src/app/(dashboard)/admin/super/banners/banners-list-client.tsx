'use client';

/**
 * 周知バナー一覧 (履歴) のクライアント部 (ADR-0036)。
 *
 * 一覧表示 + 行ごとの操作 (編集 / 複製 / 取り下げ・再開 / 削除) を提供する。
 * 操作は admin API を fetch し、成功したら router.refresh() でサーバ再取得する。
 *
 * 注: service からは **型のみ** import する (値 import は prisma を client bundle に混入させる
 *   [[feedback_client_service_boundary]])。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MarkdownDisplay } from '@/components/ui/markdown-textarea';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';
import { BANNER_SEVERITY_LABELS } from '@/lib/validators/system-banner';
import type { SystemBannerDTO } from '@/services/system-banner.service';

function formatJst(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type StatusInfo = { label: string; className: string };

function statusOf(b: SystemBannerDTO): StatusInfo {
  if (!b.enabled) return { label: '停止', className: 'bg-muted text-muted-foreground' };
  const now = Date.now();
  const start = new Date(b.startAt).getTime();
  const end = new Date(b.endAt).getTime();
  if (now < start) return { label: '予約', className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200' };
  if (now >= end) return { label: '終了', className: 'bg-muted text-muted-foreground' };
  return { label: '表示中', className: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200' };
}

const SEVERITY_TEXT_CLASS: Record<string, string> = {
  high: 'text-red-700 dark:text-red-300',
  medium: 'text-yellow-700 dark:text-yellow-300',
  low: 'text-blue-700 dark:text-blue-300',
};

export function BannersListClient({ banners }: { banners: SystemBannerDTO[] }) {
  const router = useRouter();
  const { withLoading } = useLoading();
  const { showSuccessKey, showErrorKey } = useToast();

  async function runAction(
    method: 'PATCH' | 'DELETE',
    id: string,
    body: Record<string, unknown> | undefined,
    successKey: string,
  ) {
    const res = await withLoading(() =>
      fetch(`/api/admin/super/banners/${id}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = json?.error?.code as string | undefined;
      if (code === 'OVERLAP') showErrorKey('superAdmin.bannerOverlapErrorShort');
      else showErrorKey('superAdmin.bannerOperationFailedDefault');
      return;
    }
    showSuccessKey(successKey);
    router.refresh();
  }

  function handleSuspend(id: string) {
    void runAction('PATCH', id, { enabled: false }, 'superAdmin.toastBannerTakedown');
  }

  function handleResume(id: string) {
    void runAction('PATCH', id, { enabled: true }, 'superAdmin.toastBannerReactivate');
  }

  function handleDelete(id: string) {
    if (!window.confirm('このバナーを履歴ごと完全に削除します。よろしいですか？')) return;
    void runAction('DELETE', id, undefined, 'superAdmin.toastBannerDelete');
  }

  if (banners.length === 0) {
    return (
      <p className="rounded border p-8 text-center text-muted-foreground">
        周知バナーはまだありません。「+ 新規バナー」から作成してください。
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="p-2">状態</th>
            <th className="p-2">緊急度</th>
            <th className="p-2">メッセージ</th>
            <th className="p-2">表示期間 (JST)</th>
            <th className="p-2 text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          {banners.map((b) => {
            const status = statusOf(b);
            return (
              <tr key={b.id} className="border-b align-top hover:bg-muted/30">
                <td className="p-2">
                  <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${status.className}`}>
                    {status.label}
                  </span>
                </td>
                <td className={`p-2 font-medium ${SEVERITY_TEXT_CLASS[b.severity] ?? ''}`}>
                  {BANNER_SEVERITY_LABELS[b.severity]}
                </td>
                <td className="max-w-md p-2">
                  <div className="line-clamp-2 overflow-hidden">
                    <MarkdownDisplay value={b.message} />
                  </div>
                </td>
                <td className="p-2 whitespace-nowrap text-xs">
                  {formatJst(b.startAt)}
                  <br />〜 {formatJst(b.endAt)}
                </td>
                <td className="p-2 text-right">
                  <div className="flex flex-wrap justify-end gap-2">
                    <Link
                      href={`/admin/super/banners/${b.id}/edit`}
                      className="rounded border px-2 py-1 text-xs hover:bg-muted"
                    >
                      編集
                    </Link>
                    <Link
                      href={`/admin/super/banners/new?from=${b.id}`}
                      className="rounded border px-2 py-1 text-xs hover:bg-muted"
                    >
                      複製
                    </Link>
                    {b.enabled ? (
                      <button
                        type="button"
                        onClick={() => handleSuspend(b.id)}
                        className="rounded border px-2 py-1 text-xs hover:bg-muted"
                      >
                        取り下げ
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleResume(b.id)}
                        className="rounded border px-2 py-1 text-xs hover:bg-muted"
                      >
                        再開
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleDelete(b.id)}
                      className="rounded border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                    >
                      削除
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
