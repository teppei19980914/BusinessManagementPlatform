'use client';

/**
 * SortableResizableHead (PR feat/sortable-columns / 2026-05-01)。
 *
 * `ResizableHead` (列リサイズ) + `SortableHeader` (列ソート) を 1 つにまとめたショートカット。
 *
 * 一覧画面で大半の列はリサイズ + ソートの両方を持たせたい。本コンポーネントを使えば
 * `columnKey` の重複指定が不要、呼出側のテンプレートが短くなる。
 *
 *   <SortableResizableHead
 *     columnKey="title"
 *     defaultWidth={220}
 *     label={tRisk('subject')}
 *     sortState={sortState}
 *     onSortChange={setSortColumn}
 *   />
 *
 * チェックボックス列・操作列・添付列など「ソート不可」の列は、従来通り
 * `<ResizableHead columnKey=... defaultWidth=...>{label}</ResizableHead>` を使う。
 */

import { ResizableHead } from '@/components/ui/resizable-columns';
import { SortableHeader } from './sortable-header';
import type { SortDir, SortState } from '@/lib/multi-sort';

type Props = {
  columnKey: string;
  defaultWidth: number;
  label: string;
  sortState: SortState;
  onSortChange: (columnKey: string, dir: SortDir | 'clear') => void;
  /** Resizable 親の className (rare、必要時のみ) */
  className?: string;
};

export function SortableResizableHead({
  columnKey,
  defaultWidth,
  label,
  sortState,
  onSortChange,
  className,
}: Props) {
  return (
    <ResizableHead columnKey={columnKey} defaultWidth={defaultWidth} className={className}>
      <SortableHeader
        columnKey={columnKey}
        label={label}
        sortState={sortState}
        onSortChange={onSortChange}
      />
    </ResizableHead>
  );
}
