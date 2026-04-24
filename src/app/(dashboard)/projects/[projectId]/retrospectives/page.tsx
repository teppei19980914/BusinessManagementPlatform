import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { checkMembership, getActualProjectRole } from '@/lib/permissions';
import { listRetrospectives } from '@/services/retrospective.service';
import { RetrospectivesClient } from './retrospectives-client';

type Props = { params: Promise<{ projectId: string }> };

export default async function RetrospectivesPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  const { projectId } = await params;
  const membership = await checkMembership(projectId, session.user.id, session.user.systemRole);
  if (!membership.isMember) notFound();

  const [retros, actualRole] = await Promise.all([
    listRetrospectives(projectId, session.user.id, session.user.systemRole),
    getActualProjectRole(projectId, session.user.id),
  ]);
  const canCreate = actualRole === 'pm_tl' || actualRole === 'member';
  const canComment = membership.projectRole === 'pm_tl' || membership.projectRole === 'member';

  return (
    <RetrospectivesClient
      projectId={projectId}
      retros={retros}
      canCreate={canCreate}
      canComment={canComment}
      currentUserId={session.user.id}
    />
  );
}
