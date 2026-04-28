import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { LOGIN_ROUTE } from '@/config';
import { listAllRetrospectivesForViewer } from '@/services/retrospective.service';
import { AllRetrospectivesTable } from './all-retrospectives-table';

export default async function AllRetrospectivesPage() {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  // Phase A 要件 6: h2 ページタイトル削除 (ナビタブ名と重複のため)
  const tCommon = await getTranslations('common');
  const retros = await listAllRetrospectivesForViewer(session.user.id, session.user.systemRole);
  const isAdmin = session.user.systemRole === 'admin';

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <span className="text-sm text-muted-foreground">{tCommon('itemCount', { count: retros.length })}</span>
      </div>
      <AllRetrospectivesTable retros={retros} isAdmin={isAdmin} />
    </div>
  );
}
