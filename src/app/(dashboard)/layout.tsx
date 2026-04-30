import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { DashboardHeader } from '@/components/dashboard-header';
import { LoadingProvider } from '@/components/loading-overlay';
// 2026-04-30 (Task 2): リクエスト成功/失敗を画面下部の帯で通知する共通基盤
import { ToastProvider } from '@/components/toast-provider';
import { LOGIN_ROUTE } from '@/config';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  if (!session) {
    redirect(LOGIN_ROUTE);
  }

  return (
    <LoadingProvider>
      <ToastProvider>
        <div className="min-h-screen bg-muted">
          <DashboardHeader user={session.user} />
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
