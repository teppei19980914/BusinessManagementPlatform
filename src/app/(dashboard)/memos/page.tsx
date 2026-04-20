import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listMemosForViewer } from '@/services/memo.service';
import { MemosClient } from './memos-client';

/**
 * 全メモ画面 (PR #70)。
 * 自分のメモ (private/public すべて) + 他人の public メモを一覧表示する。
 * admin も含め、他人の private メモは閲覧不可 (完全非公開が要件)。
 */
export default async function MemosPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const memos = await listMemosForViewer(session.user.id);
  return <MemosClient memos={memos} viewerUserId={session.user.id} />;
}
