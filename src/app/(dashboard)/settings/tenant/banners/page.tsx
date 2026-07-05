/**
 * /settings/tenant/banners (ADR-0037)
 *
 * テナントバナーの一覧 (履歴) 画面。tenant_admin 専用 (自テナントのみ)。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isTenantAdmin } from '@/lib/permissions';
import { listTenantBanners } from '@/services/tenant-banner.service';
import { TenantBannersListClient } from './banners-list-client';

export default async function TenantBannersPage() {
  const user = await getAuthenticatedUser();
  // getAuthenticatedUser returns NextResponse on error; check by duck-typing
  if ('status' in user) notFound();
  if (!isTenantAdmin(user)) notFound();

  const t = await getTranslations('tenantSettings');
  const banners = await listTenantBanners(user.tenantId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('bannersPageTitle')}</h1>
        <Link
          href="/settings/tenant/banners/new"
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
        >
          {t('bannersPageNewLink')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        {t('bannersPageDescription')}
      </p>
      <TenantBannersListClient banners={banners} />
    </div>
  );
}
