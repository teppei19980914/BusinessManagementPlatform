import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listUsers } from '@/services/user.service';
import { getTenantSelfInfo } from '@/services/tenant-self.service';
import { UsersClient } from './users-client';

export default async function UsersPage() {
  const session = await auth();
  if (!session || session.user.systemRole !== 'admin') {
    redirect('/');
  }

  const [users, tenantInfo] = await Promise.all([
    listUsers(),
    // P-2 (2026-05-08): Beginner プラン席数上限の UI ガード用に
    // 現テナントの plan / activeUserCount / beginnerMaxSeats を取得
    getTenantSelfInfo(session.user.tenantId),
  ]);

  return (
    <UsersClient
      initialUsers={users}
      tenantPlan={tenantInfo?.plan ?? 'beginner'}
      activeUserCount={tenantInfo?.activeUserCount ?? 0}
      beginnerMaxSeats={tenantInfo?.beginnerMaxSeats ?? 5}
    />
  );
}
