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
  const membership = await checkMembership(projectId, session.user.id, session.user.systemRole, session.user.tenantId);
  if (!membership.isMember) notFound();

  // feat/crud-permission-redesign (2026-05-20): 見積タブは PM/TL + admin のみアクセス可。
  //   URL 直打ち防止のため、member/viewer は 404 で弾く (UI=API 一致原則)。
  const canEdit = session.user.systemRole === 'admin' || membership.projectRole === 'pm_tl';
  if (!canEdit) notFound();

  const estimates = await listEstimates(projectId, session.user.tenantId);

  return (
    <EstimatesClient
      projectId={projectId}
      estimates={estimates}
      canEdit={canEdit}
    />
  );
}
