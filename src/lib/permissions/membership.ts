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
 * perf/phase-4 (2026-06-01): checkMembership + getActualProjectRole 統合版の戻り値。
 *
 * 旧 page.tsx は両関数を Promise.all で並列実行していたが、それぞれが内部で project_members
 * テーブルへの query を発行するため重複アクセスが発生していた (非 admin で 1 round-trip 余分)。
 * 本型 + {@link checkMembershipWithActualRole} は両者を 1 関数 + 内部 Promise.all で実装し
 * 統合する。
 */
export type FullMembershipInfo = MembershipInfo & {
  /**
   * admin 短絡なしの実 project_members row のロール (該当行なしなら null)。
   * リスク/課題/振り返り/ナレッジ 一覧での「作成ボタン表示判定」用 (admin であっても
   * 実メンバーでなければ作成不可、という業務ルールを守るための値)。
   */
  actualProjectRole: ProjectRole | null;
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

/**
 * perf/phase-4 (2026-06-01): checkMembership + getActualProjectRole 統合版。
 *
 * 旧呼出パターン:
 *   const [m, actualRole] = await Promise.all([
 *     checkMembership(projectId, userId, systemRole, userTenantId),
 *     getActualProjectRole(projectId, userId),
 *   ]);
 *
 *   非 admin で 3 query (project + projectMember + projectMember) を 2 round-trip で実行。
 *
 * 新呼出パターン:
 *   const m = await checkMembershipWithActualRole(projectId, userId, systemRole, userTenantId);
 *
 *   全 plan / ロールで 2 query (project + projectMember) を 1 round-trip で実行。
 *
 * ★ セキュリティ invariant 不変宣言 ★:
 *   - テナント越境チェック (systemRole !== 'super_admin' && project.tenantId !== userTenantId) は同一ロジックで保持
 *   - admin 短絡 (admin → projectRole='pm_tl') の挙動も同一
 *   - 論理削除済プロジェクトの扱い (admin は閲覧可 / 非 admin は 404) も同一
 *   - actualProjectRole は admin 短絡の影響を受けない (実 row ベース) 性質を維持
 *   - 非 admin 視点では actualProjectRole === projectRole になる (= 実 row の値)
 */
export async function checkMembershipWithActualRole(
  projectId: string,
  userId: string,
  systemRole: string,
  userTenantId: string,
): Promise<FullMembershipInfo> {
  // Project と ProjectMember を同時並列取得 (互いに依存なし)
  const [project, member] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { status: true, deletedAt: true, tenantId: true },
    }),
    prisma.projectMember.findFirst({
      where: { projectId, userId },
      select: { projectRole: true },
    }),
  ]);

  const actualProjectRole =
    (member?.projectRole as ProjectRole | undefined) ?? null;

  // プロジェクトレコード自体が存在しない (物理削除済み or 不正な ID) → 誰もアクセス不可
  if (!project) {
    return {
      isMember: false,
      projectRole: null,
      projectStatus: null,
      actualProjectRole,
    };
  }

  // テナント越境チェック (admin より優先)。情報漏洩防止のため status も null で返す。
  if (systemRole !== 'super_admin' && project.tenantId !== userTenantId) {
    return {
      isMember: false,
      projectRole: null,
      projectStatus: null,
      actualProjectRole,
    };
  }

  // システム管理者: 自テナント内の論理削除済みプロジェクトでもアクセス可 (孤児データ管理のため)。
  if (systemRole === 'admin' || systemRole === 'super_admin') {
    return {
      isMember: true,
      projectRole: 'pm_tl' as ProjectRole,
      projectStatus: project.status,
      actualProjectRole,
    };
  }

  // 非管理者: 論理削除済みプロジェクトは存在しない扱い
  if (project.deletedAt) {
    return {
      isMember: false,
      projectRole: null,
      projectStatus: project.status,
      actualProjectRole,
    };
  }

  if (!member) {
    return {
      isMember: false,
      projectRole: null,
      projectStatus: project.status,
      actualProjectRole,
    };
  }

  return {
    isMember: true,
    projectRole: member.projectRole as ProjectRole,
    projectStatus: project.status,
    actualProjectRole,
  };
}
