import { Skeleton } from '@/components/ui/skeleton';

/**
 * テナント横断振り返り一覧画面の読み込み中 UI。
 * PR-1 perf (2026-05-29): 主要一覧画面の loading.tsx カバレッジを揃える。
 */
export default function RetrospectivesLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-32" />
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
