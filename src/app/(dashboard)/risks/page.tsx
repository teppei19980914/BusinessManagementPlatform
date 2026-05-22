import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { LOGIN_ROUTE } from '@/config';
import { listAllRisksForViewer } from '@/services/risk.service';
import { AllRisksTable } from './all-risks-table';

/**
 * 全リスク画面 (PR #60 #1: 「全リスク/課題」を「全リスク」「全課題」に分離)。
 * type='risk' のみを抽出表示。
 *
 * 2026-04-28 (Phase A 要件 6): h2 ページタイトルはナビタブ名と重複するため削除、
 * 件数表示のみ右寄せで表示する。
 */
// PR #425 (2026-05-22) KDD §5.X+102: URL ?keyword=&state=&priority= 永続化
type SearchParams = Promise<{ keyword?: string; state?: string; priority?: string }>;

export default async function AllRisksPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  const tCommon = await getTranslations('common');
  const sp = await searchParams;
  const risks = await listAllRisksForViewer(
    session.user.id,
    session.user.systemRole,
    session.user.tenantId,
  );
  const isAdmin = session.user.systemRole === 'admin';
  const filtered = risks.filter((r) => r.type === 'risk');

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <span className="text-sm text-muted-foreground">{tCommon('itemCount', { count: filtered.length })}</span>
      </div>
      <AllRisksTable
        risks={risks}
        isAdmin={isAdmin}
        typeFilter="risk"
        initialKeyword={sp.keyword ?? ''}
        initialState={sp.state ?? ''}
        initialPriority={sp.priority ?? ''}
      />
    </div>
  );
}
