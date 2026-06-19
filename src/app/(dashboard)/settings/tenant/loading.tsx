import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * /settings/tenant (テナント管理者プラン設定) の loading UI (2026-05-14)
 *
 * 表示時に自テナントのストレージ集計 + ApiCallLog 整合性チェックを実行する。
 */
export default async function TenantSettingsLoading() {
  const t = await getTranslations('tenantSettings');
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <Skeleton className="h-8 w-56" />
      <p className="text-sm text-muted-foreground">
        {t('aggregateLoading')}
      </p>
      <Skeleton className="h-40" />
      <Skeleton className="h-64" />
      <Skeleton className="h-40" />
    </div>
  );
}
