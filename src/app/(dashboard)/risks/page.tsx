import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { listAllRisksForViewer } from '@/services/risk.service';
import { AllRisksTable } from './all-risks-table';

/**
 * 全リスク画面 (PR #60 #1: 「全リスク/課題」を「全リスク」「全課題」に分離)。
 * type='risk' のみを抽出表示。
 *
 * 2026-04-28 (Phase A 要件 6): h2 ページタイトルはナビタブ名と重複するため削除。
 * 2026-05-24 (feat/all-list-section-unification): 件数表示は client (AllRisksTable) 側に集約し
 *   フィルタ後件数 (filtered.length) を common.itemCount で右寄せ表示する規約に統一。
 */
// PR #425 (2026-05-22) KDD §5.X+102: URL ?keyword=&state=&priority= 永続化
type SearchParams = Promise<{ keyword?: string; state?: string; priority?: string }>;

export default async function AllRisksPage({ searchParams }: { searchParams: SearchParams }) {
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
      typeFilter="risk"
      initialKeyword={sp.keyword ?? ''}
      initialState={sp.state ?? ''}
      initialPriority={sp.priority ?? ''}
    />
  );
}
