import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { checkMembership } from '@/lib/permissions';
import { listRisks } from '@/services/risk.service';
import { listMembers } from '@/services/member.service';
import { RisksClient } from './risks-client';

type Props = { params: Promise<{ projectId: string }> };

export default async function RisksPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect('/login');

  const { projectId } = await params;
  const membership = await checkMembership(projectId, session.user.id, session.user.systemRole);
  if (!membership.isMember) notFound();

  const [risks, members] = await Promise.all([
    listRisks(projectId),
    listMembers(projectId),
  ]);

  return (
    <RisksClient
      projectId={projectId}
      risks={risks}
      members={members}
      canEdit={session.user.systemRole === 'admin' || membership.projectRole === 'pm_tl'}
      canCreate={session.user.systemRole === 'admin' || membership.projectRole === 'pm_tl' || membership.projectRole === 'member'}
      systemRole={session.user.systemRole}
    />
  );
}
