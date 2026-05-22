'use client';

/**
 * SortableHeader (PR feat/sortable-columns / 2026-05-01, PR #425 hover 拡張 2026-05-22)。
 *
 * 列ヘッダの内側にレンダーする「ソート操作 UI」コンポーネント。
 *
 * 仕様 (Q4-1〜Q4-5 + PR #425 UX 改善):
 *   - **マウスオーバー OR クリック** でドロップダウン表示 (= hover で即開く、touch / キーボードは click)
 *   - メニュー項目: 「↑ 昇順 / ↓ 降順 / × クリア (リセット)」
 *   - 現在のソート状態はカラム内に **矢印 + 優先度番号バッジ** で常時表示 (例: `↑ 1` `↓ 2`)
 *     - 複数列ソート時の優先度を視認可能 (= 番号小 = 先に適用される)
 *   - ドロップダウンは「メニュー外クリック / ESC キー / メニュー領域から離れる (mouseleave with delay)」で閉じる
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
  // PR #425 (2026-05-22): hover からプルダウン領域に移動する時間を確保するため
  //   mouseleave で即時 close せず、200ms 遅延後に close する。
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // cleanup: 親 unmount 時に timer を確実に解放
  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  const arrow = current?.direction === 'asc' ? '↑' : current?.direction === 'desc' ? '↓' : '';

  function handleSelect(dir: SortDir | 'clear') {
    onSortChange(columnKey, dir);
    setOpen(false);
  }

  function handleMouseEnter() {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setOpen(true);
  }

  function handleMouseLeave() {
    // 200ms 後に close。途中で再度 mouseenter があれば cancel される。
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => setOpen(false), 200);
  }

  return (
    <div
      className={`relative inline-flex ${className ?? ''}`}
      ref={ref}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 hover:text-info focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded px-0.5"
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
          <span
            className="inline-flex items-center gap-0.5 rounded-md bg-info/15 px-1.5 py-0.5 text-xs font-semibold leading-none text-info"
            aria-label={`${current.direction === 'asc' ? t('asc') : t('desc')} ${t('priority')} ${current.priority}`}
            data-testid="sortable-header-badge"
            data-direction={current.direction}
            data-priority={current.priority}
          >
            <span aria-hidden="true">{arrow}</span>
            <span className="text-[10px] opacity-80">{current.priority}</span>
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
