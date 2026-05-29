import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { checkMembership, getActualProjectRole } from '@/lib/permissions';
import { listRetrospectives } from '@/services/retrospective.service';
import { getTenantTodayString } from '@/lib/tenant-time';
import { resolveTimezone } from '@/config/i18n';
import { RetrospectivesClient } from './retrospectives-client';

type Props = { params: Promise<{ projectId: string }> };

export default async function RetrospectivesPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  const { projectId } = await params;
  const membership = await checkMembership(projectId, session.user.id, session.user.systemRole, session.user.tenantId);
  if (!membership.isMember) notFound();

  const [retros, actualRole] = await Promise.all([
    listRetrospectives(projectId, session.user.id, session.user.systemRole, session.user.tenantId),
    getActualProjectRole(projectId, session.user.id),
  ]);
  const canCreate = actualRole === 'pm_tl' || actualRole === 'member';

  // feat/gantt-initial-scroll-and-locale (2026-05-29): conductedDate の form 初期値を tenant TZ ベースで算出。
  //   client 側で new Date().toISOString() を使うと UTC 日付になり、負方向 TZ ユーザで「昨日」が初期値になる罠を防ぐ。
  const today = getTenantTodayString(new Date(), resolveTimezone(session.user.timezone));

  return (
    <RetrospectivesClient
      projectId={projectId}
      retros={retros}
      canCreate={canCreate}
      currentUserId={session.user.id}
      today={today}
    />
  );
}
