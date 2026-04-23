/**
 * /customers - 顧客一覧画面 (システム管理者限定) — PR #111-1
 *
 * 認可:
 *   システム管理者 (systemRole='admin') のみ閲覧可能。
 *   admin 以外がアクセスした場合は `/` へリダイレクト。
 *
 * 配置:
 *   /admin 配下ではなくトップレベル /customers に配置 (RELEASE 判断: PR #111 論点 5)。
 *   将来的に admin 以外の閲覧権限付与を検討する余地を残すため。
 *   ただし現在は admin のみに制限。
 */

import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listCustomers } from '@/services/customer.service';
import { CustomersClient } from './customers-client';

export default async function CustomersPage() {
  const session = await auth();
  if (!session || session.user.systemRole !== 'admin') {
    redirect('/');
  }

  const customers = await listCustomers();

  return <CustomersClient initialCustomers={customers} />;
}
