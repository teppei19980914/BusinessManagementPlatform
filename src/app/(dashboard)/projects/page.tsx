import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { listProjects } from '@/services/project.service';
import { listCustomers } from '@/services/customer.service';
import { recordError } from '@/services/error-log.service';
import { ProjectsClient } from './projects-client';

export default async function ProjectsPage() {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

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
        { page: 1, limit: 20 },
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
    />
  );
}
