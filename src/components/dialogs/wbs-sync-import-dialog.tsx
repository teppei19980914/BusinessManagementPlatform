'use client';

/**
 * WBS 上書きインポート (Sync by ID) ダイアログ (feat/wbs-overwrite-import)。
 *
 * 役割:
 *   2 ステップ UX で WBS の上書きインポートを実行する:
 *     Step 1: CSV ファイル選択 → プレビュー生成 (?dryRun=1)
 *     Step 2: 差分プレビュー表示 + 削除モード選択 + 確定実行
 *
 * 設計:
 *   - dry-run の差分は API レスポンスをそのまま rows + summary で表示
 *   - 削除候補のうち進捗ありは赤強調 (削除モード=delete でブロック)
 *   - canExecute=false なら確定ボタンを disabled にしてエラー一覧を強調
 *
 * 関連:
 *   - DESIGN.md §33 (WBS 上書きインポート設計)
 *   - SPECIFICATION.md WBS 上書きインポート仕様
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useLoading } from '@/components/loading-overlay';

type RemoveMode = 'keep' | 'warn' | 'delete';

type SyncDiffFieldChange = { field: string; before: unknown; after: unknown };

type SyncDiffRow = {
  csvRow: number | null;
  id: string | null;
  tempId: string | null;
  action: 'CREATE' | 'UPDATE' | 'NO_CHANGE' | 'REMOVE_CANDIDATE';
  name: string;
  fieldChanges?: SyncDiffFieldChange[];
  warnings?: string[];
  errors?: string[];
  hasProgress?: boolean;
  warningLevel?: 'INFO' | 'WARN' | 'ERROR';
};

type SyncDiffResult = {
  summary: {
    added: number;
    updated: number;
    removed: number;
    blockedErrors: number;
    warnings: number;
  };
  rows: SyncDiffRow[];
  canExecute: boolean;
  globalErrors: string[];
};

const ACTION_LABEL_KEY: Record<SyncDiffRow['action'], string> = {
  CREATE: 'actionCreate',
  UPDATE: 'actionUpdate',
  NO_CHANGE: 'actionNoChange',
  REMOVE_CANDIDATE: 'actionRemoveCandidate',
};

const ACTION_BADGE: Record<SyncDiffRow['action'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
  CREATE: 'default',
  UPDATE: 'secondary',
  NO_CHANGE: 'outline',
  REMOVE_CANDIDATE: 'destructive',
};

export function WbsSyncImportDialog({
  projectId,
  open,
  onOpenChange,
  onImported,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onImported: () => Promise<void> | void;
}) {
  const t = useTranslations('wbs.syncImport');
  const tAction = useTranslations('action');
  const { withLoading } = useLoading();
  const [step, setStep] = useState<'select' | 'preview'>('select');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SyncDiffResult | null>(null);
  const [removeMode, setRemoveMode] = useState<RemoveMode>('keep');
  const [error, setError] = useState('');

  function reset() {
    setStep('select');
    setFile(null);
    setPreview(null);
    setRemoveMode('keep');
    setError('');
  }

  function handleClose() {
    reset();
    onOpenChange(false);
  }

  async function handlePreview(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!file) {
      setError(t('fileRequired'));
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/tasks/sync-import?dryRun=1`, {
        method: 'POST',
        body: formData,
      }),
    );

    if (!res.ok) {
      let message = t('previewFailed');
      try {
        const json = await res.json();
        message = json.error?.message || message;
      } catch {
        /* noop */
      }
      setError(message);
      return;
    }

    const json = await res.json();
    setPreview(json.data);
    setStep('preview');
  }

  async function handleExecute() {
    if (!file || !preview) return;
    setError('');

    const formData = new FormData();
    formData.append('file', file);
    formData.append('removeMode', removeMode);

    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/tasks/sync-import`, {
        method: 'POST',
        body: formData,
      }),
    );

    if (!res.ok) {
      let message = t('importFailed');
      try {
        const json = await res.json();
        message = json.error?.message || message;
      } catch {
        /* noop */
      }
      setError(message);
      return;
    }

    const json = await res.json();
    handleClose();
    await onImported();
    alert(t('importComplete', {
      added: json.data.added,
      updated: json.data.updated,
      removed: json.data.removed,
    }));
  }

  // 進捗あり削除候補が存在し、かつ removeMode='delete' の場合は確定不可
  const blockedRemovals = preview
    ? preview.rows.filter((r) => r.action === 'REMOVE_CANDIDATE' && r.hasProgress)
    : [];
  const canExecute =
    preview != null
    && preview.canExecute
    && !(removeMode === 'delete' && blockedRemovals.length > 0);

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : handleClose())}>
      <DialogContent className="max-w-[min(95vw,64rem)] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t('title')} {step === 'preview' && t('previewSuffix')}
          </DialogTitle>
          <DialogDescription>
            {t('description')}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
        )}

        {step === 'select' && (
          <form onSubmit={handlePreview} className="space-y-4">
            <div className="space-y-2">
              <Label>{t('csvFile')}</Label>
              <Input
                type="file"
                accept=".csv"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <p className="text-xs text-muted-foreground">
                {t('csvFormatHint')}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={handleClose}>
                {tAction('cancel')}
              </Button>
              <Button type="submit">{t('previewGenerate')}</Button>
            </div>
          </form>
        )}

        {step === 'preview' && preview && (
          <div className="space-y-4">
            {/* グローバルエラー */}
            {preview.globalErrors.length > 0 && (
              <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm">
                <div className="mb-1 font-semibold text-destructive">{t('errors')}</div>
                <ul className="list-disc pl-5 text-destructive">
                  {preview.globalErrors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}

            {/* サマリ */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <SummaryCard label={t('summaryAdded')} value={preview.summary.added} variant="default" />
              <SummaryCard label={t('summaryUpdated')} value={preview.summary.updated} variant="secondary" />
              <SummaryCard label={t('summaryRemoveCandidate')} value={preview.summary.removed} variant="destructive" />
              <SummaryCard label={t('summaryBlocker')} value={preview.summary.blockedErrors} variant="destructive" />
              <SummaryCard label={t('summaryWarning')} value={preview.summary.warnings} variant="outline" />
            </div>

            {/* 削除候補ハイライト */}
            {preview.summary.removed > 0 && (
              <div className="rounded-md border border-warning bg-warning/10 p-3 space-y-2">
                <div className="text-sm font-semibold">{t('removeCandidatesTitle', { count: preview.summary.removed })}</div>
                <ul className="space-y-1 text-sm">
                  {preview.rows
                    .filter((r) => r.action === 'REMOVE_CANDIDATE')
                    .map((r) => (
                      <li
                        key={r.id ?? r.csvRow}
                        className={r.hasProgress ? 'text-destructive font-medium' : ''}
                      >
                        {r.hasProgress && '⚠ '}
                        「{r.name}」
                        {r.hasProgress && t('removeCandidateBlockedSuffix')}
                      </li>
                    ))}
                </ul>
              </div>
            )}

            {/* 削除モード選択 */}
            <div className="space-y-2">
              <Label>{t('removeModeLabel')}</Label>
              <div className="flex flex-col gap-1 text-sm">
                <RadioOption
                  checked={removeMode === 'keep'}
                  onChange={() => setRemoveMode('keep')}
                  label={t('removeModeKeep')}
                />
                <RadioOption
                  checked={removeMode === 'warn'}
                  onChange={() => setRemoveMode('warn')}
                  label={t('removeModeWarn')}
                />
                <RadioOption
                  checked={removeMode === 'delete'}
                  onChange={() => setRemoveMode('delete')}
                  label={t('removeModeDelete')}
                />
              </div>
            </div>

            {/* 行ごとの差分テーブル */}
            <div className="space-y-2">
              <Label>{t('diffListLabel', { count: preview.rows.length })}</Label>
              <div className="max-h-[40vh] overflow-y-auto rounded-md border border-input">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      <th className="px-2 py-1 text-left">{t('columnCsvRow')}</th>
                      <th className="px-2 py-1 text-left">{t('columnAction')}</th>
                      <th className="px-2 py-1 text-left">{t('columnName')}</th>
                      <th className="px-2 py-1 text-left">{t('columnChangeWarning')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r, idx) => (
                      <tr
                        key={`${r.id ?? 'new'}-${idx}`}
                        className={
                          r.warningLevel === 'ERROR'
                            ? 'bg-destructive/5'
                            : r.warningLevel === 'WARN'
                              ? 'bg-warning/5'
                              : ''
                        }
                      >
                        <td className="px-2 py-1 align-top">{r.csvRow ?? '-'}</td>
                        <td className="px-2 py-1 align-top">
                          <Badge variant={ACTION_BADGE[r.action]}>{t(ACTION_LABEL_KEY[r.action])}</Badge>
                        </td>
                        <td className="px-2 py-1 align-top">{r.name}</td>
                        <td className="px-2 py-1 align-top text-xs">
                          {r.errors?.map((e, i) => (
                            <div key={`e-${i}`} className="text-destructive">⛔ {e}</div>
                          ))}
                          {r.warnings?.map((w, i) => (
                            <div key={`w-${i}`} className="text-warning">⚠ {w}</div>
                          ))}
                          {r.fieldChanges?.map((fc, i) => (
                            <div key={`fc-${i}`} className="text-muted-foreground">
                              {fc.field}: {String(fc.before ?? t('fieldEmpty'))} → {String(fc.after ?? t('fieldEmpty'))}
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {!canExecute && (
              <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
                {t('blockerNotice')}
              </div>
            )}

            <div className="flex justify-between gap-2">
              <Button type="button" variant="outline" onClick={() => setStep('select')}>
                {t('backToFileSelect')}
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={handleClose}>
                  {tAction('cancel')}
                </Button>
                <Button type="button" onClick={handleExecute} disabled={!canExecute}>
                  {t('execute')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SummaryCard({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
}) {
  return (
    <div className="rounded-md border border-input p-2 text-center">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1">
        <Badge variant={variant}>{value}</Badge>
      </div>
    </div>
  );
}

function RadioOption({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input type="radio" checked={checked} onChange={onChange} className="cursor-pointer" />
      <span>{label}</span>
    </label>
  );
}
