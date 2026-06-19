/**
 * /admin/super/banners (ADR-0036)
 *
 * システム周知バナーの一覧 (履歴) 画面。super_admin 専用 (親 layout でガード)。
 * 全テナントの全ユーザの画面上部に表示する帯メッセージを管理する。表示中は同時 1 本まで。
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { listBanners } from '@/services/system-banner.service';
import { BannersListClient } from './banners-list-client';

export default async function SuperAdminBannersPage() {
  const t = await getTranslations('superAdmin');
  const banners = await listBanners();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('bannersPageTitle')}</h1>
        <Link
          href="/admin/super/banners/new"
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
        >
          {t('bannersPageNewLink')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        {t.rich('bannersPageDescription', { strong: (chunks) => <strong>{chunks}</strong> })}
      </p>
      <BannersListClient banners={banners} />
    </div>
  );
}
