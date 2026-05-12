/**
 * /guide ページ用のロール判定サービス (2026-05-11)
 *
 * 役割:
 *   /guide でユーザに「自分のロールに合った使い方」だけを提示するため、
 *   systemRole + ProjectMember.projectRole を勘案して 4 種類の表示ロールに解決する。
 *
 *   表示ロール (GuideRole):
 *     - 'admin'   : テナント管理者 / システム管理者 (= 全ロールの作業を把握する立場)
 *     - 'pm'      : 任意のプロジェクトで PM/PL を担うユーザ
 *     - 'member'  : 一般メンバー (= プロジェクトで作業者として参加、または未参加の新規ユーザ)
 *     - 'viewer'  : すべての所属プロジェクトで閲覧者ロールのみのユーザ
 *
 * 設計判断:
 *   - **systemRole 優先**: admin / super_admin はテナント全体を見る立場なので、Project の
 *     projectRole に関わらず 'admin' として扱う
 *   - **複数 Project 所属の最上位採用**: pm_tl > member > viewer の順で最上位を採用
 *     - 1 つでも PM/PL ロールがあれば 'pm' (= プロジェクト管理の責任を持つ立場)
 *     - 1 つでも member があれば 'member' (= 作業者としての立場が含まれる)
 *     - 全部 viewer なら 'viewer'
 *   - **ProjectMember 不在**: 新規ユーザ or 未アサインのメンバーは 'member' (= 標準ガイドを見せる)
 *   - **削除済 project は除外**: project.deletedAt IS NOT NULL のメンバーシップは無視
 *   - **データ取得の最小化**: projectRole の groupBy で 1 クエリで全所属プロジェクトのロール集合を取得
 *
 * 認可:
 *   呼出側で `auth()` 済 + userId が有効である前提 (= サービスは role 判定のみ実施)。
 */

import { prisma } from '@/lib/db';

export type GuideRole = 'admin' | 'pm' | 'member' | 'viewer';

/**
 * ユーザ + systemRole から /guide で表示すべきロールを返す。
 *
 * @param userId      ログインユーザの ID
 * @param systemRole  session.user.systemRole (= 'super_admin' | 'admin' | 'general')
 * @returns           GuideRole ('admin' | 'pm' | 'member' | 'viewer')
 */
export async function resolveGuideRole(
  userId: string,
  systemRole: string,
): Promise<GuideRole> {
  // 1. テナント管理者 / システム管理者は systemRole 単独で判定
  if (systemRole === 'admin' || systemRole === 'super_admin') {
    return 'admin';
  }

  // 2. general ユーザは ProjectMember から projectRole の最上位を採用
  //    削除済 project 配下のメンバーシップは除外 (= 過去関与のみは無視)
  const memberships = await prisma.projectMember.findMany({
    where: {
      userId,
      project: { deletedAt: null },
    },
    select: { projectRole: true },
  });

  // ProjectMember 不在: 新規 / 未アサインのユーザは 'member' (= 標準ガイド表示)
  if (memberships.length === 0) return 'member';

  // 優先順位: pm_tl > member > viewer
  const roles = new Set(memberships.map((m) => m.projectRole));
  if (roles.has('pm_tl')) return 'pm';
  if (roles.has('member')) return 'member';
  if (roles.has('viewer')) return 'viewer';

  // 未知の projectRole 値 (DB 不整合) は安全側に倒して 'member'
  return 'member';
}
