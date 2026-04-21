import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { listPublicMemos } from '@/services/memo.service';
import { AllMemosClient } from './all-memos-client';

/**
 * 全メモ画面 (PR #71 で新設、プロジェクト一覧上部のナビ配下)。
 *   - visibility='public' のメモを全件表示 (自分の公開メモ + 他人の公開メモ)
 *   - 行クリックで詳細ダイアログが開くが read-only (編集/削除は個別の /memos 画面で)
 *   - admin 特権なし: 他人の private メモは一切含まれない
 */
export default async function AllMemosPage() {
  const session = await auth();
  if (!session?.user) redirect(LOGIN_ROUTE);

  const memos = await listPublicMemos(session.user.id);
  return <AllMemosClient memos={memos} />;
}
