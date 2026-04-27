'use client';

/**
 * 「全○○一覧」横断ビュー共通の **bulk visibility 編集ツールバー** (PR #162 / Phase 2)。
 *
 * 共通仕様:
 *   - 上部にフィルター入力 (キーワード + 「自分作成のみ」チェック) を配置。
 *     PR #161 と同じ二重防御方針: フィルター 1 つも適用していない場合は
 *     **bulk 選択列・ツールバー自体を表示しない** (UI 改変による誤操作を防ぐ)。
 *   - filterApplied 時のみ checkbox 列を表示し、`viewerIsCreator=true` の行のみ
 *     チェック有効。bulk 編集ボタンで visibility 切替ダイアログを開く。
 *   - 送信時はサーバの `/api/<entity>/bulk` PATCH を呼ぶ (entity は呼び出し側が指定)。
 *
 * 認可:
 *   - 編集権限はサーバ側で per-row 検証 (silent skip)。本コンポーネントは UI 防御のみ。
 *
 * 関連: DEVELOPER_GUIDE §5.21 (PR #161 で確立した二重防御パターン)
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useLoading } from '@/components/loading-overlay';

export type CrossListFilterState = {
  keyword: string;
  mineOnly: boolean;
};

export const EMPTY_FILTER: CrossListFilterState = { keyword: '', mineOnly: false };

export function isCrossListFilterActive(f: CrossListFilterState): boolean {
  return Boolean(f.mineOnly || f.keyword.trim().length > 0);
}

type Props = {
  /**
   * PATCH 一括更新 API のフルパス (PR #165: project-scoped に対応するため文字列受け取りに変更)。
   * 例: `/api/projects/${projectId}/retrospectives/bulk` / `/api/projects/${projectId}/knowledge/bulk` / `/api/memos/bulk`
   */
  endpoint: string;
  /** id 識別子 (各 form input id 等で使う一意キー、`endpointPath` から代替) */
  formIdPrefix: string;
  /** 現在のフィルター状態 (state は呼び出し側で持つ) */
  filter: CrossListFilterState;
  onFilterChange: (next: CrossListFilterState) => void;
  /** 選択中の ID 集合 (state は呼び出し側で持つ) */
  selectedIds: Set<string>;
  onSelectionClear: () => void;
  /** visibility 値域 (entity 別)。例: ['draft','public'] / ['private','public'] */
  visibilityOptions: { value: string; label: string }[];
  /** 「○○一覧」の和名 (例: 「振り返り」) */
  entityLabel: string;
  /** Dialog 送信成功後にテーブルを reload する */
  onApplied: () => void | Promise<void>;
};

export function CrossListBulkVisibilityToolbar({
  endpoint,
  formIdPrefix,
  filter,
  onFilterChange,
  selectedIds,
  onSelectionClear,
  visibilityOptions,
  entityLabel,
  onApplied,
}: Props) {
  const t = useTranslations('bulkVisibility');
  const tAction = useTranslations('action');
  const { withLoading } = useLoading();
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkVisibility, setBulkVisibility] = useState<string>(visibilityOptions[0]?.value ?? '');
  const [error, setError] = useState('');

  const filterApplied = isCrossListFilterActive(filter);

  async function submit() {
    setError('');
    if (selectedIds.size === 0 || !bulkVisibility) return;

    const res = await withLoading(() =>
      fetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: Array.from(selectedIds),
          filterFingerprint: {
            keyword: filter.keyword.trim() || undefined,
            mineOnly: filter.mineOnly || undefined,
          },
          visibility: bulkVisibility,
        }),
      }),
    );
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j?.message || j?.error || t('bulkUpdateFailed'));
      return;
    }
    setBulkOpen(false);
    onSelectionClear();
    await onApplied();
  }

  return (
    <>
      {/* フィルター UI */}
      <div className="rounded-md border bg-muted/30 p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-sm font-medium">{t('filterTitle')}</span>
          {!filterApplied && (
            <span className="text-xs text-muted-foreground">
              {t('filterRequiredHint')}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          <div className="md:col-span-2">
            <Label htmlFor={`${formIdPrefix}-filter-keyword`} className="text-xs">{t('keywordLabel')}</Label>
            <Input
              id={`${formIdPrefix}-filter-keyword`}
              value={filter.keyword}
              onChange={(e) => onFilterChange({ ...filter, keyword: e.target.value })}
              placeholder={t('keywordPlaceholder')}
            />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                checked={filter.mineOnly}
                onChange={(e) => onFilterChange({ ...filter, mineOnly: e.target.checked })}
                className="rounded"
              />
              {t('mineOnly')}
            </label>
          </div>
        </div>
      </div>

      {/* 一括編集ツールバー (フィルター適用時のみ) */}
      {filterApplied && (
        <div className="flex items-center justify-between gap-2 py-2">
          <div className="text-sm text-muted-foreground">
            {t('selectedCount', { count: selectedIds.size })}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onSelectionClear}
              disabled={selectedIds.size === 0}
            >
              {t('deselectAll')}
            </Button>
            <Button
              size="sm"
              onClick={() => { setBulkVisibility(visibilityOptions[0]?.value ?? ''); setError(''); setBulkOpen(true); }}
              disabled={selectedIds.size === 0}
            >
              {t('bulkEditWithCount', { count: selectedIds.size })}
            </Button>
          </div>
        </div>
      )}

      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('dialogTitle', { entityLabel, count: selectedIds.size })}</DialogTitle>
            <DialogDescription>
              {t('dialogDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label className="text-sm">{t('visibilityLabel')}</Label>
            <Select
              value={bulkVisibility}
              onValueChange={(v) => { if (v) setBulkVisibility(v); }}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {visibilityOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {error && (
            <div className="mt-3 rounded-md bg-destructive/10 p-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)}>{tAction('cancel')}</Button>
            <Button onClick={submit}>{t('apply')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
