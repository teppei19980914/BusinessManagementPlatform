'use client';

/**
 * 周知バナーの作成 / 編集フォーム (ADR-0036)。new (複製含む) と edit で共用する。
 *
 * 日時は datetime-local (ブラウザのローカル時刻 = 運用上 JST) で入力し、送信時に toISOString して
 * timestamptz として保存する。tenant-create-form.tsx の fetch + useLoading + useToast パターンを踏襲。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import {
  BANNER_SEVERITIES,
  BANNER_SEVERITY_LABELS,
  type BannerSeverity,
} from '@/lib/validators/system-banner';

export type BannerFormInitial = {
  message: string;
  severity: BannerSeverity;
  /** ISO 文字列 (edit/複製の prefill 用)。未指定なら空。 */
  startAt?: string;
  endAt?: string;
  enabled: boolean;
};

function isoToLocalInput(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function BannerForm({
  mode,
  bannerId,
  initial,
}: {
  mode: 'create' | 'edit';
  bannerId?: string;
  initial?: BannerFormInitial;
}) {
  const router = useRouter();
  const t = useTranslations('superAdmin');
  const { withLoading } = useLoading();
  const { showSuccessKey, showErrorKey } = useToast();

  const [message, setMessage] = useState(initial?.message ?? '');
  const [severity, setSeverity] = useState<BannerSeverity>(initial?.severity ?? 'medium');
  const [startAt, setStartAt] = useState(isoToLocalInput(initial?.startAt));
  const [endAt, setEndAt] = useState(isoToLocalInput(initial?.endAt));
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!startAt || !endAt) {
      setError(t('bannerDateRangeRequired'));
      return;
    }
    const startIso = new Date(startAt).toISOString();
    const endIso = new Date(endAt).toISOString();
    if (new Date(startIso) >= new Date(endIso)) {
      setError(t('bannerEndAfterStart'));
      return;
    }

    const payload = { message, severity, startAt: startIso, endAt: endIso, enabled };
    const url = mode === 'create' ? '/api/admin/super/banners' : `/api/admin/super/banners/${bannerId}`;
    const httpMethod = mode === 'create' ? 'POST' : 'PATCH';

    const res = await withLoading(() =>
      fetch(url, {
        method: httpMethod,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = json?.error?.code as string | undefined;
      const apiMessage = json?.error?.message as string | undefined;
      if (code === 'OVERLAP') {
        setError(apiMessage ?? t('bannerOverlapError'));
      } else if (code === 'VALIDATION_ERROR' || code === 'INVALID_PERIOD') {
        setError(apiMessage ?? t('bannerInvalidInput'));
      } else {
        setError(apiMessage ?? t('bannerSaveFailedDefault'));
      }
      showErrorKey('superAdmin.toastBannerSaveFailed');
      return;
    }

    showSuccessKey(mode === 'create' ? 'superAdmin.toastBannerCreateSuccess' : 'superAdmin.toastBannerUpdateSuccess');
    router.push('/admin/super/banners');
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      <div className="space-y-2">
        <Label htmlFor="message">{t('bannerMessageLabel')}</Label>
        <textarea
          id="message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={500}
          rows={3}
          required
          className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder={t('bannerMessagePlaceholder')}
        />
        <p className="text-xs text-muted-foreground">{t('bannerMessageCounter', { count: message.length })}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="severity">{t('bannerSeverityLabel')}</Label>
        <select
          id="severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value as BannerSeverity)}
          className={nativeSelectClass}
        >
          {BANNER_SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {BANNER_SEVERITY_LABELS[s]}
              {s === 'high'
                ? t('bannerSeveritySuffixRed')
                : s === 'medium'
                  ? t('bannerSeveritySuffixYellow')
                  : t('bannerSeveritySuffixBlue')}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">{t('bannerSeverityHint')}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="startAt">{t('bannerStartDateLabel')}</Label>
          <input
            id="startAt"
            type="datetime-local"
            value={startAt}
            onChange={(e) => setStartAt(e.target.value)}
            required
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="endAt">{t('bannerEndDateLabel')}</Label>
          <input
            id="endAt"
            type="datetime-local"
            value={endAt}
            onChange={(e) => setEndAt(e.target.value)}
            required
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          id="enabled"
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <Label htmlFor="enabled" className="font-normal">
          {t('bannerEnabledLabel')}
        </Label>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          {t('bannerCancel')}
        </Button>
        <Button type="submit">{mode === 'create' ? t('bannerSubmitCreate') : t('bannerSubmitUpdate')}</Button>
      </div>
    </form>
  );
}
