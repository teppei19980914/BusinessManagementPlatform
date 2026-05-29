import { Skeleton } from '@/components/ui/skeleton';

/**
 * 顧客一覧画面の読み込み中 UI。
 * PR-1 perf (2026-05-29): 主要一覧画面の loading.tsx カバレッジを揃える。
 */
export default function CustomersLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-9 w-32" />
      </div>
      {/* 検索バー */}
      <div className="flex gap-4">
        <Skeleton className="h-9 w-64" />
      </div>
      {/* テーブル骨格 */}
      <div className="space-y-2 rounded-lg border p-3">
        <Skeleton className="h-8 w-full" />
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
