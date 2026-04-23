import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { getCustomer } from '@/services/customer.service';
import { listProjects } from '@/services/project.service';
import { CustomerDetailClient } from './customer-detail-client';

type Props = { params: Promise<{ customerId: string }> };

/**
 * 顧客詳細画面 (PR #111-2)。
 *
 * - admin のみアクセス可能 (list 画面と同じ方針)
 * - 顧客の全情報 + 紐付く active プロジェクト一覧
 * - 編集はインラインダイアログ (users-client パターン踏襲)
 * - 削除はカスケードダイアログ (active Project の有無で挙動分岐)
 */
export default async function CustomerDetailPage({ params }: Props) {
  const session = await auth();
  if (!session || session.user.systemRole !== 'admin') {
    redirect('/');
  }

  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) notFound();

  // 顧客配下の active Project (論理削除済はカスケードの対象外なので含めない)
  const projects = await listProjects(
    { customerId, limit: 100 },
    session.user.id,
    session.user.systemRole,
  );

  return (
    <CustomerDetailClient
      customer={customer}
      projects={projects.data.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        plannedStartDate: p.plannedStartDate,
        plannedEndDate: p.plannedEndDate,
      }))}
    />
  );
}
