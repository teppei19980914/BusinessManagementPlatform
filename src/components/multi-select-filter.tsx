'use client';

import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { Button } from '@/components/ui/button';

export type MultiSelectOption = {
  value: string;
  label: string;
  /** 選択肢の補足ラベル (例: "(未アサイン)") */
  muted?: boolean;
};

type Props = {
  label: string;
  options: MultiSelectOption[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  /** すべて選択済みかどうか (ラベル表示と「フィルタ解除」ボタン表示に使う) */
  isAllSelected: boolean;
  /** 「全X中の Y 個選択中」のラベル文言 (selected / total) */
  allLabel?: string;
};

/**
 * タスク系画面 (マイタスク/WBS/ガント) で共通利用する複数選択フィルタ (PR #61)。
 * 担当者フィルタ / 状況フィルタの重複実装を排除する。
 */
export function MultiSelectFilter({
  label,
  options,
  selected,
  onToggle,
  onSelectAll,
  onClearAll,
  isAllSelected,
  allLabel = '全て',
}: Props) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger render={<Button variant="outline" size="sm" />}>
        {label}: {isAllSelected ? allLabel : `${selected.size} / ${options.length}`}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner sideOffset={6} align="start" className="isolate z-50">
          <PopoverPrimitive.Popup
            className="max-h-[60vh] w-64 overflow-y-auto rounded-lg border bg-white p-2 shadow-md ring-1 ring-black/5 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          >
            <div className="flex gap-2 border-b pb-2">
              <Button type="button" variant="outline" size="sm" className="flex-1" onClick={onSelectAll}>
                すべて選択
              </Button>
              <Button type="button" variant="outline" size="sm" className="flex-1" onClick={onClearAll}>
                すべて解除
              </Button>
            </div>
            <div className="mt-2 space-y-1">
              {options.map((o) => (
                <label
                  key={o.value}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-gray-50"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(o.value)}
                    onChange={() => onToggle(o.value)}
                    className="rounded"
                  />
                  <span className={o.muted ? 'truncate text-gray-500' : 'truncate'}>
                    {o.label}
                  </span>
                </label>
              ))}
            </div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
