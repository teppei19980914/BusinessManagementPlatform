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
 *
 * 論理削除済みプロジェクトの扱い (2026-04-18 改訂):
 *   - 非管理者: 論理削除済みプロジェクトは「存在しない」扱い (isMember: false)
 *   - システム管理者: 論理削除済みでもアクセス可
 *     → 親プロジェクトが削除され、関連データ (リスク/課題・振り返り・ナレッジ) が
 *       孤児化した場合でも、admin は「全○○」画面から個別に削除/更新できる必要がある。
 *     → この経路を閉じると、PR #52 で導入した「カスケードしない削除」後の
 *       データ整理手段が無くなってしまう。
 */
/**
 * ユーザの **実際の** ProjectMember row からプロジェクトロールを取得する
 * (admin 短絡なし)。
 *
 * 2026-04-24 追加: 各「○○一覧」画面での作成ボタン表示判定用。
 * admin であっても project_members に row が無ければ null を返す。
 *
 * @returns 'pm_tl' | 'member' | 'viewer' | null (未所属)
 */
export async function getActualProjectRole(
  projectId: string,
  userId: string,
): Promise<ProjectRole | null> {
  const member = await prisma.projectMember.findFirst({
    where: { projectId, userId },
    select: { projectRole: true },
  });
  return (member?.projectRole as ProjectRole | undefined) ?? null;
}

/**
 * 2026-05-09 feedback: severity-1 テナント越境バグ恒久対策の中核修正。
 *
 * 旧仕様: `userTenantId` 引数なしで `project.tenantId` を参照しなかったため、
 *   テナント A の admin が テナント B の projectId を URL 直叩きで操作可能 (admin 短絡で `isMember: true` になる)。
 *   これにより projects/[projectId]/** 配下の数十のルートがすべて越境可能だった。
 *
 * 新仕様: `userTenantId` を必須引数化し、`project.tenantId !== userTenantId` の場合は
 *   admin であっても `isMember: false` を返す (= 認可 fail)。`super_admin` のみ MANAGEMENT_TENANT_ID
 *   からの越境管理を許可するため bypass する (super_admin は別テナント所属のシードデータ・運用データ管理者)。
 *   → 1 ヘルパー修正で `checkProjectPermission` 経由の全 API ルートが一括防御される。
 */
export async function checkMembership(
  projectId: string,
  userId: string,
  systemRole: string,
  userTenantId: string,
): Promise<MembershipInfo> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { status: true, deletedAt: true, tenantId: true },
  });

  // プロジェクトレコード自体が存在しない (物理削除済み or 不正な ID) → 誰もアクセス不可
  if (!project) {
    return { isMember: false, projectRole: null, projectStatus: null };
  }

  // テナント越境チェック (admin より優先): super_admin のみ越境管理を許可。
  //   project.tenantId !== userTenantId の場合は「存在しない」扱いで 404 (情報漏洩防止)。
  //   admin が他テナントの projectId を直叩きする攻撃経路を遮断する severity-1 対策。
  if (systemRole !== 'super_admin' && project.tenantId !== userTenantId) {
    return { isMember: false, projectRole: null, projectStatus: null };
  }

  // システム管理者: 自テナント内の論理削除済みプロジェクトでもアクセス可 (孤児データ管理のため)。
  //   super_admin は全テナント横断で管理可能 (MANAGEMENT_TENANT 所属のため)。
  if (systemRole === 'admin' || systemRole === 'super_admin') {
    return {
      isMember: true,
      projectRole: 'pm_tl' as ProjectRole,
      projectStatus: project.status,
    };
  }

  // 非管理者: 論理削除済みプロジェクトは存在しない扱い
  if (project.deletedAt) {
    return { isMember: false, projectRole: null, projectStatus: project.status };
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
