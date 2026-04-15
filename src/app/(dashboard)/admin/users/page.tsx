import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listUsers } from '@/services/user.service';
import { UsersClient } from './users-client';

export default async function UsersPage() {
  const session = await auth();
  if (!session || session.user.systemRole !== 'admin') {
    redirect('/');
  }

  const users = await listUsers();

  return <UsersClient initialUsers={users} />;
}
