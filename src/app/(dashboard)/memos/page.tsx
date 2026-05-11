import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { listMyMemos } from '@/services/memo.service';
import { recordError } from '@/services/error-log.service';
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
  if (!session?.user) redirect(LOGIN_ROUTE);

  // fix/admin-users-defensive-render 横展開 (2026-05-15): ユーザメニューから到達する画面
  //   のため、listMyMemos の throw が dashboard error.tsx に飛んで「ログインできない」体験を
  //   引き起こさないよう、try/catch で囲い、失敗時は空一覧 + 警告バナーで操作可能 UI を維持する。
  //   詳細は admin/users/page.tsx 参照。
  let memos: Awaited<ReturnType<typeof listMyMemos>> = [];
  let dataLoadError = false;
  try {
    memos = await listMyMemos(session.user.id, session.user.tenantId);
  } catch (error) {
    dataLoadError = true;
    await recordError({
      severity: 'error',
      source: 'server',
      message: '[/memos] failed to load my memos',
      stack: error instanceof Error ? error.stack : String(error),
      userId: session.user.id,
      tenantId: session.user.tenantId,
      context: {
        path: '/memos',
        errorName: error instanceof Error ? error.name : 'unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        tenantId: session.user.tenantId,
      },
    });
  }

  return (
    <MemosClient
      memos={memos}
      viewerUserId={session.user.id}
      dataLoadError={dataLoadError}
    />
  );
}
