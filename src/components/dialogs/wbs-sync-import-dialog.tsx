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

const ACTION_LABEL: Record<SyncDiffRow['action'], string> = {
  CREATE: '追加',
  UPDATE: '更新',
  NO_CHANGE: '変更なし',
  REMOVE_CANDIDATE: '削除候補',
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
      setError('ファイルを選択してください');
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
      let message = 'プレビュー生成に失敗しました';
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
      let message = 'インポートに失敗しました';
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
    alert(`インポート完了: 追加 ${json.data.added} / 更新 ${json.data.updated} / 削除 ${json.data.removed}`);
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
            WBS 上書きインポート {step === 'preview' && '(プレビュー)'}
          </DialogTitle>
          <DialogDescription>
            CSV を読み込んで既存 WBS と差分を表示し、確認後に実行します。
            進捗・実績データは保全 (CSV 上は read-only) されます。
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
        )}

        {step === 'select' && (
          <form onSubmit={handlePreview} className="space-y-4">
            <div className="space-y-2">
              <Label>CSV ファイル</Label>
              <Input
                type="file"
                accept=".csv"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <p className="text-xs text-muted-foreground">
                17 列フォーマット (ID + 階層 + 計画 + 進捗系 read-only)。
                先に「WBS をエクスポート (上書き用)」でダウンロードした CSV を Excel で編集してご利用ください。
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={handleClose}>
                キャンセル
              </Button>
              <Button type="submit">プレビュー生成</Button>
            </div>
          </form>
        )}

        {step === 'preview' && preview && (
          <div className="space-y-4">
            {/* グローバルエラー */}
            {preview.globalErrors.length > 0 && (
              <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm">
                <div className="mb-1 font-semibold text-destructive">エラー</div>
                <ul className="list-disc pl-5 text-destructive">
                  {preview.globalErrors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}

            {/* サマリ */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <SummaryCard label="追加" value={preview.summary.added} variant="default" />
              <SummaryCard label="更新" value={preview.summary.updated} variant="secondary" />
              <SummaryCard label="削除候補" value={preview.summary.removed} variant="destructive" />
              <SummaryCard label="ブロッカー" value={preview.summary.blockedErrors} variant="destructive" />
              <SummaryCard label="警告" value={preview.summary.warnings} variant="outline" />
            </div>

            {/* 削除候補ハイライト */}
            {preview.summary.removed > 0 && (
              <div className="rounded-md border border-warning bg-warning/10 p-3 space-y-2">
                <div className="text-sm font-semibold">削除候補 ({preview.summary.removed} 件)</div>
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
                        {r.hasProgress && ' (進捗あり、削除モード=delete ではブロックされます)'}
                      </li>
                    ))}
                </ul>
              </div>
            )}

            {/* 削除モード選択 */}
            <div className="space-y-2">
              <Label>削除候補の扱い</Label>
              <div className="flex flex-col gap-1 text-sm">
                <RadioOption
                  checked={removeMode === 'keep'}
                  onChange={() => setRemoveMode('keep')}
                  label="保持: CSV にないタスクはそのまま残す (推奨)"
                />
                <RadioOption
                  checked={removeMode === 'warn'}
                  onChange={() => setRemoveMode('warn')}
                  label="警告のみ: 削除候補を表示し、本実行では削除しない"
                />
                <RadioOption
                  checked={removeMode === 'delete'}
                  onChange={() => setRemoveMode('delete')}
                  label="削除: CSV にないタスクを論理削除 (進捗ありはブロックされ実行不可)"
                />
              </div>
            </div>

            {/* 行ごとの差分テーブル */}
            <div className="space-y-2">
              <Label>差分一覧 ({preview.rows.length} 行)</Label>
              <div className="max-h-[40vh] overflow-y-auto rounded-md border border-input">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      <th className="px-2 py-1 text-left">CSV 行</th>
                      <th className="px-2 py-1 text-left">操作</th>
                      <th className="px-2 py-1 text-left">名称</th>
                      <th className="px-2 py-1 text-left">変更/警告</th>
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
                          <Badge variant={ACTION_BADGE[r.action]}>{ACTION_LABEL[r.action]}</Badge>
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
                              {fc.field}: {String(fc.before ?? '(空)')} → {String(fc.after ?? '(空)')}
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
                ブロッカーがあるため確定実行できません。CSV を修正してプレビューをやり直してください。
              </div>
            )}

            <div className="flex justify-between gap-2">
              <Button type="button" variant="outline" onClick={() => setStep('select')}>
                ← ファイル選択に戻る
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={handleClose}>
                  キャンセル
                </Button>
                <Button type="button" onClick={handleExecute} disabled={!canExecute}>
                  確定実行
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
