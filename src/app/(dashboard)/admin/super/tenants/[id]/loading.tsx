import { Skeleton } from '@/components/ui/skeleton';

/**
 * /admin/super/tenants/[id] (テナント詳細) の loading UI (2026-05-14)
 *
 * 表示時に該当テナントのストレージ集計 + ApiCallLog 整合性チェックを実行する。
 * 1 テナント分なので 1 秒未満で完了するが、TTFB の体感低下を抑える。
 */
export default function SuperAdminTenantDetailLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-2 h-4 w-96" />
      </div>
      <p className="text-sm text-muted-foreground">
        ⏳ DB 容量と API 利用量を集計中…
      </p>

      {/* 詳細カード 3x2 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>

      {/* エンティティ数 */}
      <Skeleton className="h-48" />

      {/* ストレージ + 月次課金 */}
      <Skeleton className="h-40" />
    </div>
  );
}
