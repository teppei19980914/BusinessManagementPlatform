import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { getProject } from '@/services/project.service';
import { checkMembership } from '@/lib/permissions';
import { ProjectDetailClient } from './project-detail-client';

type Props = {
  params: Promise<{ projectId: string }>;
};

export default async function ProjectDetailPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect('/login');

  const { projectId } = await params;

  // IDOR 防止: メンバーシップ検証
  const membership = await checkMembership(projectId, session.user.id, session.user.systemRole);
  if (!membership.isMember) notFound();

  const project = await getProject(projectId);
  if (!project) notFound();

  return (
    <ProjectDetailClient
      project={project}
      projectRole={membership.projectRole}
      systemRole={session.user.systemRole}
    />
  );
}
