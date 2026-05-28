'use client';

/**
 * WBS 上書きインポート (Sync by ID) ダイアログ。
 *
 * 役割:
 *   2 ステップ UX で WBS の上書きインポートを実行する:
 *     Step 1: CSV ファイル選択 (D&D 対応) → ファイル選択時に自動 dry-run
 *     Step 2: 差分プレビュー表示 + フィルタ + 削除モード選択 + 確定実行
 *
 * 設計 (2026-05-25 UX uplift):
 *   - [W1] CSV テンプレート DL ボタンを Step 1 に配置
 *   - [W2] ファイル選択時に自動でプレビュー生成 (ワンクリック化)
 *   - [W3] removeMode='delete' 実行直前にネスト確認ダイアログ
 *   - [B1] エラー / 警告 / 全件 フィルタトグル
 *   - [B2] エラーメッセージは service 層でガイダンス文言化済 (CSV 修正ヒント付き)
 *   - [B4] D&D アップロード対応
 *   - [B5] REMOVE_CANDIDATE 行をテーブル内でも赤背景でハイライト
 *   - [B7] sm: breakpoint で grid / flex / overflow を切り替えモバイル対応
 *   - [C2] dry-run の snapshotAt を本実行ヘッダーに添えて並行編集を検出
 *
 * 関連:
 *   - DESIGN.md §33 (WBS 上書きインポート設計)
 *   - SPECIFICATION.md WBS 上書きインポート仕様
 */

import { useCallback, useRef, useState } from 'react';
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
import { useToast } from '@/components/toast-provider';

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

/**
 * 4 巡目フルスキャン (2026-05-28): preview レスポンスに同梱される DB 容量事前判定。
 * route layer の `runImportStoragePrecheck` から返される [`ImportStoragePrecheckResult`] と同型。
 */
type StoragePrecheck = {
  currentBytes: number;
  estimatedAddedBytes: number;
  estimatedPostImportBytes: number;
  freeQuotaBytes: number;
  hardCapBytes: number;
  level:
    | 'none'
    | 'beginner-block'
    | 'l1-warning'
    | 'l2-warning'
    | 'l3-block';
  isBlocker: boolean;
  code:
    | 'OK'
    | 'BEGINNER_FREE_QUOTA_EXCEEDED'
    | 'L1_WARNING'
    | 'L2_WARNING'
    | 'L3_HARD_CAP_EXCEEDED';
  message: string;
  expectedOverageJpy: number;
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
  /** [C2] OCC 用: dry-run 時点での project 配下 task の最大 updatedAt */
  snapshotAt?: string | null;
  /** 4 巡目フルスキャン (2026-05-28): DB 容量事前判定 */
  storagePrecheck?: StoragePrecheck | null;
};

type RowFilter = 'all' | 'errors' | 'warnings';

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

/**
 * [W1] CSV テンプレート (ヘッダー + サンプル 3 行) を生成。
 * BOM 付き UTF-8 で生成し Excel 互換にする。
 */
