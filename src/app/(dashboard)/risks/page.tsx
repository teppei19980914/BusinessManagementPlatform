import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listAllRisksForViewer } from '@/services/risk.service';
import { AllRisksTable } from './all-risks-table';

/**
 * 全リスク画面 (PR #60 #1: 「全リスク/課題」を「全リスク」「全課題」に分離)。
 * type='risk' のみを抽出表示。
 */
export default async function AllRisksPage() {
  const session = await auth();
  if (!session) redirect('/login');

  const risks = await listAllRisksForViewer(session.user.id, session.user.systemRole);
  const isAdmin = session.user.systemRole === 'admin';
  const filtered = risks.filter((r) => r.type === 'risk');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">全リスク</h2>
        <span className="text-sm text-gray-500">{filtered.length} 件</span>
      </div>
      <AllRisksTable risks={risks} isAdmin={isAdmin} typeFilter="risk" />
    </div>
  );
}
