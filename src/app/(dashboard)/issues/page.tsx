import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listAllRisksForViewer } from '@/services/risk.service';
import { AllRisksTable } from '../risks/all-risks-table';

/**
 * 全課題画面 (PR #60 #1: 「全リスク/課題」から分離)。
 * type='issue' のみを抽出表示。
 * リスク/課題は同一テーブル (risks_issues) に格納されているため、
 * 共通の listAllRisksForViewer を呼び出し type でフィルタする。
 */
export default async function AllIssuesPage() {
  const session = await auth();
  if (!session) redirect('/login');

  const risks = await listAllRisksForViewer(session.user.id, session.user.systemRole);
  const isAdmin = session.user.systemRole === 'admin';
  const filtered = risks.filter((r) => r.type === 'issue');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">全課題</h2>
        <span className="text-sm text-gray-500">{filtered.length} 件</span>
      </div>
      <AllRisksTable risks={risks} isAdmin={isAdmin} typeFilter="issue" />
    </div>
  );
}
