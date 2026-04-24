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
