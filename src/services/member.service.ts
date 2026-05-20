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
 *   checkProjectPermission('member:manage') を実施済みの前提。
 *
 *   feat/crud-permission-redesign (2026-05-20): PM/TL もメンバー管理可能になったため、
 *   「PM/TL ロール」を扱う操作 (PM/TL 追加・PM/TL 削除・PM/TL からのロール変更・
 *   PM/TL へのロール昇格) は admin/super_admin のみに制限する細粒度ガードを本層で実施。
 *   throw 'FORBIDDEN_PMTL_ROLE' で route 層にハンドリングさせる。
 *
 * 関連ドキュメント:
 *   - DESIGN.md §5 (テーブル定義: project_members)
 *   - DESIGN.md §8 (権限制御 — projectRole とロール継承)
 */

import { prisma } from '@/lib/db';
import { isAdminOrAbove } from '@/lib/permissions/role';

export type MemberDTO = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  projectRole: string;
  createdAt: string;
};

/**
 * 2026-05-09 feedback Phase 2-6: severity-1 テナント越境対策。
 *   ProjectMember は schema 上 tenantId 列を持たないため `project: { tenantId }` 経由で絞り込み。
 *   特に addMember は **権限昇格攻撃の起点** (他テナント user を pm_tl で追加) のため
 *   user と project の tenant 一致を verify する。
 */
export async function listMembers(
  projectId: string,
  viewerTenantId: string,
): Promise<MemberDTO[]> {
  const members = await prisma.projectMember.findMany({
    where: { projectId, project: { tenantId: viewerTenantId } },
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
  viewerTenantId: string,
  actorSystemRole: string,
): Promise<MemberDTO> {
  // feat/crud-permission-redesign (2026-05-20): PM/TL ロールの追加は admin/super_admin のみ。
  //   PM/TL 自身が「自分の代わり」となる別 PM/TL を勝手に増やせると権限委譲リスクが残るため、
  //   PM/TL → PM/TL の追加経路を遮断する。member/viewer の追加は PM/TL も実行可。
  if (projectRole === 'pm_tl' && !isAdminOrAbove({ systemRole: actorSystemRole })) {
    throw new Error('FORBIDDEN_PMTL_ROLE');
  }

  // 2026-05-09 feedback Phase 2-6: 権限昇格攻撃を遮断するため:
  //   1. project が viewer の tenant に属することを verify
  //   2. user が同 tenant に属することを verify
  //   両者が一致しなければ NOT_FOUND を throw (USER_NOT_FOUND と区別せず情報漏洩防止)
  const project = await prisma.project.findFirst({
    where: { id: projectId, tenantId: viewerTenantId },
    select: { id: true },
  });
  if (!project) throw new Error('NOT_FOUND');

  // ユーザ存在・有効チェック + tenantId 一致確認
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId: viewerTenantId, isActive: true, deletedAt: null },
  });
  if (!user) throw new Error('USER_NOT_FOUND');

  // 重複チェック
  const existing = await prisma.projectMember.findFirst({
    where: { projectId, userId },
  });
  if (existing) throw new Error('ALREADY_MEMBER');

  // feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S2-D4): create + roleChangeLog を
  //   1 transaction に集約。旧実装は両者が独立 await で後者が失敗すると「メンバーは作られたが
  //   履歴は残らない」inconsistent state が残るリスクがあった。
  const member = await prisma.$transaction(async (tx) => {
    const created = await tx.projectMember.create({
      data: { projectId, userId, projectRole, assignedBy },
      include: { user: { select: { name: true, email: true } } },
    });
    await tx.roleChangeLog.create({
      data: {
        tenantId: viewerTenantId,
        changedBy: assignedBy,
        targetUserId: userId,
        changeType: 'project_role',
        projectId,
        beforeRole: null,
        afterRole: projectRole,
        reason: 'プロジェクトメンバー追加',
      },
    });
    return created;
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
  viewerTenantId: string,
  actorSystemRole: string,
): Promise<MemberDTO> {
  // 2026-05-09 feedback Phase 2-6: 越境ロール変更を遮断するため findFirst + project tenant 検証。
  const member = await prisma.projectMember.findFirst({
    where: { id: memberId, project: { tenantId: viewerTenantId } },
    include: { user: { select: { name: true, email: true } } },
  });
  if (!member) throw new Error('NOT_FOUND');

  // feat/crud-permission-redesign (2026-05-20 追加要件): 自分自身のプロジェクトロール変更禁止。
  //   admin/users 画面と同じ原則で「ロール変更は他ユーザに依頼する」設計。
  //   admin/super_admin であっても自分自身のプロジェクトロールを変えると意図しない権限上下や
  //   PM/TL 不在化が発生し得るため、自己編集経路を構造的に閉鎖する。
  if (member.userId === changedBy) {
    throw new Error('CANNOT_CHANGE_OWN_PROJECT_ROLE');
  }

  // feat/crud-permission-redesign (2026-05-20): 「PM/TL ロール」を扱うロール変更は admin only。
  //   - PM/TL → member/viewer (降格): admin only (PM/TL 自身による「自己降格→PM/TL 不在化」を防止)
  //   - member/viewer → PM/TL (昇格): admin only (権限委譲リスク回避)
  //   member ↔ viewer の相互変更は PM/TL も実行可。
  const isPmTlInvolved = member.projectRole === 'pm_tl' || newRole === 'pm_tl';
  if (isPmTlInvolved && !isAdminOrAbove({ systemRole: actorSystemRole })) {
    throw new Error('FORBIDDEN_PMTL_ROLE');
  }

  // feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S2-D4): update + roleChangeLog を transaction 化
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.projectMember.update({
      where: { id: memberId },
      data: { projectRole: newRole },
      include: { user: { select: { name: true, email: true } } },
    });
    await tx.roleChangeLog.create({
      data: {
        tenantId: viewerTenantId,
        changedBy,
        targetUserId: member.userId,
        changeType: 'project_role',
        projectId: member.projectId,
        beforeRole: member.projectRole,
        afterRole: newRole,
        reason: 'プロジェクトロール変更',
      },
    });
    return u;
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

export async function removeMember(
  memberId: string,
  changedBy: string,
  viewerTenantId: string,
  actorSystemRole: string,
): Promise<void> {
  // 2026-05-09 feedback Phase 2-6: 越境メンバー解除を遮断するため findFirst + project tenant 検証。
  const member = await prisma.projectMember.findFirst({
    where: { id: memberId, project: { tenantId: viewerTenantId } },
  });
  if (!member) throw new Error('NOT_FOUND');

  // feat/crud-permission-redesign (2026-05-20): PM/TL の削除は admin/super_admin のみ。
  //   member/viewer の削除は PM/TL も実行可能だが、PM/TL 同士の解除は権限委譲リスク回避のため admin only。
  if (member.projectRole === 'pm_tl' && !isAdminOrAbove({ systemRole: actorSystemRole })) {
    throw new Error('FORBIDDEN_PMTL_ROLE');
  }

  // feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S2-D4): delete + roleChangeLog を transaction 化
  await prisma.$transaction(async (tx) => {
    await tx.projectMember.delete({ where: { id: memberId } });
    await tx.roleChangeLog.create({
      data: {
        tenantId: viewerTenantId,
        changedBy,
        targetUserId: member.userId,
        changeType: 'project_role',
        projectId: member.projectId,
        beforeRole: member.projectRole,
        afterRole: 'removed',
        reason: 'プロジェクトメンバー解除',
      },
    });
  });
}
