import { Skeleton } from '@/components/ui/skeleton';

/**
 * /admin/super (super_admin ダッシュボード top) の loading UI (2026-05-14)
 *
 * 表示時に全テナントのストレージ集計 + ApiCallLog 整合性チェックを実行するため、
 * 数秒の待ち時間が発生する。その間「ダッシュボードを集計中…」の skeleton を表示。
 */
export default function SuperAdminDashboardLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-8 w-36" />
      </div>
      <p className="text-sm text-muted-foreground">
        ⏳ 全テナントの DB 容量と API 利用量を集計中… (数秒〜数十秒かかる場合があります)
      </p>

      {/* 4 カラムサマリ */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>

      {/* Default テナントセクション */}
      <Skeleton className="h-48" />

      {/* 各種使用量カード */}
      <Skeleton className="h-32" />
      <Skeleton className="h-32" />
      <Skeleton className="h-32" />

      {/* DB 容量モニタ */}
      <Skeleton className="h-40" />

      {/* Storage TOP10 */}
      <Skeleton className="h-64" />
    </div>
  );
}
