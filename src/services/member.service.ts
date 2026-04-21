/**
 * プロジェクトメンバーサービス
 *
 * 役割:
 *   プロジェクトに対するユーザの参加 (projectMember) を CRUD する。
 *   1 ユーザ × 1 プロジェクトに対して 1 ロール (PM/TL / メンバー / 閲覧者) を割り当て。
 *
 * 設計判断:
 *   - 物理削除 (deleteMember) を採用。論理削除にすると「過去メンバー」が
 *     リスク/タスクの assignee として参照され続けるため一貫性が悪い。
 *     離任ユーザは別途ユーザ無効化 (isActive=false) で扱う。
 *   - 同一ユーザが同一プロジェクトに重複参加できないよう DB に
 *     UNIQUE 制約 (uq_pm_project_user) を設置済み。重複追加は P2002 で弾く。
 *   - admin システムロールは projectMember に登録されていなくても
 *     全プロジェクトに pm_tl 相当でアクセス可 (checkMembership で吸収)。
 *
 * 認可:
 *   呼び出し元 API ルート (/api/projects/[projectId]/members/...) で
 *   checkProjectPermission('member:*') を実施済みの前提。
 *
 * 関連ドキュメント:
 *   - DESIGN.md §5 (テーブル定義: project_members)
 *   - DESIGN.md §8 (権限制御 — projectRole とロール継承)
 */

import { prisma } from '@/lib/db';

export type MemberDTO = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  projectRole: string;
  createdAt: string;
};

export async function listMembers(projectId: string): Promise<MemberDTO[]> {
  const members = await prisma.projectMember.findMany({
    where: { projectId },
    include: { user: { select: { name: true, email: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return members.map((m) => ({
    id: m.id,
    userId: m.userId,
    userName: m.user.name,
    userEmail: m.user.email,
    projectRole: m.projectRole,
    createdAt: m.createdAt.toISOString(),
  }));
}

export async function addMember(
  projectId: string,
  userId: string,
  projectRole: string,
  assignedBy: string,
): Promise<MemberDTO> {
  // ユーザ存在・有効チェック
  const user = await prisma.user.findFirst({
    where: { id: userId, isActive: true, deletedAt: null },
  });
  if (!user) throw new Error('USER_NOT_FOUND');

  // 重複チェック
  const existing = await prisma.projectMember.findFirst({
    where: { projectId, userId },
  });
  if (existing) throw new Error('ALREADY_MEMBER');

  const member = await prisma.projectMember.create({
    data: { projectId, userId, projectRole, assignedBy },
    include: { user: { select: { name: true, email: true } } },
  });

  // 権限変更ログ
  await prisma.roleChangeLog.create({
    data: {
      changedBy: assignedBy,
      targetUserId: userId,
      changeType: 'project_role',
      projectId,
      beforeRole: null,
      afterRole: projectRole,
      reason: 'プロジェクトメンバー追加',
    },
  });

  return {
    id: member.id,
    userId: member.userId,
    userName: member.user.name,
    userEmail: member.user.email,
    projectRole: member.projectRole,
    createdAt: member.createdAt.toISOString(),
  };
}

export async function updateMemberRole(
  memberId: string,
  newRole: string,
  changedBy: string,
): Promise<MemberDTO> {
  const member = await prisma.projectMember.findUnique({
    where: { id: memberId },
    include: { user: { select: { name: true, email: true } } },
  });
  if (!member) throw new Error('NOT_FOUND');

  const updated = await prisma.projectMember.update({
    where: { id: memberId },
    data: { projectRole: newRole },
    include: { user: { select: { name: true, email: true } } },
  });

  await prisma.roleChangeLog.create({
    data: {
      changedBy,
      targetUserId: member.userId,
      changeType: 'project_role',
      projectId: member.projectId,
      beforeRole: member.projectRole,
      afterRole: newRole,
      reason: 'プロジェクトロール変更',
    },
  });

  return {
    id: updated.id,
    userId: updated.userId,
    userName: updated.user.name,
    userEmail: updated.user.email,
    projectRole: updated.projectRole,
    createdAt: updated.createdAt.toISOString(),
  };
}

export async function removeMember(memberId: string, changedBy: string): Promise<void> {
  const member = await prisma.projectMember.findUnique({ where: { id: memberId } });
  if (!member) throw new Error('NOT_FOUND');

  await prisma.projectMember.delete({ where: { id: memberId } });

  await prisma.roleChangeLog.create({
    data: {
      changedBy,
      targetUserId: member.userId,
      changeType: 'project_role',
      projectId: member.projectId,
      beforeRole: member.projectRole,
      afterRole: 'removed',
      reason: 'プロジェクトメンバー解除',
    },
  });
}
