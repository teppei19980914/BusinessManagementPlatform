import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { listProjects } from '@/services/project.service';
import { listCustomers } from '@/services/customer.service';
import { ProjectsClient } from './projects-client';

export default async function ProjectsPage() {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  const [result, customers] = await Promise.all([
    listProjects(
      { page: 1, limit: 20 },
      session.user.id,
      session.user.systemRole,
    ),
    // PR #111-2: 新規作成ダイアログの顧客セレクト用
    listCustomers(),
  ]);

  return (
    <ProjectsClient
      initialProjects={result.data}
      initialTotal={result.total}
      isAdmin={session.user.systemRole === 'admin'}
      customers={customers.map((c) => ({ id: c.id, name: c.name }))}
    />
  );
}
