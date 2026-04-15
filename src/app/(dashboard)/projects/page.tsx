import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listProjects } from '@/services/project.service';
import { ProjectsClient } from './projects-client';

export default async function ProjectsPage() {
  const session = await auth();
  if (!session) redirect('/login');

  const result = await listProjects(
    { page: 1, limit: 20 },
    session.user.id,
    session.user.systemRole,
  );

  return (
    <ProjectsClient
      initialProjects={result.data}
      initialTotal={result.total}
      isAdmin={session.user.systemRole === 'admin'}
    />
  );
}
