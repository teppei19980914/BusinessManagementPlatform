import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { DashboardHeader } from '@/components/dashboard-header';
import { LoadingProvider } from '@/components/loading-overlay';
// 2026-04-30 (Task 2): リクエスト成功/失敗を画面下部の帯で通知する共通基盤
import { ToastProvider } from '@/components/toast-provider';
import { LOGIN_ROUTE } from '@/config';
// Q5(3) (2026-05-14): 縮退モード起動時に dashboard 全体で表示する小バナー
import { getDegradedModeState } from '@/services/degraded-mode.service';
import { DegradedModeBanner } from '@/components/degraded-mode-banner';
import type { SystemRole } from '@/config/master-data';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  if (!session) {
    redirect(LOGIN_ROUTE);
  }

  // Q5(3): 縮退モード状態を取得し banner で表示する。
  //   - 取得失敗は許容 (バナー表示は best-effort、画面遷移を妨げない)
  //   - admin / general 双方に共通で表示 (内容は role で出し分けない、リンク先のみ admin/一般で差別)
  const degradedMode = await getDegradedModeState(session.user.tenantId).catch(
    () => null,
  );

  return (
    <LoadingProvider>
      <ToastProvider>
        <div className="min-h-screen bg-muted">
          <DashboardHeader user={session.user} />
          {degradedMode?.active && (
            <DegradedModeBanner
              reason={degradedMode.reason}
              systemRole={session.user.systemRole as SystemRole}
            />
          )}
          {/*
            max-w-7xl は意図的に外している: 画面左右に大きな余白が残ったまま
            一覧テーブルに横スクロールが出るとユーザビリティが下がるため、
            画面いっぱいまで広げて収まるデータを増やし、それでも溢れる分だけ
            テーブル側の overflow-x-auto でスクロールさせる運用。
          */}
          <main className="px-4 py-6 sm:px-6 lg:px-8">{children}</main>
        </div>
      </ToastProvider>
    </LoadingProvider>
  );
}