function buildCsvTemplate(): string {
  const BOM = '﻿';
  const header = 'ID,種別,名称,レベル,予定開始日,予定終了日,予定工数';
  const sample = [
    ',WP,設計フェーズ,1,,,',
    ',ACT,要件定義,2,2026-06-01,2026-06-07,8',
    ',ACT,基本設計レビュー,2,2026-06-08,2026-06-10,4',
  ].join('\n');
  return BOM + header + '\n' + sample + '\n';
}

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
  const { showSuccess, showError } = useToast();
  const [step, setStep] = useState<'select' | 'preview'>('select');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SyncDiffResult | null>(null);
  const [removeMode, setRemoveMode] = useState<RemoveMode>('keep');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<RowFilter>('all');
  const [dragActive, setDragActive] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setStep('select');
    setFile(null);
    setPreview(null);
    setRemoveMode('keep');
    setError('');
    setFilter('all');
    setDragActive(false);
    setShowDeleteConfirm(false);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onOpenChange(false);
  }, [reset, onOpenChange]);

  /** [W2] ファイル選択 (D&D 含む) を受け、即時 dry-run を実行する */
  const handleFileSelected = useCallback(
    async (chosen: File | null) => {
      setError('');
      setFile(chosen);
      if (!chosen) return;
      if (!chosen.name.toLowerCase().endsWith('.csv')) {
        setError(t('dndInvalidFile'));
        setFile(null);
        return;
      }

      const formData = new FormData();
      formData.append('file', chosen);

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
    },
    [projectId, t, withLoading],
  );

  /** [B4] D&D ハンドラ */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  }, []);
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      const dropped = e.dataTransfer.files?.[0];
      if (dropped) void handleFileSelected(dropped);
    },
    [handleFileSelected],
  );

  /** [W1] テンプレート DL */
  const handleDownloadTemplate = useCallback(() => {
    const blob = new Blob([buildCsvTemplate()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'wbs-sync-import-template.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  /** 本実行: removeMode='delete' で削除候補ありなら確認ダイアログを経由 */
  const performExecute = useCallback(async () => {
    if (!file || !preview) return;
    setError('');
    setShowDeleteConfirm(false);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('removeMode', removeMode);

    const headers: Record<string, string> = {};
    if (preview.snapshotAt) {
      // [C2] OCC: dry-run 時点の最大 updatedAt をヘッダーで送信。
      headers['x-import-snapshot-at'] = preview.snapshotAt;
    }

    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/tasks/sync-import`, {
        method: 'POST',
        body: formData,
        headers,
      }),
    );

    if (!res.ok) {
      let message = t('importFailed');
      try {
        const json = await res.json();
        if (json.error?.code === 'IMPORT_CONCURRENT_EDIT') {
          message = t('concurrentEditDetected');
        } else {
          message = json.error?.message || message;
        }
      } catch {
        /* noop */
      }
      setError(message);
      showError(message);
      return;
    }

    const json = await res.json();
    handleClose();
    showSuccess('WBS を上書きインポートしました');
    await onImported();
    alert(
      t('importComplete', {
        added: json.data.added,
        updated: json.data.updated,
        removed: json.data.removed,
      }),
    );
  }, [
    file,
    preview,
    removeMode,
    projectId,
    t,
    withLoading,
    showError,
    showSuccess,
    handleClose,
    onImported,
  ]);

  function handleExecute() {
    if (removeMode === 'delete' && (preview?.summary.removed ?? 0) > 0) {
      // [W3] 削除モード実行直前に確認モーダル
      setShowDeleteConfirm(true);
      return;
    }
    void performExecute();
  }

  // 進捗あり削除候補が存在し、かつ removeMode='delete' の場合は確定不可
  const blockedRemovals = preview
    ? preview.rows.filter((r) => r.action === 'REMOVE_CANDIDATE' && r.hasProgress)
    : [];
  const canExecute =
    preview != null
    && preview.canExecute
    && !(removeMode === 'delete' && blockedRemovals.length > 0)
    // 4 巡目フルスキャン (2026-05-28): Beginner 50MB block / L3 50GB block の事前判定
    && !(preview.storagePrecheck?.isBlocker === true);

  // [B1] フィルタ別の行集合
  const errorRows = preview?.rows.filter((r) => r.warningLevel === 'ERROR') ?? [];
  const warnRows = preview?.rows.filter((r) => r.warningLevel === 'WARN') ?? [];
  const visibleRows = (() => {
    if (!preview) return [];
    if (filter === 'errors') return errorRows;
    if (filter === 'warnings') return warnRows;
    return preview.rows;
  })();

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : handleClose())}>
        <DialogContent className="max-w-[min(95vw,64rem)] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t('title')} {step === 'preview' && t('previewSuffix')}
            </DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>

          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
          )}

          {step === 'select' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <Label>{t('csvFile')}</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleDownloadTemplate}
                    aria-label={t('downloadTemplateAria')}
                  >
                    ⬇ {t('downloadTemplate')}
                  </Button>
                </div>

                {/* [B4] D&D ゾーン (クリックで file picker、ドロップで自動 dry-run) */}
                <div
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={
                    'cursor-pointer rounded-md border-2 border-dashed p-6 text-center text-sm transition-colors '
                    + (dragActive
                      ? 'border-primary bg-primary/5 text-primary'
                      : 'border-input bg-muted/30 hover:bg-muted/50')
                  }
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      fileInputRef.current?.click();
                    }
                  }}
                >
                  {dragActive ? t('dndDropHere') : file ? `📄 ${file.name}` : t('dndHint')}
                </div>
                <Input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={(e) => void handleFileSelected(e.target.files?.[0] ?? null)}
                />

                <p className="text-xs text-muted-foreground">{t('csvFormatHint')}</p>
              </div>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={handleClose}>
                  {tAction('cancel')}
                </Button>
              </div>
            </div>
          )}

          {step === 'preview' && preview && (
            <div className="space-y-4">
              {/* グローバルエラー */}
              {preview.globalErrors.length > 0 && (
                <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm">
                  <div className="mb-1 font-semibold text-destructive">{t('errors')}</div>
                  <ul className="list-disc pl-5 text-destructive">
                    {preview.globalErrors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* 4 巡目フルスキャン (2026-05-28): DB 容量事前判定の警告/ブロック表示 */}
              {preview.storagePrecheck && preview.storagePrecheck.level !== 'none' && (
                <StoragePrecheckPanel precheck={preview.storagePrecheck} />
              )}

              {/* [B7] サマリ — sm 未満は 2 列、sm 以上は 5 列 */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <SummaryCard label={t('summaryAdded')} value={preview.summary.added} variant="default" />
                <SummaryCard label={t('summaryUpdated')} value={preview.summary.updated} variant="secondary" />
                <SummaryCard label={t('summaryRemoveCandidate')} value={preview.summary.removed} variant="destructive" />
                <SummaryCard label={t('summaryBlocker')} value={preview.summary.blockedErrors} variant="destructive" />
                <SummaryCard label={t('summaryWarning')} value={preview.summary.warnings} variant="outline" />
              </div>

              {/* 削除候補ハイライト (進捗ありを上に) */}
              {preview.summary.removed > 0 && (
                <div className="rounded-md border border-warning bg-warning/10 p-3 space-y-2">
                  <div className="text-sm font-semibold">
                    {t('removeCandidatesTitle', { count: preview.summary.removed })}
                  </div>
                  <ul className="space-y-1 text-sm">
                    {preview.rows
                      .filter((r) => r.action === 'REMOVE_CANDIDATE')
                      .sort((a, b) => Number(b.hasProgress ?? false) - Number(a.hasProgress ?? false))
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

              {/* [B1] フィルタ */}
              <div className="flex items-center gap-2 flex-wrap">
                <Label className="m-0">{t('filterLabel')}</Label>
                <div className="inline-flex rounded-md border border-input overflow-hidden text-xs">
                  <FilterButton
                    active={filter === 'all'}
                    onClick={() => setFilter('all')}
                    label={t('filterAll', { count: preview.rows.length })}
                  />
                  <FilterButton
                    active={filter === 'errors'}
                    onClick={() => setFilter('errors')}
                    label={t('filterErrors', { count: errorRows.length })}
                    variant="destructive"
                  />
                  <FilterButton
                    active={filter === 'warnings'}
                    onClick={() => setFilter('warnings')}
                    label={t('filterWarnings', { count: warnRows.length })}
                    variant="warning"
                  />
                </div>
              </div>

              {/* 行ごとの差分テーブル */}
              <div className="space-y-2">
                <Label>{t('diffListLabel', { count: visibleRows.length })}</Label>
                <div className="max-h-[40vh] overflow-y-auto rounded-md border border-input">
                  {visibleRows.length === 0 ? (
                    <div className="p-4 text-center text-sm text-muted-foreground">
                      {t('filterNoMatch')}
                    </div>
                  ) : (
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
                        {visibleRows.map((r, idx) => (
                          <tr
                            key={`${r.id ?? 'new'}-${idx}`}
                            className={
                              // [B5] REMOVE_CANDIDATE は進捗ありなら destructive、進捗なしなら warning
                              r.action === 'REMOVE_CANDIDATE'
                                ? r.hasProgress
                                  ? 'bg-destructive/10'
                                  : 'bg-warning/10'
                                : r.warningLevel === 'ERROR'
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
                                <div key={`e-${i}`} className="text-destructive">
                                  ⛔ {e}
                                </div>
                              ))}
                              {r.warnings?.map((w, i) => (
                                <div key={`w-${i}`} className="text-warning">
                                  ⚠ {w}
                                </div>
                              ))}
                              {r.fieldChanges?.map((fc, i) => (
                                <div key={`fc-${i}`} className="text-muted-foreground">
                                  {fc.field}: {String(fc.before ?? t('fieldEmpty'))} →{' '}
                                  {String(fc.after ?? t('fieldEmpty'))}
                                </div>
                              ))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {!canExecute && (
                <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
                  {t('blockerNotice')}
                </div>
              )}

              {/* [B7] sm 未満は縦並び、sm 以上は justify-between */}
              <div className="flex flex-col-reverse sm:flex-row sm:justify-between gap-2">
                <Button type="button" variant="outline" onClick={() => setStep('select')}>
                  {t('backToFileSelect')}
                </Button>
                <div className="flex flex-col-reverse sm:flex-row gap-2">
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

      {/* [W3] 削除モード確認ダイアログ */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('deleteConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('deleteConfirmDesc', { count: preview?.summary.removed ?? 0 })}
            </DialogDescription>
          </DialogHeader>
          {preview && preview.summary.removed > 0 && (
            <ul className="max-h-48 overflow-y-auto text-sm space-y-1 rounded-md border border-input p-2">
              {preview.rows
                .filter((r) => r.action === 'REMOVE_CANDIDATE' && !r.hasProgress)
                .map((r) => (
                  <li key={r.id ?? r.csvRow}>「{r.name}」</li>
                ))}
            </ul>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setShowDeleteConfirm(false)}>
              {tAction('cancel')}
            </Button>
            <Button type="button" variant="destructive" onClick={() => void performExecute()}>
              {t('deleteConfirmExecute')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
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
    <label className="flex items-start gap-2 cursor-pointer">
      <input type="radio" checked={checked} onChange={onChange} className="mt-1 cursor-pointer" />
      <span>{label}</span>
    </label>
  );
}

/**
 * 4 巡目フルスキャン (2026-05-28): DB 容量事前判定パネル (entity-sync-import-dialog と同型)。
 * Beginner-block / L3-block は赤色エラー、L1/L2 警告は黄色警告で表示。
 */
function StoragePrecheckPanel({ precheck }: { precheck: StoragePrecheck }) {
  const isBlocker = precheck.isBlocker;
  return (
    <div
      className={
        isBlocker
          ? 'rounded-md border border-destructive bg-destructive/10 p-3 text-sm'
          : 'rounded-md border border-warning bg-warning/10 p-3 text-sm'
      }
      data-testid="storage-precheck-panel"
      data-level={precheck.level}
    >
      <div
        className={
          isBlocker ? 'mb-1 font-semibold text-destructive' : 'mb-1 font-semibold'
        }
      >
        {isBlocker ? '⛔ DB 容量の上限超過予測 (取込は実行できません)' : '⚠ DB 容量の警告'}
      </div>
      <p className="mb-2">{precheck.message}</p>
      <div className="grid grid-cols-1 gap-1 text-xs text-muted-foreground sm:grid-cols-3">
        <div>
          現在の DB 使用量: <strong>{formatBytesShort(precheck.currentBytes)}</strong>
        </div>
        <div>
          取込後の予測値: <strong>{formatBytesShort(precheck.estimatedPostImportBytes)}</strong>
        </div>
        <div>
          無料枠: <strong>{formatBytesShort(precheck.freeQuotaBytes)}</strong>
        </div>
      </div>
    </div>
  );
}

function formatBytesShort(bytes: number): string {
  if (bytes >= 1_000_000_000) return (bytes / 1_000_000_000).toFixed(2) + ' GB';
  if (bytes >= 1_000_000) return (bytes / 1_000_000).toFixed(1) + ' MB';
  if (bytes >= 1_000) return (bytes / 1_000).toFixed(1) + ' KB';
  return bytes + ' bytes';
}

function FilterButton({
  active,
  onClick,
  label,
  variant,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  variant?: 'destructive' | 'warning';
}) {
  const base = 'px-3 py-1 transition-colors';
  const activeCls =
    variant === 'destructive'
      ? 'bg-destructive text-destructive-foreground'
      : variant === 'warning'
        ? 'bg-warning text-warning-foreground'
        : 'bg-primary text-primary-foreground';
  const inactive = 'bg-background hover:bg-muted';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${base} ${active ? activeCls : inactive} border-r border-input last:border-r-0`}
    >
      {label}
    </button>
  );
}
