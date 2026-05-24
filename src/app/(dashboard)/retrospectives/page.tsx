import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { listAllRetrospectivesForViewer } from '@/services/retrospective.service';
import { AllRetrospectivesTable } from './all-retrospectives-table';

/**
 * 全振り返り画面。
 * Phase A 要件 6: h2 ページタイトル削除 (ナビタブ名と重複のため)。
 * 2026-05-24 (feat/all-list-section-unification): 件数表示は client (AllRetrospectivesTable) 側に
 *   集約しフィルタ後件数 (filteredRetros.length) を common.itemCount で右寄せ表示する規約に統一。
 */
// PR #425 (2026-05-22) KDD §5.X+102: URL ?keyword= 永続化
type SearchParams = Promise<{ keyword?: string }>;

export default async function AllRetrospectivesPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  const sp = await searchParams;
  const retros = await listAllRetrospectivesForViewer(
    session.user.id,
    session.user.systemRole,
    session.user.tenantId,
  );
  const isAdmin = session.user.systemRole === 'admin';

  return (
    <AllRetrospectivesTable
      retros={retros}
      isAdmin={isAdmin}
      initialKeyword={sp.keyword ?? ''}
    />
  );
}
