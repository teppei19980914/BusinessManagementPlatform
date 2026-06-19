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
import { useTranslations } from 'next-intl';
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

type StatusInfo = { labelKey: 'bannerStatusStopped' | 'bannerStatusScheduled' | 'bannerStatusEnded' | 'bannerStatusActive'; className: string };

function statusOf(b: SystemBannerDTO): StatusInfo {
  if (!b.enabled) return { labelKey: 'bannerStatusStopped', className: 'bg-muted text-muted-foreground' };
  const now = Date.now();
  const start = new Date(b.startAt).getTime();
  const end = new Date(b.endAt).getTime();
  if (now < start) return { labelKey: 'bannerStatusScheduled', className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200' };
  if (now >= end) return { labelKey: 'bannerStatusEnded', className: 'bg-muted text-muted-foreground' };
  return { labelKey: 'bannerStatusActive', className: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200' };
}

const SEVERITY_TEXT_CLASS: Record<string, string> = {
  high: 'text-red-700 dark:text-red-300',
  medium: 'text-yellow-700 dark:text-yellow-300',
  low: 'text-blue-700 dark:text-blue-300',
};

export function BannersListClient({ banners }: { banners: SystemBannerDTO[] }) {
  const router = useRouter();
  const t = useTranslations('superAdmin');
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();

  async function runAction(
    method: 'PATCH' | 'DELETE',
    id: string,
    body: Record<string, unknown> | undefined,
    successMsg: string,
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
      const message = json?.error?.message as string | undefined;
      if (code === 'OVERLAP') showError(message ?? t('bannerOverlapErrorShort'));
      else showError(message ?? t('bannerOperationFailedDefault'));
      return;
    }
    showSuccess(successMsg);
    router.refresh();
  }

  function handleSuspend(id: string) {
    void runAction('PATCH', id, { enabled: false }, t('toastBannerTakedown'));
  }

  function handleResume(id: string) {
    void runAction('PATCH', id, { enabled: true }, t('toastBannerReactivate'));
  }

  function handleDelete(id: string) {
    if (!window.confirm(t('bannerDeleteConfirm'))) return;
    void runAction('DELETE', id, undefined, t('toastBannerDelete'));
  }

  if (banners.length === 0) {
    return (
      <p className="rounded border p-8 text-center text-muted-foreground">
        {t('bannersListEmpty')}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="p-2">{t('bannersColStatus')}</th>
            <th className="p-2">{t('bannersColSeverity')}</th>
            <th className="p-2">{t('bannersColMessage')}</th>
            <th className="p-2">{t('bannersColPeriod')}</th>
            <th className="p-2 text-right">{t('bannersColActions')}</th>
          </tr>
        </thead>
        <tbody>
          {banners.map((b) => {
            const status = statusOf(b);
            return (
              <tr key={b.id} className="border-b align-top hover:bg-muted/30">
                <td className="p-2">
                  <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${status.className}`}>
                    {t(status.labelKey)}
                  </span>
                </td>
                <td className={`p-2 font-medium ${SEVERITY_TEXT_CLASS[b.severity] ?? ''}`}>
                  {BANNER_SEVERITY_LABELS[b.severity]}
                </td>
                <td className="max-w-md p-2">
                  <span className="line-clamp-2 whitespace-pre-wrap break-words">{b.message}</span>
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
                      {t('bannerActionEdit')}
                    </Link>
                    <Link
                      href={`/admin/super/banners/new?from=${b.id}`}
                      className="rounded border px-2 py-1 text-xs hover:bg-muted"
                    >
                      {t('bannerActionClone')}
                    </Link>
                    {b.enabled ? (
                      <button
                        type="button"
                        onClick={() => handleSuspend(b.id)}
                        className="rounded border px-2 py-1 text-xs hover:bg-muted"
                      >
                        {t('bannerActionTakedown')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleResume(b.id)}
                        className="rounded border px-2 py-1 text-xs hover:bg-muted"
                      >
                        {t('bannerActionReactivate')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleDelete(b.id)}
                      className="rounded border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                    >
                      {t('bannerActionDelete')}
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
