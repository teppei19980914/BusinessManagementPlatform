import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { listMyTaskProjects } from '@/services/task.service';
import { recordError } from '@/services/error-log.service';
import { getTenantTodayString } from '@/lib/tenant-time';
import { resolveTimezone, resolveLocale } from '@/config/i18n';
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

  // fix/admin-users-defensive-render 横展開 (2026-05-15): マイタスクは一覧ナビゲーションから
  //   頻繁に到達する画面のため、listMyTaskProjects の throw が dashboard error.tsx に飛んで
  //   「ログインできない」体験を引き起こさないよう、try/catch で囲い、失敗時は空配列 +
  //   警告バナーで操作可能 UI を維持する。詳細は admin/users/page.tsx 参照。
  let projectGroups: Awaited<ReturnType<typeof listMyTaskProjects>> = [];
  let dataLoadError = false;
  try {
    projectGroups = await listMyTaskProjects(session.user.id, session.user.tenantId);
  } catch (error) {
    dataLoadError = true;
    await recordError({
      severity: 'error',
      source: 'server',
      message: '[/my-tasks] failed to load my task projects',
      stack: error instanceof Error ? error.stack : String(error),
      userId: session.user.id,
      tenantId: session.user.tenantId,
      context: {
        path: '/my-tasks',
        errorName: error instanceof Error ? error.name : 'unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        tenantId: session.user.tenantId,
      },
    });
  }

  // サーバ側で算出した today (YYYY-MM-DD) を props 経由で渡し、クライアント描画で
  // new Date() を使った比較を行わないようにする (SSR⇔hydrate の時刻差に伴う
  // React error #418 ハイドレーションミスマッチ対策)。
  // feat/gantt-initial-scroll-and-locale (2026-05-29): tenant TZ ベースで算出し、
  //   UTC ズレで「未着手なのに遅延扱い / 完了なのに未来扱い」となる罠を撲滅する。
  //   横断 Gantt にも tenant TZ/locale を伝搬し、初期スクロール + 月ヘッダの locale 化を有効にする。
  const tenantTimeZone = resolveTimezone(session.user.timezone);
  const tenantLocale = resolveLocale(session.user.locale);
  const today = getTenantTodayString(new Date(), tenantTimeZone);

  // feat/gantt-tab-restructure (PR-C item 7): Gantt 表示で担当者フィルタの初期値に
  // 自分が選ばれている必要があるため、currentUserId と userName を Gantt 用に渡す。
  return (
    <MyTasksClient
      projectGroups={projectGroups}
      today={today}
      tenantTimeZone={tenantTimeZone}
      tenantLocale={tenantLocale}
      currentUserId={session.user.id}
      currentUserName={session.user.name ?? 'me'}
      dataLoadError={dataLoadError}
    />
  );
}
