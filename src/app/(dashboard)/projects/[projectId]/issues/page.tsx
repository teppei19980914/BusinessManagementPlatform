import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { checkMembership, getActualProjectRole } from '@/lib/permissions';
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

  const [risks, members, actualRole] = await Promise.all([
    listRisks(projectId, session.user.id, session.user.systemRole),
    listMembers(projectId),
    // 2026-04-24: 実際の ProjectMember 判定。admin 短絡なし。
    getActualProjectRole(projectId, session.user.id),
  ]);
  const canCreate = actualRole === 'pm_tl' || actualRole === 'member';

  return (
    <RisksClient
      projectId={projectId}
      risks={risks}
      members={members}
      typeFilter="issue"
      canCreate={canCreate}
      currentUserId={session.user.id}
      systemRole={session.user.systemRole}
    />
  );
}
