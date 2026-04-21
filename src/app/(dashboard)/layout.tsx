import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { DashboardHeader } from '@/components/dashboard-header';
import { LoadingProvider } from '@/components/loading-overlay';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  if (!session) {
    redirect('/login');
  }

  return (
    <LoadingProvider>
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
    </LoadingProvider>
  );
}
