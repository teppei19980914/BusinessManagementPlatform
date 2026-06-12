'use client';

/**
 * 周知バナーの作成 / 編集フォーム (ADR-0036)。new (複製含む) と edit で共用する。
 *
 * 日時は datetime-local (ブラウザのローカル時刻 = 運用上 JST) で入力し、送信時に toISOString して
 * timestamptz として保存する。tenant-create-form.tsx の fetch + useLoading + useToast パターンを踏襲。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();

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
      setError('表示開始日時と終了日時を入力してください。');
      return;
    }
    const startIso = new Date(startAt).toISOString();
    const endIso = new Date(endAt).toISOString();
    if (new Date(startIso) >= new Date(endIso)) {
      setError('表示終了日時は開始日時より後にしてください。');
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
        setError(apiMessage ?? '表示期間が他の有効なバナーと重複しています。期間をずらすか、重複するバナーを取り下げてください。');
      } else if (code === 'VALIDATION_ERROR' || code === 'INVALID_PERIOD') {
        setError(apiMessage ?? '入力内容に誤りがあります。');
      } else {
        setError(apiMessage ?? '保存に失敗しました。');
      }
      showError('バナーの保存に失敗しました');
      return;
    }

    showSuccess(mode === 'create' ? 'バナーを作成しました。' : 'バナーを更新しました。');
    router.push('/admin/super/banners');
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      <div className="space-y-2">
        <Label htmlFor="message">メッセージ * (最大 500 文字)</Label>
        <textarea
          id="message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={500}
          rows={3}
          required
          className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder="例: 6/15 0:00〜3:00 にメンテナンスを実施します。一時的にご利用いただけません。"
        />
        <p className="text-xs text-muted-foreground">{message.length} / 500 文字</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="severity">緊急度 *</Label>
        <select
          id="severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value as BannerSeverity)}
          className={nativeSelectClass}
        >
          {BANNER_SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {BANNER_SEVERITY_LABELS[s]}
              {s === 'high' ? '（赤）' : s === 'medium' ? '（黄）' : '（青）'}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">高=赤 / 中=黄 / 低=青 で帯が塗られます。</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="startAt">表示開始日時 * (JST)</Label>
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
          <Label htmlFor="endAt">表示終了日時 * (JST)</Label>
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
          このバナーを有効にする（チェックを外すと取り下げ状態で保存。期間内でも表示されません）
        </Label>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          キャンセル
        </Button>
        <Button type="submit">{mode === 'create' ? 'バナーを作成' : '変更を保存'}</Button>
      </div>
    </form>
  );
}
