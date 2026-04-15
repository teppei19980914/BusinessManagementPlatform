import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';

export default async function DashboardPage() {
  const session = await auth();

  if (!session) {
    redirect('/login');
  }

  return (
    <div>
      <h2 className="text-xl font-semibold">ダッシュボード</h2>
      <p className="mt-2 text-gray-600">
        ようこそ、{session.user.name} さん。プロジェクト一覧は次のタスクで実装予定です。
      </p>
    </div>
  );
}
