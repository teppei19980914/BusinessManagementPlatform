import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { LOGIN_ROUTE } from '@/config';
import { getProject } from '@/services/project.service';
import { listCustomers } from '@/services/customer.service';
import { checkMembership, getActualProjectRole } from '@/lib/permissions';
import { recordError } from '@/services/error-log.service';
import { getTenantTodayString } from '@/lib/tenant-time';
import { resolveTimezone, resolveLocale } from '@/config/i18n';
import { ProjectDetailClient } from './project-detail-client';

type Props = {
  params: Promise<{ projectId: string }>;
};

/**
 * プロジェクト詳細画面の Server Component。
 *
 * 【設計方針（2026-04-17 以降）】
 * 概要タブで必要な「プロジェクト基本情報」と「権限判定結果」のみサーバで取得し、
 * 他タブ（WBS・ガント・リスク・振り返り・見積もり・メンバー・ナレッジ）のデータは
 * クライアント側でタブ切替時に遅延取得する（ProjectDetailClient 内の useLazyFetch）。
 *
 * ref: docs/performance/20260417/after/cold-start-and-data-growth-analysis.md §4.2
 */
export default async function ProjectDetailPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  const { projectId } = await params;

  // fix/admin-users-defensive-render 横展開 (2026-05-15): ログイン直後に前回開いていた
  //   プロジェクト詳細 URL に遷移してくるケースが多いため、Promise.all を try/catch で
  //   囲い、データ取得失敗時に dashboard error.tsx へフォールバックする「ログインできない」
  //   体験を防ぐ。詳細は admin/users/page.tsx 参照。
  //   この画面は権限・project の null チェックで分岐するため、フォールバック値で UI を
  //   描画継続する admin/users とは異なり、失敗時はインライン error 画面 + プロジェクト
  //   一覧へのリンクを表示する。
  let membership: Awaited<ReturnType<typeof checkMembership>> | null = null;
  let project: Awaited<ReturnType<typeof getProject>> = null;
  let customers: Awaited<ReturnType<typeof listCustomers>> = [];
  let actualRole: Awaited<ReturnType<typeof getActualProjectRole>> = null;
  let dataLoadError = false;
  try {
    [membership, project, customers, actualRole] = await Promise.all([
      checkMembership(projectId, session.user.id, session.user.systemRole, session.user.tenantId),
      // 2026-05-08: super_admin はシードプロジェクト (isSampleData=true) も参照可
      getProject(projectId, session.user.tenantId, session.user.systemRole),
      // PR #111-2: 編集ダイアログの顧客セレクト用マスタ
      listCustomers(session.user.tenantId),
      // 2026-04-24: リスク/課題/振り返り/ナレッジ 一覧の作成ボタン判定用 (admin 短絡なし)
      getActualProjectRole(projectId, session.user.id),
    ]);
  } catch (error) {
    dataLoadError = true;
    await recordError({
      severity: 'error',
      source: 'server',
      message: '[/projects/[projectId]] failed to load project detail',
      stack: error instanceof Error ? error.stack : String(error),
      userId: session.user.id,
      tenantId: session.user.tenantId,
      context: {
        path: `/projects/${projectId}`,
        projectId,
        errorName: error instanceof Error ? error.name : 'unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        tenantId: session.user.tenantId,
      },
    });
  }

  if (dataLoadError) {
    // dashboard/error.tsx に飛ばすと「ログインできない」体験になるため、ここで
    // 操作可能な fallback UI を直接描画する (プロジェクト一覧へ戻るリンク付き)。
    return (
      <div className="space-y-4">
        <div className="rounded border border-destructive/30 bg-destructive/10 p-4 text-sm">
          <p className="font-semibold">⚠ プロジェクトの読み込みに失敗しました</p>
          <p className="mt-1 text-muted-foreground">
            一時的な問題の可能性があります。ページを再読み込みするか、しばらくしてから再試行してください。
            問題が継続する場合は管理者にお問合せください。
          </p>
        </div>
        <Link
          href="/projects"
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
        >
          プロジェクト一覧へ戻る
        </Link>
      </div>
    );
  }

  if (!membership || !membership.isMember) notFound();
  if (!project) notFound();

  const canEdit = session.user.systemRole === 'admin' || membership.projectRole === 'pm_tl';
  // canCreate は従来通り WBS/タスク/メンバー管理等の一般的な create 可否
  const canCreate =
    session.user.systemRole === 'admin'
    || membership.projectRole === 'pm_tl'
    || membership.projectRole === 'member';
  // 2026-04-24: リスク/課題/振り返り/ナレッジ 一覧専用の create 可否。
  //             admin でも実際の ProjectMember でないと作成不可。
  const canCreateOwnedList = actualRole === 'pm_tl' || actualRole === 'member';

  // feat/gantt-initial-scroll-and-locale (2026-05-29):
  //   ガントタブ・振り返りタブが lazy load 後に必要とする tenant TZ/locale/today を server で確定。
  const tenantTimeZone = resolveTimezone(session.user.timezone);
  const tenantLocale = resolveLocale(session.user.locale);
  const today = getTenantTodayString(new Date(), tenantTimeZone);

  return (
    <ProjectDetailClient
      project={project}
      projectRole={membership.projectRole}
      systemRole={session.user.systemRole}
      userId={session.user.id}
      canEdit={canEdit}
      canCreate={canCreate}
      canCreateOwnedList={canCreateOwnedList}
      customers={customers.map((c) => ({ id: c.id, name: c.name }))}
      // 2026-05-09 (#22): 「なぜ?」ボタンの可視性判定用 (Pro 限定機能)
      tenantPlan={session.user.tenantPlan}
      today={today}
      tenantTimeZone={tenantTimeZone}
      tenantLocale={tenantLocale}
    />
  );
}
