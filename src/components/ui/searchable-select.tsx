'use client';

/**
 * SearchableSelect — 項目数が多い / 多くなる可能性がある Select の代替コンポーネント (PR #126)。
 *
 * 設計方針:
 *   - Base UI Combobox (`@base-ui/react/combobox`) ベース
 *   - **検索欄は項目数が viewport サイズに応じて「スクロールが必要」と判断された場合のみ表示**
 *     (しきい値 = viewport 高さの 50% に収まる項目数を動的算出)
 *   - 項目数が少ない場合は通常の Select と同じ体験 (検索欄なし)
 *
 * セキュリティ:
 *   - フィルタは `String.prototype.includes()` ベース (ReDoS 回避、ユーザ入力を regex に渡さない)
 *   - label は JSX テキストノード (React 自動エスケープで XSS 耐性)
 *   - value / label の型制約で object 展開による prototype pollution 経路なし
 *
 * 使い方:
 *   <SearchableSelect
 *     value={userId}
 *     onValueChange={setUserId}
 *     options={users.map((u) => ({ value: u.id, label: `${u.name}（${u.email}）` }))}
 *     placeholder="ユーザを選択..."
 *   />
 *
 * 既存の `<Select>` (固定件数のステータス・優先度等) は現状維持。
 * 本コンポーネントは **件数が多い / 増える予定** の箇所 (ユーザ / メンバー / 顧客選択等) に限定採用。
 */

import * as React from 'react';
import { Combobox } from '@base-ui/react/combobox';
import { ChevronDownIcon, CheckIcon, SearchIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/** ドロップダウン 1 項目の推定高さ (px)。しきい値の動的算出に使用。 */
const ITEM_HEIGHT_PX = 36;

/** Viewport 高さに対するドロップダウン最大占有率 (%)。これを超えると検索欄を表示する。 */
const VIEWPORT_RATIO = 0.5;

/** フォールバック (SSR 時 / window 未定義時) の閾値。この件数を超えると検索欄を表示。 */
const FALLBACK_THRESHOLD = 10;

export type SearchableSelectOption = {
  /** 内部値 (onValueChange で渡される) */
  value: string;
  /** 表示ラベル (フィルタ対象文字列。日本語・英語の混在可) */
  label: string;
  /** true で選択不可 (disabled 表示) */
  disabled?: boolean;
};

export type SearchableSelectProps = {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SearchableSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  /** aria-label for accessibility (label ラッピングが無い場合) */
  'aria-label'?: string;
  className?: string;
};

/**
 * 現在の viewport 高さから「スクロールが必要と判断する項目数しきい値」を算出する。
 * SSR 時 / window 未定義時は FALLBACK_THRESHOLD を返す。
 */
function computeThreshold(): number {
  if (typeof window === 'undefined') return FALLBACK_THRESHOLD;
  const threshold = Math.floor((window.innerHeight * VIEWPORT_RATIO) / ITEM_HEIGHT_PX);
  // 極端に小さいビューポートでも最低 6 件までは検索欄なしで表示
  return Math.max(6, threshold);
}

export function SearchableSelect({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  id,
  'aria-label': ariaLabel,
  className,
}: SearchableSelectProps) {
  // SSR 安全: 初回は FALLBACK で判定、mount 後に viewport 実測値で再計算
  const [threshold, setThreshold] = React.useState<number>(FALLBACK_THRESHOLD);

  React.useEffect(() => {
    const update = () => setThreshold(computeThreshold());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const searchVisible = options.length > threshold;

  return (
    <Combobox.Root
      items={options}
      value={value}
      onValueChange={(v) => {
        if (typeof v === 'string') onValueChange(v);
      }}
      disabled={disabled}
      // label / value の key から item を解決 (options が { value, label } 形式なので自動認識)
    >
      <Combobox.Input
        id={id}
        aria-label={ariaLabel}
        placeholder={placeholder}
        // トリガーと入力欄を統合した見た目 (通常の Select 風)。
        // 検索欄を別で出す場合は readOnly にして絞り込みを popup 内に委譲する。
        readOnly={!searchVisible}
        className={cn(
          'flex h-9 w-full items-center justify-between rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors',
          'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'placeholder:text-muted-foreground',
          'dark:bg-input/30 dark:hover:bg-input/50',
          className,
        )}
      />
      <Combobox.Trigger
        aria-label={ariaLabel ? `${ariaLabel} (展開)` : '展開'}
        className="pointer-events-none absolute"
      >
        <ChevronDownIcon className="size-4 text-muted-foreground" />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner className="isolate z-50" sideOffset={4}>
          <Combobox.Popup
            className={cn(
              'relative isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-36',
              'overflow-x-hidden overflow-y-auto rounded-lg bg-popover text-popover-foreground',
              'shadow-md ring-1 ring-foreground/10 duration-100',
              'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95',
              'data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
            )}
          >
            {searchVisible && (
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-popover px-2 py-1.5">
                <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                {/*
                  PR #126: フィルタ入力。Combobox.Root が filter を内部で提供するため、
                  この input は Combobox.Input の別インスタンスではなく、popup 内の
                  視覚的な "表示" のみ。実際のフィルタは上部の Combobox.Input が担当。
                  ただし Base UI では input 1 個のみが filter トリガーになるため、
                  ここは視覚的な案内に留め、実入力はトリガー input 側で受ける設計にする。
                */}
                <span className="text-xs text-muted-foreground">上の入力欄で絞り込めます</span>
              </div>
            )}
            <Combobox.List className="p-1">
              {(option: SearchableSelectOption) => (
                <Combobox.Item
                  key={option.value}
                  value={option}
                  disabled={option.disabled}
                  className={cn(
                    'relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5',
                    'text-sm outline-hidden select-none',
                    'focus:bg-accent focus:text-accent-foreground',
                    'data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
                    'data-disabled:pointer-events-none data-disabled:opacity-50',
                  )}
                >
                  <Combobox.ItemIndicator
                    render={
                      <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
                    }
                  >
                    <CheckIcon className="pointer-events-none size-4" />
                  </Combobox.ItemIndicator>
                  {option.label}
                </Combobox.Item>
              )}
            </Combobox.List>
            <Combobox.Empty className="px-3 py-4 text-center text-sm text-muted-foreground">
              該当なし
            </Combobox.Empty>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
