import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { listMyTaskProjects } from '@/services/task.service';
import { MyTasksClient } from './my-tasks-client';

/**
 * マイタスク画面 (Req 2 リデザイン: PR #57)。
 *
 * 変更前: 全担当 ACT の単一テーブル (プロジェクト列 / 状態列 等)
 * 変更後: プロジェクト毎のセクション (折りたたみ可) + WBS スタイルの階層ツリー
 *   - 担当 ACT とその祖先 WP のみ表示 (filterTreeByAssignee)
 *   - WBS 画面と同じ折りたたみ / インデント / バッジ表現
 */
export default async function MyTasksPage() {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  const projectGroups = await listMyTaskProjects(session.user.id);
  // サーバ側で算出した today (YYYY-MM-DD) を props 経由で渡し、クライアント描画で
  // new Date() を使った比較を行わないようにする (SSR⇔hydrate の時刻差に伴う
  // React error #418 ハイドレーションミスマッチ対策)。
  const today = new Date().toISOString().split('T')[0];

  // feat/gantt-tab-restructure (PR-C item 7): Gantt 表示で担当者フィルタの初期値に
  // 自分が選ばれている必要があるため、currentUserId と userName を Gantt 用に渡す。
  return (
    <MyTasksClient
      projectGroups={projectGroups}
      today={today}
      currentUserId={session.user.id}
      currentUserName={session.user.name ?? 'me'}
    />
  );
}
