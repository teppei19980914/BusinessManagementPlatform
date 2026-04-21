import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { checkMembership } from '@/lib/permissions';
import { listRisks } from '@/services/risk.service';
import { listMembers } from '@/services/member.service';
import { RisksClient } from '../risks/risks-client';

type Props = { params: Promise<{ projectId: string }> };

/**
 * プロジェクト詳細 - 課題一覧ページ (PR #60 #1: リスクと分離)。
 * 同じ RisksClient を typeFilter='issue' で再利用する。
 */
export default async function IssuesPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  const { projectId } = await params;
  const membership = await checkMembership(projectId, session.user.id, session.user.systemRole);
  if (!membership.isMember) notFound();

  const [risks, members] = await Promise.all([
    listRisks(projectId, session.user.id, session.user.systemRole),
    listMembers(projectId),
  ]);

  return (
    <RisksClient
      projectId={projectId}
      risks={risks}
      members={members}
      typeFilter="issue"
      canEdit={session.user.systemRole === 'admin' || membership.projectRole === 'pm_tl'}
      canCreate={session.user.systemRole === 'admin' || membership.projectRole === 'pm_tl' || membership.projectRole === 'member'}
      systemRole={session.user.systemRole}
    />
  );
}
