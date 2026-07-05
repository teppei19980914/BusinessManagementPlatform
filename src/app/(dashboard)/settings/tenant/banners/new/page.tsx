/**
 * /settings/tenant/banners/new (ADR-0037)
 *
 * テナントバナーの新規作成画面。tenant_admin 専用。
 * `?from=<id>` 付きで開くと、そのバナーの内容・緊急度・期間を複製して prefill する。
 */

import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isTenantAdmin } from '@/lib/permissions';
import { getTenantBanner } from '@/services/tenant-banner.service';
import { TenantBannerForm, type TenantBannerFormInitial } from '../banner-form';

export default async function TenantBannerNewPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const user = await getAuthenticatedUser();
  if ('status' in user) notFound();
  if (!isTenantAdmin(user)) notFound();

  const t = await getTranslations('tenantSettings');
  const { from } = await searchParams;

  let initial: TenantBannerFormInitial | undefined;
  if (from) {
    // テナント所有権を確認してから複製 (他テナントの ID が渡されても null が返る)
    const source = await getTenantBanner(from, user.tenantId);
    if (source) {
      initial = {
        message: source.message,
        severity: source.severity,
        startAt: source.startAt,
        endAt: source.endAt,
        enabled: true,
      };
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">
        {from && initial ? t('bannerNewDuplicate') : t('bannerNewTitle')}
      </h1>
      <p className="text-sm text-muted-foreground">{t('bannerNewDescription')}</p>
      <TenantBannerForm mode="create" initial={initial} />
    </div>
  );
}
