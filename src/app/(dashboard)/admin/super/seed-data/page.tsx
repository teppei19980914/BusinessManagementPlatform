/**
 * /admin/super/seed-data (feat/starter-data-import / 2026-06-05)
 *
 * super_admin 向け「スターターデータ キュレーション」画面。
 * スターターデータの取込元 = 管理テナント (MANAGEMENT_TENANT_ID) の Project / Knowledge を一覧し、
 * `isSampleData` (= 各テナントの取込対象に含めるか) を画面から付け外しする。
 *
 * 認可: layout.tsx (super_admin guard) で担保。本ページ自体は再チェック不要。
 * データ取得: server component で service 直接読み (= SSR で完結)。切替は client から PATCH。
 */

import { getTranslations } from 'next-intl/server';
import { listManagementSeedCandidates } from '@/services/sample-curation.service';
import { SeedDataCurationClient } from './seed-data-client';

export const dynamic = 'force-dynamic';

export default async function SeedDataCurationPage() {
  const t = await getTranslations('superAdmin');
  const candidates = await listManagementSeedCandidates();

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">{t('seedDataPageTitle')}</h1>
      <p className="text-sm text-muted-foreground">
        {t.rich('seedDataPageDescription', { strong: (chunks) => <strong>{chunks}</strong> })}
      </p>
      <SeedDataCurationClient initialCandidates={candidates} />
    </div>
  );
}
