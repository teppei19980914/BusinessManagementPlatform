import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { checkMembership } from '@/lib/permissions';
import { listRetrospectives } from '@/services/retrospective.service';
import { RetrospectivesClient } from './retrospectives-client';

type Props = { params: Promise<{ projectId: string }> };

export default async function RetrospectivesPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect('/login');

  const { projectId } = await params;
  const membership = await checkMembership(projectId, session.user.id, session.user.systemRole);
  if (!membership.isMember) notFound();

  const retros = await listRetrospectives(projectId);

  return (
    <RetrospectivesClient
      projectId={projectId}
      retros={retros}
      canEdit={session.user.systemRole === 'admin' || membership.projectRole === 'pm_tl'}
      canComment={session.user.systemRole === 'admin' || membership.projectRole === 'pm_tl' || membership.projectRole === 'member'}
    />
  );
}
