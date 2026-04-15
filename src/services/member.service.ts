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
