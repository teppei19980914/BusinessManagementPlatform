import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listMyMemos } from '@/services/memo.service';
import { MemosClient } from './memos-client';

/**
 * メモ画面 (PR #71 で「全メモ」から「メモ (自分のみ)」に変更)。
 * ユーザ名プルダウンからアクセスする個人専用画面。
 *   - 自分のメモのみ (private / public 両方) を一覧表示
 *   - 作成・編集・削除すべて可能
 *   - visibility='public' にしたメモは `/all-memos` 画面で他ユーザからも閲覧される
 */
export default async function MemosPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const memos = await listMyMemos(session.user.id);
  return <MemosClient memos={memos} viewerUserId={session.user.id} />;
}
