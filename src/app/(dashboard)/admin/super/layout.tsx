/**
 * super_admin 専用領域の認可ガード Layout (PR-X2 / 2026-05-07)
 *
 * `/admin/super/*` 配下のすべての画面で super_admin 限定アクセスを強制する。
 * super_admin 以外 (admin / general) がアクセスした場合は `/` へリダイレクト
 * (== Next.js では 403 を返すより redirect 推奨。情報漏洩を最小化)。
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAuthForLayout } from '@/lib/page-auth';

export default async function SuperAdminLayout({ children }: { children: React.ReactNode }) {
  // fix/session-clearance (2026-05-20): 親 dashboard layout 同様、tokenVersion 検証付きヘルパに切替。
  //   role check は本層の責務として残す (= 親で認証検証 / 本層で role 検証の二段構え)。
  const user = await requireAuthForLayout();
  if (user.systemRole !== 'super_admin') {
    redirect('/');
  }
  const t = await getTranslations('superAdmin');

  return (
    <div className="space-y-6">
      <div className="rounded-md bg-amber-100 p-3 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
        <strong>{t('layoutBannerBold')}</strong>{t('layoutBannerBody')}
      </div>
      <nav className="flex gap-4 border-b pb-2 text-sm">
        <Link href="/admin/super" className="hover:underline">
          {t('layoutNavSummary')}
        </Link>
        <Link href="/admin/super/tenants" className="hover:underline">
          {t('layoutNavTenants')}
        </Link>
        <Link href="/admin/super/usage" className="hover:underline">
          {t('layoutNavUsage')}
        </Link>
        <Link href="/admin/super/cron-history" className="hover:underline">
          {t('layoutNavCronHistory')}
        </Link>
        {/* PR-V7 #6 (2026-05-19): Stripe DLQ 監視 + 手動再投入 */}
        <Link href="/admin/super/stripe-dlq" className="hover:underline">
          {t('layoutNavStripeDlq')}
        </Link>
        {/* PR-V7 #8 (2026-05-19): 請求ダッシュボード (= 月次サマリ + 詳細) */}
        <Link href="/admin/super/billing" className="hover:underline">
          {t('layoutNavBilling')}
        </Link>
        {/* PR-V8 (2026-05-19): 診断ダッシュボード (= 想定外事象の検知 + 修復) */}
        <Link href="/admin/super/diagnostics" className="hover:underline">
          {t('layoutNavDiagnostics')}
        </Link>
        {/* ADR-0036: 全ユーザ共通の周知バナー (画面上部の帯メッセージ) 管理 */}
        <Link href="/admin/super/banners" className="hover:underline">
          {t('layoutNavBanners')}
        </Link>
      </nav>
      {children}
    </div>
  );
}
