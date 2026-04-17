import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { getProject } from '@/services/project.service';
import { checkMembership } from '@/lib/permissions';
import { ProjectDetailClient } from './project-detail-client';

type Props = {
  params: Promise<{ projectId: string }>;
};

/**
 * プロジェクト詳細画面の Server Component。
 *
 * 【設計方針（2026-04-17 以降）】
 * 概要タブで必要な「プロジェクト基本情報」と「権限判定結果」のみサーバで取得し、
 * 他タブ（WBS・ガント・リスク・振り返り・見積もり・メンバー・ナレッジ）のデータは
 * クライアント側でタブ切替時に遅延取得する（ProjectDetailClient 内の useLazyFetch）。
 *
 * ref: docs/performance/20260417/after/cold-start-and-data-growth-analysis.md §4.2
 */
export default async function ProjectDetailPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect('/login');

  const { projectId } = await params;

  // 認可チェックと project 取得は並列化（互いに依存しない）
  const [membership, project] = await Promise.all([
    checkMembership(projectId, session.user.id, session.user.systemRole),
    getProject(projectId),
  ]);

  if (!membership.isMember) notFound();
  if (!project) notFound();

  const canEdit = session.user.systemRole === 'admin' || membership.projectRole === 'pm_tl';
  const canCreate =
    session.user.systemRole === 'admin'
    || membership.projectRole === 'pm_tl'
    || membership.projectRole === 'member';

  return (
    <ProjectDetailClient
      project={project}
      projectRole={membership.projectRole}
      systemRole={session.user.systemRole}
      userId={session.user.id}
      canEdit={canEdit}
      canCreate={canCreate}
    />
  );
}
