import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { listPublicMemos } from '@/services/memo.service';
import { AllMemosClient } from './all-memos-client';

/**
 * 全メモ画面 (PR #71 で新設、プロジェクト一覧上部のナビ配下)。
 *   - visibility='public' のメモを全件表示 (自分の公開メモ + 他人の公開メモ)
 *   - 行クリックで詳細ダイアログが開くが read-only (編集は個別の /memos 画面で)
 *   - admin であっても他人の private メモは一切含まれない (参照不可、プライバシー保護)
 *   - admin に限り「他人 public メモを削除可」(モデレーション用途、
 *     feat/crud-permission-redesign 2026-05-20 で追加)
 */
// PR #425 (2026-05-22) KDD §5.X+102: URL ?keyword= 永続化
type SearchParams = Promise<{ keyword?: string }>;

export default async function AllMemosPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await auth();
  if (!session?.user) redirect(LOGIN_ROUTE);

  const sp = await searchParams;
  const memos = await listPublicMemos(session.user.id, session.user.tenantId);
  return (
    <AllMemosClient
      memos={memos}
      currentSystemRole={session.user.systemRole}
      initialKeyword={sp.keyword ?? ''}
    />
  );
}
