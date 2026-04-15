import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { SettingsClient } from './settings-client';

export default async function SettingsPage() {
  const session = await auth();
  if (!session) redirect('/login');

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { mfaEnabled: true, systemRole: true },
  });

  return (
    <SettingsClient
      mfaEnabled={user?.mfaEnabled || false}
      isAdmin={user?.systemRole === 'admin'}
    />
  );
}
