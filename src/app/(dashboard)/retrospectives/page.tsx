import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { LOGIN_ROUTE } from '@/config';
import { listAllRetrospectivesForViewer } from '@/services/retrospective.service';
import { AllRetrospectivesTable } from './all-retrospectives-table';

export default async function AllRetrospectivesPage() {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  const tNav = await getTranslations('nav');
  const tCommon = await getTranslations('common');
  const retros = await listAllRetrospectivesForViewer(session.user.id, session.user.systemRole);
  const isAdmin = session.user.systemRole === 'admin';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{tNav('allRetrospectives')}</h2>
        <span className="text-sm text-muted-foreground">{tCommon('itemCount', { count: retros.length })}</span>
      </div>
      <AllRetrospectivesTable retros={retros} isAdmin={isAdmin} />
    </div>
  );
}
