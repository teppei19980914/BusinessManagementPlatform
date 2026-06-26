/**
 * 外部データ移行インポート (ADR-0034) — テナント管理者向け
 *
 * 他PMツール/CSV からの「初回データ移行」を行うウィザード画面。
 *   - 新規作成のみ (重複確認なし)。更新は各「○○一覧」から。
 *   - 対象6エンティティ: 顧客 / プロジェクト / WBS / リスク・課題 / ナレッジ / 振り返り。
 *
 * 認可: admin role 必須 (/settings/tenant 系と整合)。
 */

import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { LOGIN_ROUTE } from '@/config';
import { isTenantAdmin } from '@/lib/permissions';
import { MigrationWizardClient } from './migration-wizard-client';

export const dynamic = 'force-dynamic';

export default async function MigrationImportPage() {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);
  if (!isTenantAdmin(session.user)) redirect('/settings');
  const t = await getTranslations('migrationImport');

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-xl font-bold">{t('pageTitle')}</h1>
        <p className="text-sm text-gray-600">
          {t('descriptionBefore')}<strong>{t('descriptionStrong')}</strong>{t('descriptionAfter')}
        </p>
      </header>

      <div className="rounded border-l-4 border-info bg-info/5 p-4 text-sm">
        <p className="mb-2 font-semibold">{t('instructionsTitle')}</p>
        <ol className="ml-4 list-decimal space-y-1.5 text-xs">
          <li>{t('step1')}</li>
          <li>{t('step2')}</li>
          <li>{t('step3')}</li>
          <li>{t('step4')}</li>
          <li>{t('step5')}</li>
        </ol>
      </div>

      <MigrationWizardClient />
    </div>
  );
}
