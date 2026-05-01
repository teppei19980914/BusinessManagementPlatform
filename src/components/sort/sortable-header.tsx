'use client';

/**
 * SortableHeader (PR feat/sortable-columns / 2026-05-01)。
 *
 * 列ヘッダの内側にレンダーする「ソート操作 UI」コンポーネント。
 *
 * 仕様 (Q4-1〜Q4-5):
 *   - クリックで「昇順 / 降順 / クリア」のドロップダウン表示 (Q4-5: ユーザ提案)
 *   - 現在のソート状態は ↑¹ ↓² のように矢印 + 優先度数字 (sup) で表示 (Q4-5: バッジ表示)
 *   - クリック外でドロップダウン閉じる
 *   - ESC キーでも閉じる
 *
 * 使い方:
 *   <ResizableHead columnKey="title" defaultWidth={240}>
 *     <SortableHeader
 *       columnKey="title"
 *       label={tRisk('subject')}
 *       sortState={sortState}
 *       onSortChange={setSortColumn}
 *     />
 *   </ResizableHead>
 *
 * 親 ResizableHead は overflow:hidden を持たないため (PR 同梱で削除)、
 * 絶対配置のドロップダウンが th 外側に出られる。
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { getColumnSort, type SortDir, type SortState } from '@/lib/multi-sort';

type Props = {
  columnKey: string;
  label: string;
  sortState: SortState;
  onSortChange: (columnKey: string, dir: SortDir | 'clear') => void;
  /** 追加クラス (rare、必要時のみ) */
  className?: string;
};

export function SortableHeader({ columnKey, label, sortState, onSortChange, className }: Props) {
  const t = useTranslations('sort');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const current = getColumnSort(sortState, columnKey);

  // ドロップダウン外クリック / ESC でクローズ
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const arrow = current?.direction === 'asc' ? '↑' : current?.direction === 'desc' ? '↓' : '';

  function handleSelect(dir: SortDir | 'clear') {
    onSortChange(columnKey, dir);
    setOpen(false);
  }

  return (
    <div className={`relative inline-flex ${className ?? ''}`} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-0.5 hover:text-info focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded px-0.5"
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          current
            ? `${label}: ${current.direction === 'asc' ? t('asc') : t('desc')} (${t('priority')} ${current.priority})`
            : `${label} (${t('clickToSort')})`
        }
        data-testid="sortable-header-button"
        data-column-key={columnKey}
      >
        <span className="truncate">{label}</span>
        {current && (
          <span className="ml-0.5 text-xs text-info" aria-label={`${arrow}${current.priority}`}>
            {arrow}
            <sup>{current.priority}</sup>
          </span>
        )}
      </button>
      {open && (
        <ul
          role="menu"
          className="absolute left-0 top-full z-30 mt-1 min-w-[120px] rounded-md border bg-card shadow-md"
        >
          <li>
            <button
              type="button"
              role="menuitem"
              onClick={() => handleSelect('asc')}
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-accent"
            >
              ↑ {t('asc')}
            </button>
          </li>
          <li>
            <button
              type="button"
              role="menuitem"
              onClick={() => handleSelect('desc')}
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-accent"
            >
              ↓ {t('desc')}
            </button>
          </li>
          {current && (
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={() => handleSelect('clear')}
                className="block w-full px-3 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent"
              >
                × {t('clear')}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
