'use client';

/**
 * FilterBar (Phase E 要件 1〜3 / 共通部品化, 2026-04-29):
 *
 * 「`<div className="rounded-md border bg-muted/30 p-3">` + 任意タイトル + フィルタ入力グリッド」
 * という見た目だけが共通する shell コンポーネント。
 *
 * 元の繰り返し箇所:
 *   - risks-client.tsx (project-scoped Risk/Issue 一覧)
 *   - all-retrospectives-table.tsx
 *   - all-risks-table.tsx
 *   - cross-list-bulk-visibility-toolbar.tsx (こちらは独立 toolbar 部品で別途維持)
 *
 * 設計判断:
 *   - 内側の入力欄 (キーワード input / 状態 select 等) は画面ごとに異なる軸を持つため
 *     **slot として children に注入する** 方式とし、shell だけを共通化。
 *   - タイトル ("フィルター" 等) は省略可能 (一部画面はタイトル無しで直接 grid)。
 *   - mb-3 や下マージンは呼出側で `className` から指定 (レイアウトの自由度を確保)。
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Props = {
  /** 見出し ("フィルター" / "Filter")。省略時はタイトル行を表示しない */
  title?: ReactNode;
  /** 余白等の追加 className (例: 'mb-3') */
  className?: string;
  children: ReactNode;
};

export function FilterBar({ title, className, children }: Props) {
  return (
    <div className={cn('rounded-md border bg-muted/30 p-3', className)}>
      {title != null && (
        <div className="mb-2 flex items-center gap-2">
          <span className="text-sm font-medium">{title}</span>
        </div>
      )}
      {children}
    </div>
  );
}
