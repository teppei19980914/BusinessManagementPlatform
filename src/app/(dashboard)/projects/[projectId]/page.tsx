import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { getProject } from '@/services/project.service';
import { checkMembership } from '@/lib/permissions';
import { listEstimates } from '@/services/estimate.service';
import { listTasks } from '@/services/task.service';
import { listTasksFlat } from '@/services/task.service';
import { listRisks } from '@/services/risk.service';
import { listRetrospectives } from '@/services/retrospective.service';
import { listMembers } from '@/services/member.service';
import { listKnowledge } from '@/services/knowledge.service';
import { listUsers } from '@/services/user.service';
import { prisma } from '@/lib/db';
import { ProjectDetailClient } from './project-detail-client';

type Props = {
  params: Promise<{ projectId: string }>;
};

export default async function ProjectDetailPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect('/login');

  const { projectId } = await params;

  const membership = await checkMembership(projectId, session.user.id, session.user.systemRole);
  if (!membership.isMember) notFound();

  const project = await getProject(projectId);
  if (!project) notFound();

  const canEdit = session.user.systemRole === 'admin' || membership.projectRole === 'pm_tl';
  const canCreate = session.user.systemRole === 'admin' || membership.projectRole === 'pm_tl' || membership.projectRole === 'member';

  const isAdmin = session.user.systemRole === 'admin';

  // 全タブのデータを並列取得
  const [estimates, tasks, tasksFlat, risks, retros, members, knowledgeResult, allUsers, allProjectsRaw] = await Promise.all([
    canEdit ? listEstimates(projectId) : Promise.resolve([]),
    listTasks(projectId),
    listTasksFlat(projectId),
    listRisks(projectId),
    listRetrospectives(projectId),
    listMembers(projectId),
    listKnowledge({ page: 1, limit: 100 }, session.user.id, session.user.systemRole),
    isAdmin ? listUsers() : Promise.resolve([]),
    canEdit ? prisma.project.findMany({ where: { deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) : Promise.resolve([]),
  ]);
  const allProjects = allProjectsRaw.map((p) => ({ id: p.id, name: p.name }));

  return (
    <ProjectDetailClient
      project={project}
      projectRole={membership.projectRole}
      systemRole={session.user.systemRole}
      userId={session.user.id}
      estimates={estimates}
      tasks={tasks}
      tasksFlat={tasksFlat}
      risks={risks}
      retros={retros}
      members={members}
      allUsers={allUsers}
      allProjects={allProjects}
      knowledges={knowledgeResult.data}
      canEdit={canEdit}
      canCreate={canCreate}
    />
  );
}
