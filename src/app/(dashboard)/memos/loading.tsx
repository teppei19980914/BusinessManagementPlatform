import { Skeleton } from '@/components/ui/skeleton';

/**
 * メモ一覧画面の読み込み中 UI。
 * PR-1 perf (2026-05-29): 主要一覧画面の loading.tsx カバレッジを揃える。
 */
export default function MemosLoading() {
  return (
    <div className="space-y-6">
      {/* 2026-06-03: 画面見出し (メモ一覧) を撤去し、ボタン行を右寄せに統一した本体レイアウトに合わせる */}
      <div className="flex items-center justify-end">
        <Skeleton className="h-9 w-80" />
      </div>
      <div className="flex gap-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-9 w-40" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
