import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listAllRisksForViewer } from '@/services/risk.service';
import { AllRisksTable } from './all-risks-table';

/**
 * 全リスク/課題画面 (Req 4 列構成 + Req 9 行クリック編集: PR #56)。
 * サーバコンポーネントでデータ取得、テーブル描画と編集ダイアログは
 * クライアントコンポーネント AllRisksTable に委譲。
 */
export default async function AllRisksPage() {
  const session = await auth();
  if (!session) redirect('/login');

  const risks = await listAllRisksForViewer(session.user.id, session.user.systemRole);
  const isAdmin = session.user.systemRole === 'admin';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">全リスク/課題</h2>
        <span className="text-sm text-gray-500">{risks.length} 件</span>
      </div>
      <AllRisksTable risks={risks} isAdmin={isAdmin} />
    </div>
  );
}
