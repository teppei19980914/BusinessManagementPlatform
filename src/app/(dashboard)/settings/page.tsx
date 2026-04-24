import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { prisma } from '@/lib/db';
import { SettingsClient } from './settings-client';

export default async function SettingsPage() {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      mfaEnabled: true,
      systemRole: true,
      themePreference: true,
      // PR #119: i18n 設定の初期値として渡す (null = システム既定継承)
      timezone: true,
      locale: true,
    },
  });

  return (
    <SettingsClient
      mfaEnabled={user?.mfaEnabled || false}
      isAdmin={user?.systemRole === 'admin'}
      currentTheme={user?.themePreference ?? 'light'}
      currentTimezone={user?.timezone ?? null}
      currentLocale={user?.locale ?? null}
    />
  );
}
