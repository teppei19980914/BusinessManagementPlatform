/**
 * プロジェクトメンバーシップ検証（IDOR 防止）
 * 設計書: DESIGN.md セクション 9.5.2
 *
 * 全てのプロジェクトリソースへのアクセスで、
 * 呼び出し元ユーザのメンバーシップを必ず検証する。
 */

import { prisma } from '@/lib/db';
import type { ProjectRole } from '@/types';

export type MembershipInfo = {
  isMember: boolean;
  projectRole: ProjectRole | null;
  projectStatus: string | null;
};

/**
 * ユーザがプロジェクトのメンバーかどうかを検証する。
 * システム管理者は全プロジェクトにアクセス可能。
 */
export async function checkMembership(
  projectId: string,
  userId: string,
  systemRole: string,
): Promise<MembershipInfo> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { status: true },
  });

  if (!project) {
    return { isMember: false, projectRole: null, projectStatus: null };
  }

  // システム管理者は全プロジェクトにアクセス可能
  if (systemRole === 'admin') {
    return {
      isMember: true,
      projectRole: 'pm_tl' as ProjectRole,
      projectStatus: project.status,
    };
  }

  const member = await prisma.projectMember.findFirst({
    where: { projectId, userId },
  });

  if (!member) {
    return { isMember: false, projectRole: null, projectStatus: project.status };
  }

  return {
    isMember: true,
    projectRole: member.projectRole as ProjectRole,
    projectStatus: project.status,
  };
}
