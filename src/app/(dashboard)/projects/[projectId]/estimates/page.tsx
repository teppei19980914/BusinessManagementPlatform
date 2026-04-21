import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { checkMembership } from '@/lib/permissions';
import { listEstimates } from '@/services/estimate.service';
import { EstimatesClient } from './estimates-client';

type Props = { params: Promise<{ projectId: string }> };

export default async function EstimatesPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  const { projectId } = await params;
  const membership = await checkMembership(projectId, session.user.id, session.user.systemRole);
  if (!membership.isMember) notFound();

  const estimates = await listEstimates(projectId);

  return (
    <EstimatesClient
      projectId={projectId}
      estimates={estimates}
      canEdit={session.user.systemRole === 'admin' || membership.projectRole === 'pm_tl'}
    />
  );
}
