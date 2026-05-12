import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listUsers } from '@/services/user.service';
import { getTenantSelfInfo } from '@/services/tenant-self.service';
import { recordError } from '@/services/error-log.service';
import { UsersClient } from './users-client';

export default async function UsersPage() {
  const session = await auth();
  if (!session || session.user.systemRole !== 'admin') {
    redirect('/');
  }

  // fix/admin-users-defensive-render (2026-05-15): Promise.all を try/catch で囲い
  //   `system_error_logs` に "Server Components render" だけ残って原因が掴めない
  //   状態を解消する。data fetching が失敗した場合は **空配列 + デフォルト値で UI を
  //   描画継続** し、デフォルトの dashboard error boundary に飛ばさない。
  //
  //   背景: 2026-05-11 朝に発生した digest=713007954 の Server Components render error は、
  //   listUsers / getTenantSelfInfo のいずれかが production で throw した形跡があるが、
  //   error boundary に到達したスタックは production build で抹消されて原因が不明だった。
  //   try/catch + recordError で **失敗したメソッド名・エラーメッセージを system_error_logs に
  //   詳細記録** することで次回再発時の調査を可能にする。
  //
  //   ユーザ影響: 一覧が空表示 + 「読み込み失敗」のバナーが出るが、画面操作不能にはならない。
  //   admin が他の経路 (個別招待 等) で復旧操作できる。
  let users: Awaited<ReturnType<typeof listUsers>> = [];
  let tenantInfo: Awaited<ReturnType<typeof getTenantSelfInfo>> = null;
  let dataLoadError = false;
  try {
    [users, tenantInfo] = await Promise.all([
      listUsers(session.user.tenantId),
      // P-2 (2026-05-08): Beginner プラン席数上限の UI ガード用に
      // 現テナントの plan / activeUserCount / beginnerMaxSeats を取得
      getTenantSelfInfo(session.user.tenantId),
    ]);
  } catch (error) {
    dataLoadError = true;
    await recordError({
      severity: 'error',
      source: 'server',
      message: '[/admin/users] failed to load users or tenant info',
      stack: error instanceof Error ? error.stack : String(error),
      userId: session.user.id,
      context: {
        path: '/admin/users',
        errorName: error instanceof Error ? error.name : 'unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        tenantId: session.user.tenantId,
      },
    });
  }

  return (
    <UsersClient
      initialUsers={users}
      tenantPlan={tenantInfo?.plan ?? 'beginner'}
      activeUserCount={tenantInfo?.activeUserCount ?? 0}
      beginnerMaxSeats={tenantInfo?.beginnerMaxSeats ?? 5}
      dataLoadError={dataLoadError}
    />
  );
}
