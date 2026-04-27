'use client';

/**
 * 一覧テーブルの各列をドラッグでリサイズできるようにする共通機構 (PR #68)。
 *
 * 使い方:
 *   <ResizableColumnsProvider tableKey="all-risks" defaults={{ title: 200, impact: 80 }}>
 *     <ResetColumnsButton /> 任意 (ツールバー等に配置)
 *     <Table>
 *       <TableHeader>
 *         <TableRow>
 *           <ResizableHead columnKey="title">件名</ResizableHead>
 *           <ResizableHead columnKey="impact">影響度</ResizableHead>
 *         </TableRow>
 *       </TableHeader>
 *       <TableBody>...</TableBody>
 *     </Table>
 *   </ResizableColumnsProvider>
 *
 * 永続化:
 *   - sessionStorage に `resizable-cols:<tableKey>` で JSON 保存
 *   - タブを閉じるとデフォルトに戻る (プロジェクト共通の session スコープ方針)
 *
 * DRY (DESIGN.md §21.2):
 *   - ドラッグロジック / sessionStorage 同期 / リセットを 1 箇所に集約
 *   - 各テーブルは columnKey と defaultWidth だけ指定すれば使える
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useSessionState } from '@/lib/use-session-state';

type Widths = Record<string, number>;

type ColumnContextValue = {
  /** 列ごとの現在の幅 (px)。未設定の列は defaultWidth を使う */
  widths: Widths;
  /** ドラッグ中に呼ばれる setter */
  setWidth: (columnKey: string, px: number) => void;
  /** デフォルト幅へリセット (sessionStorage も消去) */
  reset: () => void;
};

const ColumnContext = createContext<ColumnContextValue | null>(null);

function useColumnContext(): ColumnContextValue {
  const ctx = useContext(ColumnContext);
  if (!ctx) {
    // Developer-facing assertion: thrown only when ResizableHead/ResetColumnsButton
    // are used outside ResizableColumnsProvider. Not user-visible at runtime.
    throw new Error(
      'ResizableHead / ResetColumnsButton must be used inside <ResizableColumnsProvider>',
    );
  }
  return ctx;
}

/**
 * テーブル全体を囲う Provider。1 つのテーブルにつき 1 つ配置する。
 *
 * @param tableKey sessionStorage のキー名差別化に使う一意の識別子 (例: 'all-risks')
 */
export function ResizableColumnsProvider({
  tableKey,
  children,
}: {
  tableKey: string;
  children: ReactNode;
}) {
  const storageKey = `resizable-cols:${tableKey}`;
  const [widths, setWidths] = useSessionState<Widths>(storageKey, {});

  const setWidth = useCallback((columnKey: string, px: number) => {
    // 最小 40px (テキストが完全に潰れないため) / 最大 800px (横スクロール暴走防止)
    const clamped = Math.max(40, Math.min(800, px));
    setWidths((prev) => ({ ...prev, [columnKey]: clamped }));
  }, [setWidths]);

  const reset = useCallback(() => {
    setWidths({});
  }, [setWidths]);

  const value = useMemo(() => ({ widths, setWidth, reset }), [widths, setWidth, reset]);

  return <ColumnContext.Provider value={value}>{children}</ColumnContext.Provider>;
}

/**
 * リサイズ可能な th コンポーネント。内部的に <th> + ドラッグハンドルを描画する。
 * 既存の TableHead 相当のスタイルを保つため、className は呼び出し側から継承する。
 *
 * @param columnKey 列を識別する一意名 (同一テーブル内で重複禁止)
 * @param defaultWidth 初回レンダー時の幅 (ユーザがリサイズしていない間に使われる)
 */
export function ResizableHead({
  columnKey,
  defaultWidth,
  className,
  children,
  ...thProps
}: {
  columnKey: string;
  /** 初回レンダーで使う幅 (px)。ユーザがリサイズすると sessionStorage 側が優先される */
  defaultWidth: number;
  className?: string;
  children: ReactNode;
} & Omit<React.ThHTMLAttributes<HTMLTableCellElement>, 'children' | 'className'>) {
  const { widths, setWidth } = useColumnContext();
  const width = widths[columnKey] ?? defaultWidth;
  const thRef = useRef<HTMLTableCellElement | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = thRef.current?.getBoundingClientRect().width ?? width;

    function onMove(ev: MouseEvent) {
      const delta = ev.clientX - startX;
      setWidth(columnKey, startWidth + delta);
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [columnKey, setWidth, width]);

  // 既存 TableHead と同じベーススタイルを踏襲しつつ、relative + overflow-hidden を追加。
  // ドラッグハンドルは絶対配置の細い縦線として右端に置く。
  const baseClass
    = 'relative h-8 px-1.5 md:h-10 md:px-2 text-left align-middle font-medium text-foreground '
    + 'overflow-hidden whitespace-nowrap';
  return (
    <th
      {...thProps}
      ref={thRef}
      data-slot="resizable-head"
      style={{ width, minWidth: width, maxWidth: width, ...thProps.style }}
      className={`${baseClass}${className ? ` ${className}` : ''}`}
    >
      <div className="truncate pr-2">{children}</div>
      {/*
        ドラッグハンドル: 視覚的には透明、hover / active で青色を出して掴める場所を示す。
        クリック判定を広げるため幅 6px を確保 (小さすぎると操作困難)。
      */}
      <div
        onMouseDown={onMouseDown}
        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none hover:bg-info/40 active:bg-info"
        role="separator"
        aria-orientation="vertical"
        aria-label={`列の幅を変更`}
      />
    </th>
  );
}

/**
 * 列幅リセットボタン。ツールバー等に配置する想定。
 * Provider 未設定の場合に呼ばれるとコンテキストエラーになるため、テーブル外に置く際は
 * ラップする工夫が必要 (通常は Provider 内のヘッダ近くに置く)。
 */
export function ResetColumnsButton({
  label,
  className,
}: {
  label?: string;
  className?: string;
}) {
  const { reset } = useColumnContext();
  const t = useTranslations('common');
  return (
    <Button variant="outline" size="sm" onClick={reset} className={className}>
      {label ?? t('resetColumnWidths')}
    </Button>
  );
}
