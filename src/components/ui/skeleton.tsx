import { cn } from '@/lib/utils';

/**
 * データ読み込み中のプレースホルダ表示。
 * Tailwind の animate-pulse + 薄い灰色背景で「内容がここに入る」ことを示す。
 *
 * 利用箇所: 各ルートの loading.tsx、Suspense fallback
 *
 * ref: docs/performance/20260417/after/cold-start-and-data-growth-analysis.md §4.2
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      data-slot="skeleton"
      className={cn('animate-pulse rounded-md bg-accent', className)}
      {...props}
    />
  );
}
