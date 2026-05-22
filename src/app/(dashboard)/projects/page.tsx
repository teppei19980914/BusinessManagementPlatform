import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { listProjects } from '@/services/project.service';
import { listCustomers } from '@/services/customer.service';
import { recordError } from '@/services/error-log.service';
import { ProjectsClient } from './projects-client';

/**
 * PR #425 (2026-05-22): 検索ボタンが効かない不具合 (★severity-1 UX バグ★) の修正。
 *
 * 旧版は params 固定の `{ page: 1, limit: 20 }` で listProjects を呼んでいたため、
 * client 側で router.push で URL params を更新しても page.tsx の searchParams が
 * 反映されず「検索ボタンを押しても一覧が変わらない」状態だった。
 *
 * App Router の `searchParams` prop を受け取り、URL クエリを listProjects の
 * keyword / status / customerName / customerId に伝播させることで、router.push
 * → page 再実行 → listProjects の where に反映 → 新 initialProjects で再描画
 * の経路を完成させる。
 */
type SearchParams = Promise<{
  keyword?: string;
  status?: string;
  customerName?: string;
  customerId?: string;
}>;

export default async function ProjectsPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  // Next.js 15: searchParams は Promise なので await が必須
  const sp = await searchParams;
  const listParams = {
    page: 1,
    limit: 20,
    ...(sp.keyword ? { keyword: sp.keyword } : {}),
    ...(sp.status ? { status: sp.status } : {}),
    ...(sp.customerName ? { customerName: sp.customerName } : {}),
    ...(sp.customerId ? { customerId: sp.customerId } : {}),
  };

  // fix/admin-users-defensive-render 横展開 (2026-05-15): /projects はログイン直後の
  //   デフォルト遷移先のため、server data fetch が throw した場合に
  //   `dashboard/error.tsx` に飛んで「ログインできない」体験を引き起こさないよう、
  //   Promise.all を try/catch で囲い、失敗時は空一覧 + 警告バナーで操作可能 UI を維持する。
  //   詳細は admin/users/page.tsx のヘッダコメント参照。
  let result: Awaited<ReturnType<typeof listProjects>> = { data: [], total: 0 };
  let customers: Awaited<ReturnType<typeof listCustomers>> = [];
  let dataLoadError = false;
  try {
    [result, customers] = await Promise.all([
      listProjects(
        listParams,
        session.user.id,
        session.user.systemRole,
        session.user.tenantId,
      ),
      // PR #111-2: 新規作成ダイアログの顧客セレクト用
      listCustomers(session.user.tenantId),
    ]);
  } catch (error) {
    dataLoadError = true;
    await recordError({
      severity: 'error',
      source: 'server',
      message: '[/projects] failed to load projects or customers',
      stack: error instanceof Error ? error.stack : String(error),
      userId: session.user.id,
      tenantId: session.user.tenantId,
      context: {
        path: '/projects',
        errorName: error instanceof Error ? error.name : 'unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        tenantId: session.user.tenantId,
      },
    });
  }

  return (
    <ProjectsClient
      initialProjects={result.data}
      initialTotal={result.total}
      isAdmin={session.user.systemRole === 'admin'}
      customers={customers.map((c) => ({ id: c.id, name: c.name }))}
      dataLoadError={dataLoadError}
      // PR #425 (2026-05-22): リロード時 / 検索後 URL 共有時に input が空に戻らないよう、
      // URL params から初期値を Client Component に伝播させる。
      initialKeyword={sp.keyword ?? ''}
      initialStatusFilter={sp.status ?? ''}
    />
  );
}
