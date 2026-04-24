import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { getProject } from '@/services/project.service';
import { listCustomers } from '@/services/customer.service';
import { checkMembership, getActualProjectRole } from '@/lib/permissions';
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

  // 認可チェック・project・customers は互いに依存しないので並列取得
  const [membership, project, customers, actualRole] = await Promise.all([
    checkMembership(projectId, session.user.id, session.user.systemRole),
    getProject(projectId),
    // PR #111-2: 編集ダイアログの顧客セレクト用マスタ
    listCustomers(),
    // 2026-04-24: リスク/課題/振り返り/ナレッジ 一覧の作成ボタン判定用 (admin 短絡なし)
    getActualProjectRole(projectId, session.user.id),
  ]);

  if (!membership.isMember) notFound();
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
    />
  );
}
