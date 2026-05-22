/**
 * /customers - 顧客一覧画面 (テナント管理者 + システム管理者) — PR #111-1
 *
 * 認可:
 *   テナント管理者 (systemRole='admin') と システム管理者 (systemRole='super_admin') が閲覧可能。
 *   それ以外は `/` へリダイレクト。
 *
 * 2026-05-14: super_admin にも開放 (管理テナントのシード Customer を本画面で CRUD する)。
 *   super_admin の tenantId は MANAGEMENT_TENANT_ID なので、サービス層は変更不要 —
 *   `listCustomers(session.user.tenantId)` がそのまま管理テナントの Customer を返す。
 *
 * 配置:
 *   /admin 配下ではなくトップレベル /customers に配置 (RELEASE 判断: PR #111 論点 5)。
 */

import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listCustomers } from '@/services/customer.service';
import { isAdminOrAbove } from '@/lib/permissions/role';
import { CustomersClient } from './customers-client';

/**
 * PR #425 (2026-05-22) KDD §5.X+102 Phase: URL 永続化対応。
 *   searchParams.keyword を Client Component に渡し、リロード / 共有時に
 *   検索条件が復元されるようにする。listCustomers のシグネチャは変更せず
 *   (= client-side filter で対応、件数が増えた際は別 PR で server-side 化)。
 */
type SearchParams = Promise<{ keyword?: string }>;

export default async function CustomersPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await auth();
  if (!session || !isAdminOrAbove(session.user)) {
    redirect('/');
  }

  const sp = await searchParams;
  const customers = await listCustomers(session.user.tenantId);

  return <CustomersClient initialCustomers={customers} initialKeyword={sp.keyword ?? ''} />;
}
