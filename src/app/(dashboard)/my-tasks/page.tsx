import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
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
  if (!session) redirect('/login');

  const projectGroups = await listMyTaskProjects(session.user.id);

  return <MyTasksClient projectGroups={projectGroups} />;
}
