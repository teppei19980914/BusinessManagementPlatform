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

  // 2026-05-09 (#11): MFA 強制対象を super_admin のみに限定。
  //   旧仕様 (PR #91) はテナント管理者 (admin) も強制有効化していたが、運用負荷の
  //   観点から任意化。`isAdmin` は MFA UI 上「強制有効化バッジ + 解除ボタン非表示」を
  //   出す条件であり、新仕様ではこれを super_admin に対してのみ true にする。
  const isMfaForced = user?.systemRole === 'super_admin';

  return (
    <SettingsClient
      mfaEnabled={user?.mfaEnabled || false}
      isAdmin={isMfaForced}
      currentTheme={user?.themePreference ?? 'light'}
      currentTimezone={user?.timezone ?? null}
      currentLocale={user?.locale ?? null}
    />
  );
}
