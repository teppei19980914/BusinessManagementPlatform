import { Skeleton } from '@/components/ui/skeleton';

/**
 * プロジェクト一覧画面の読み込み中 UI。
 * 検索欄とテーブル骨格を即座に表示。
 */
export default function ProjectsLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-9 w-40" />
      </div>
      {/* 検索バー */}
      <div className="flex gap-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-20" />
      </div>
      {/* テーブル骨格（ヘッダー + 5 行分）*/}
      <div className="space-y-2 rounded-lg border p-3">
        <Skeleton className="h-8 w-full" />
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
