/**
 * /settings/tenant/banners/[id]/edit (ADR-0037)
 *
 * テナントバナーの編集画面。tenant_admin 専用。
 * テナント所有権は getTenantBanner の tenantId WHERE で保証する。
 */

import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isTenantAdmin } from '@/lib/permissions';
import { getTenantBanner } from '@/services/tenant-banner.service';
import { TenantBannerForm } from '../../banner-form';

export default async function TenantBannerEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getAuthenticatedUser();
  if ('status' in user) notFound();
  if (!isTenantAdmin(user)) notFound();

  const t = await getTranslations('tenantSettings');
  const { id } = await params;
  const banner = await getTenantBanner(id, user.tenantId);
  if (!banner) notFound();

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t('bannerEditTitle')}</h1>
      <p className="text-sm text-muted-foreground">{t('bannerEditDescription')}</p>
      <TenantBannerForm
        mode="edit"
        bannerId={banner.id}
        initial={{
          message: banner.message,
          severity: banner.severity,
          startAt: banner.startAt,
          endAt: banner.endAt,
          enabled: banner.enabled,
        }}
      />
    </div>
  );
}
