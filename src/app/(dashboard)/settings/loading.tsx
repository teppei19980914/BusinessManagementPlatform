import { Skeleton } from '@/components/ui/skeleton';

/**
 * 設定画面 (個人) の読み込み中 UI。
 * PR-1 perf (2026-05-29): 主要画面の loading.tsx カバレッジを揃える。
 */
export default function SettingsLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-7 w-32" />
      <div className="space-y-4 rounded-lg border p-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-3/4" />
      </div>
      <div className="space-y-4 rounded-lg border p-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-9 w-full" />
      </div>
    </div>
  );
}
