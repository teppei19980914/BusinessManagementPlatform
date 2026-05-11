import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { prisma } from '@/lib/db';
import { recordError } from '@/services/error-log.service';
import { SettingsClient } from './settings-client';

export default async function SettingsPage() {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  // fix/admin-users-defensive-render 横展開 (2026-05-15): ユーザメニューから到達しやすい
  //   画面のため、DB 取得失敗時に dashboard error.tsx へ飛んで「ログインできない」体験を
  //   引き起こさないよう、prisma.user.findUnique を try/catch で囲い、失敗時は
  //   フォールバック値 + 警告バナーで操作可能 UI を維持する。詳細は admin/users/page.tsx 参照。
  // 注: PR-1 (#327) で User.timezone / locale はテナント単位に集約され、本 select からは除去。
  // `prisma.user.findUnique` の戻り型は select 指定で narrow されるため、
  // 取得結果と同じ shape の型を明示宣言してフォールバック (null) でも代入可能にする。
  type SettingsUser = {
    mfaEnabled: boolean;
    systemRole: string;
    themePreference: string;
  } | null;
  let user: SettingsUser = null;
  let dataLoadError = false;
  try {
    user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        mfaEnabled: true,
        systemRole: true,
        themePreference: true,
      },
    });
  } catch (error) {
    dataLoadError = true;
    await recordError({
      severity: 'error',
      source: 'server',
      message: '[/settings] failed to load user settings',
      stack: error instanceof Error ? error.stack : String(error),
      userId: session.user.id,
      tenantId: session.user.tenantId,
      context: {
        path: '/settings',
        errorName: error instanceof Error ? error.name : 'unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        tenantId: session.user.tenantId,
      },
    });
  }

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
      dataLoadError={dataLoadError}
    />
  );
}
