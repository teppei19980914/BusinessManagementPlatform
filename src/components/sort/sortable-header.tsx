'use client';

/**
 * SortableHeader (PR feat/sortable-columns / 2026-05-01, PR #425 hover 拡張 2026-05-22,
 * PR fix/sortable-header-dropdown-portal / 2026-05-24 Portal 化)。
 *
 * 列ヘッダの内側にレンダーする「ソート操作 UI」コンポーネント。
 *
 * 仕様 (Q4-1〜Q4-5 + PR #425 UX 改善):
 *   - **マウスオーバー OR クリック** でドロップダウン表示 (= hover で即開く、touch / キーボードは click)
 *   - メニュー項目: 「↑ 昇順 / ↓ 降順 / × クリア (リセット)」
 *   - 現在のソート状態はカラム内に **矢印 + 優先度番号バッジ** で常時表示 (例: `↑ 1` `↓ 2`)
 *     - 複数列ソート時の優先度を視認可能 (= 番号小 = 先に適用される)
 *   - ドロップダウンは「メニュー外クリック / ESC キー / メニュー領域から離れる (mouseleave with delay) /
 *     scroll / window resize」で閉じる
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
 * Portal 化 (2026-05-24): 旧実装はドロップダウンを `position: absolute` で trigger 直下に置いていたが、
 * 親 `ResizableHead` の `<div className="truncate pr-2">` が `overflow: hidden` を持つため
 * (Tailwind `truncate` ユーティリティの定義), 絶対配置子要素は **content box でクリップされて完全不可視**
 * になっていた。同時に `Table` の wrapper も `overflow: auto` を持つため、`truncate` を解消しても
 * 右端カラムで二次クリップが起きる構造。
 *
 * 対策として `createPortal` で `document.body` 直下にドロップダウンを置き、`getBoundingClientRect()` で
 * trigger 位置を取得して座標固定する。これにより以下を一括解決:
 *   - 任意の祖先 `overflow: hidden / auto` から独立
 *   - z-index は body 直下なら sticky header (z-40) より背面に積層されないよう `z-50` 指定
 *   - SSR: createPortal は `document` 不在のため、`mounted` flag で client mount 後のみレンダー
 *   - click-outside: trigger ref と menu ref の **両方** を `contains` チェックしないと
 *     menu 内クリックが「外」と誤判定される (Portal は React tree 内だが DOM tree 外のため)
 *   - scroll / resize: 座標が陳腐化するため close で対応 (再計算より単純で UX 影響小)
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

type Coords = { top: number; left: number };

/**
 * SSR-safe な useLayoutEffect (window 不在環境では useEffect)。Next.js App Router の
 * client component でも hydration mismatch を避けるためのおまじない。
 */
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function SortableHeader({ columnKey, label, sortState, onSortChange, className }: Props) {
  const t = useTranslations('sort');
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  // a11y: trigger と menu の関連付けに使う安定 id (Portal で menu が DOM tree 外に出る
  // ため、aria-controls による明示的関連付けがスクリーンリーダー対応として必須)。
  // useId は SSR/CSR で同じ id を生成する React 標準 hook。
  const reactId = useId();
  const menuDomId = `sortable-header-menu-${reactId}`;

  const triggerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  // PR #425 (2026-05-22): hover からプルダウン領域に移動する時間を確保するため
  //   mouseleave で即時 close せず、200ms 遅延後に close する。
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = getColumnSort(sortState, columnKey);

  // SSR ガード: createPortal は document 必須のため、mount 後にのみ Portal を有効化。
  // 標準的な "isClient" 検出 pattern (Next.js + ssr の常套句)。
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setMounted(true); }, []);

  // 開く瞬間に trigger の座標を計算 (top-full + 4px 余白 で旧 `mt-1` 相当)
  const computeCoords = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setCoords({ top: rect.bottom + 4, left: rect.left });
  }, []);

  useIsoLayoutEffect(() => {
    if (open) computeCoords();
  }, [open, computeCoords]);

  // 外クリック / ESC でクローズ。Portal 化により menu は trigger の DOM 子孫ではないため、
  // trigger ref と menu ref の **両方** に対して contains チェックが必要。
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      const inTrigger = triggerRef.current?.contains(target) ?? false;
      const inMenu = menuRef.current?.contains(target) ?? false;
      if (!inTrigger && !inMenu) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    // scroll / resize で座標が陳腐化するため close する (再計算は UX で大差なく実装複雑度のみ増)。
    // capture: true で table-container 等の内部スクロールも捕捉。
    function onScrollOrResize() {
      setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
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

  function cancelClose() {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function scheduleClose() {
    cancelClose();
    closeTimerRef.current = setTimeout(() => setOpen(false), 200);
  }

  function handleTriggerEnter() {
    cancelClose();
    setOpen(true);
  }

  return (
    <>
      <div
        className={`relative inline-flex ${className ?? ''}`}
        ref={triggerRef}
        onMouseEnter={handleTriggerEnter}
        onMouseLeave={scheduleClose}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 hover:text-info focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded px-0.5"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuDomId : undefined}
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
      </div>
      {mounted && open && coords && createPortal(
        <ul
          ref={menuRef}
          id={menuDomId}
          role="menu"
          // z-50: dashboard-header (z-40) より前面、Dialog overlay (z-50) と同層。
          // 位置は trigger の bottom + 4px (旧 mt-1 相当)。Portal なので任意祖先の overflow から独立。
          className="fixed z-50 min-w-[120px] rounded-md border bg-card shadow-md"
          style={{ top: coords.top, left: coords.left }}
          data-testid="sortable-header-menu"
          data-column-key={columnKey}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
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
        </ul>,
        document.body,
      )}
    </>
  );
}
