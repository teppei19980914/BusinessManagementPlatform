import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { listAllRisksForViewer } from '@/services/risk.service';
import { AllRisksTable } from '../risks/all-risks-table';

/**
 * 全課題画面 (PR #60 #1: 「全リスク/課題」から分離)。
 * type='issue' のみを抽出表示。
 * リスク/課題は同一テーブル (risks_issues) に格納されているため、
 * 共通の listAllRisksForViewer を呼び出し type でフィルタする。
 *
 * 2026-05-24 (feat/all-list-section-unification): 件数表示は client (AllRisksTable) 側に集約し
 *   フィルタ後件数 (filtered.length) を common.itemCount で右寄せ表示する規約に統一。
 */
// PR #425 (2026-05-22) KDD §5.X+102: URL ?keyword=&state=&priority= 永続化
type SearchParams = Promise<{ keyword?: string; state?: string; priority?: string }>;

export default async function AllIssuesPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  const sp = await searchParams;
  const risks = await listAllRisksForViewer(
    session.user.id,
    session.user.systemRole,
    session.user.tenantId,
  );
  const isAdmin = session.user.systemRole === 'admin';

  return (
    <AllRisksTable
      risks={risks}
      isAdmin={isAdmin}
      typeFilter="issue"
      initialKeyword={sp.keyword ?? ''}
      initialState={sp.state ?? ''}
      initialPriority={sp.priority ?? ''}
    />
  );
}
