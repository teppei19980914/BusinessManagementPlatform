/**
 * super_admin 専用領域の認可ガード Layout (PR-X2 / 2026-05-07)
 *
 * `/admin/super/*` 配下のすべての画面で super_admin 限定アクセスを強制する。
 * super_admin 以外 (admin / general) がアクセスした場合は `/` へリダイレクト
 * (== Next.js では 403 を返すより redirect 推奨。情報漏洩を最小化)。
 */

import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export default async function SuperAdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session || session.user.systemRole !== 'super_admin') {
    redirect('/');
  }

  return (
    <div className="space-y-6">
      <div className="rounded-md bg-amber-100 p-3 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
        <strong>システム管理者領域</strong> — プラットフォーム運営者専用の画面です。
        全テナント横断の監視・集計が可能です。
      </div>
      <nav className="flex gap-4 border-b pb-2 text-sm">
        <Link href="/admin/super" className="hover:underline">
          サマリ
        </Link>
        <Link href="/admin/super/tenants" className="hover:underline">
          テナント一覧
        </Link>
        <Link href="/admin/super/usage" className="hover:underline">
          使用量サマリ
        </Link>
        <Link href="/admin/super/cron-history" className="hover:underline">
          cron 実行履歴
        </Link>
        {/* PR-V7 #6 (2026-05-19): Stripe DLQ 監視 + 手動再投入 */}
        <Link href="/admin/super/stripe-dlq" className="hover:underline">
          Stripe DLQ
        </Link>
        {/* PR-V7 #8 (2026-05-19): 請求ダッシュボード (= 月次サマリ + 詳細) */}
        <Link href="/admin/super/billing" className="hover:underline">
          請求
        </Link>
      </nav>
      {children}
    </div>
  );
}
