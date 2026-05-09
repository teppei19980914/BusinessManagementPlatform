/**
 * API Route Handler 用の共通ヘルパー
 * 認証チェック、権限チェック、エラーレスポンス生成を統一する。
 */

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { checkPermission, checkMembership } from '@/lib/permissions';
import type { Action, PermissionContext } from '@/lib/permissions';
import type { SystemRole, ProjectRole, ProjectStatus } from '@/types';

export type AuthenticatedUser = {
  id: string;
  /**
   * PR #3-b (T-03): ユーザの所属テナント ID。
   *   後続の API → service 呼び出しでテナント認可境界 (requireSameTenant) や
   *   LLM 呼び出し計測 (withMeteredLLM) に渡される。
   *   v1 では default-tenant 単一運用のため全ユーザ同値だが、v1.x マルチテナント
   *   UI 提供時に複数テナントに広がる前提で配置済み。
   */
  tenantId: string;
  name: string;
  email: string;
  systemRole: SystemRole;
};

/**
 * 認証済みユーザを取得する。未認証の場合は 401 レスポンスを返す。
 */
export async function getAuthenticatedUser(): Promise<AuthenticatedUser | NextResponse> {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }
  return {
    id: session.user.id,
    tenantId: session.user.tenantId,
    name: session.user.name,
    email: session.user.email,
    systemRole: session.user.systemRole as SystemRole,
  };
}

/**
 * プロジェクトスコープの権限チェックを行う。
 * メンバーシップ検証 + ロール x 状態チェック を統合。
 */
export async function checkProjectPermission(
  user: AuthenticatedUser,
  projectId: string,
  action: Action,
  resourceOwnerId?: string,
): Promise<NextResponse | null> {
  // 2026-05-09 feedback: severity-1 テナント越境対策。user.tenantId を渡し、
  //   admin が他テナントの projectId を直叩きしても 404 で弾かれるようにする。
  const membership = await checkMembership(projectId, user.id, user.systemRole, user.tenantId);

  if (!membership.isMember) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }

  const context: PermissionContext = {
    userId: user.id,
    systemRole: user.systemRole,
    projectId,
    projectRole: membership.projectRole as ProjectRole | null,
    projectStatus: membership.projectStatus as ProjectStatus | undefined,
    resourceOwnerId,
  };

  const result = checkPermission(action, context);

  if (!result.allowed) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: result.reason } },
      { status: 403 },
    );
  }

  return null; // 許可
}

/**
 * システム管理者チェック
 */
export function requireAdmin(user: AuthenticatedUser): NextResponse | null {
  if (user.systemRole !== 'admin') {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'この操作を実行する権限がありません' } },
      { status: 403 },
    );
  }
  return null;
}

/**
 * 2026-05-09 feedback: severity-1 テナント越境対策。
 *
 * `/api/admin/users/[userId]/**` 系ルートで、対象 user の tenantId が呼出者と
 * 一致することを検証する。不一致なら 404 (情報漏洩防止のため FORBIDDEN ではなく NOT_FOUND)。
 *
 * 旧仕様: `requireAdmin` 通過後に直接 userId 操作 (PATCH/DELETE/recovery-codes 再発行/unlock)
 * が可能で、テナント A の admin が テナント B の user を任意に操作できる重大バグだった。
 *
 * super_admin は MANAGEMENT_TENANT 所属で全テナント横断管理が必要なので bypass する。
 */
export async function requireSameTenantUser(
  user: AuthenticatedUser,
  targetUserId: string,
): Promise<NextResponse | null> {
  if (user.systemRole === 'super_admin') return null; // super_admin は越境管理可

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { tenantId: true },
  });

  if (!target || target.tenantId !== user.tenantId) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }
  return null;
}

/**
 * 対象プロジェクトの ProjectMember row が **実際に** 存在することを検証する。
 *
 * `checkProjectPermission` は admin システムロールを「全プロジェクトの pm_tl 相当」として
 * 短絡するが、本ヘルパーはその短絡を行わない。admin でも member row が無ければ 403 を返す。
 *
 * 2026-04-24 追加: 各「○○一覧」(リスク/課題/振り返り/ナレッジ) での作成操作を
 * ProjectMember に限定する要件のために用意。admin が非メンバープロジェクトで
 * 勝手に作成資源を増やすのを防ぐ (admin の責務は参照 + 管理削除のみ)。
 */
export async function requireActualProjectMember(
  user: AuthenticatedUser,
  projectId: string,
): Promise<NextResponse | null> {
  const member = await prisma.projectMember.findFirst({
    where: { projectId, userId: user.id },
    select: { id: true },
  });
  if (!member) {
    return NextResponse.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'このプロジェクトのメンバーのみ作成できます',
        },
      },
      { status: 403 },
    );
  }
  return null;
}
