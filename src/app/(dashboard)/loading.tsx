import { Skeleton } from '@/components/ui/skeleton';

/**
 * ダッシュボード配下の全ルートで最低限表示される汎用 loading UI。
 * 個別ルートに loading.tsx が置かれていればそちらが優先される。
 *
 * 目的:
 * - サーバ処理中（auth / DB クエリ）の空白時間を減らし、画面遷移の体感速度を改善
 * - コールドスタート時の TTFB 300-500 ms でもユーザが迷わないよう骨格を即座に表示
 *
 * ref: docs/performance/20260417/after/cold-start-and-data-growth-analysis.md §4.2
 */
export default function DashboardLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-48" />
      <div className="space-y-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-4/6" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    </div>
  );
}
