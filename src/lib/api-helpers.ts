/**
 * API Route Handler 用の共通ヘルパー
 * 認証チェック、権限チェック、エラーレスポンス生成を統一する。
 */

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { checkPermission, checkMembership } from '@/lib/permissions';
import type { Action, PermissionContext } from '@/lib/permissions';
import type { SystemRole, ProjectRole, ProjectStatus } from '@/types';

export type AuthenticatedUser = {
  id: string;
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
  const membership = await checkMembership(projectId, user.id, user.systemRole);

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
