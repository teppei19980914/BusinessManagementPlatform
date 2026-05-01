/**
 * GET /api/mention-candidates - @ 補完用の候補取得 (PR feat/comment-mentions)
 *
 * クエリパラメータ:
 *   - entityType : Comment の対象 entity 種別 (許可 kind を決める)
 *   - entityId   : Comment の対象 entity ID (project / assignee 解決に使用)
 *   - context    : 'project_list' | 'cross_list' | 'wbs' (UI 経路、tab 表示制御)
 *                  サーバ側 final validation は entityType ベースで実施 (UI 信頼しない)
 *   - query      : 部分一致フィルタ文字列 (個別ユーザのみに適用、大文字小文字無視)
 *
 * レスポンス:
 *   {
 *     data: {
 *       groups: { kind, label }[],   // 'all' / 'project_member' / 'role_pm_tl' 等のグループ kind
 *       users:  { id, name, email, isAssignee }[],  // 個別ユーザ候補
 *     }
 *   }
 *
 * 認可:
 *   認証済ユーザのみ。返す user 一覧は entityType の許可 kind に基づき:
 *     - 'all' 許可エンティティ → 全 active ユーザ
 *     - project-scoped のみ (task/stakeholder) → project member だけ
 *     - admin only (customer) → admin だけ
 *
 * パフォーマンス:
 *   - user 一覧取得は名前 ASC 並び、最大 50 件返す
 *   - query 指定時はサーバ側 LIKE フィルタ (case-insensitive)
 *   - groups は kind の固定リスト (DB 不要)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { COMMENT_ENTITY_TYPES } from '@/lib/validators/comment';
import type { CommentEntityType } from '@/lib/validators/comment';
import { getAllowedMentionKinds } from '@/lib/validators/mention';
import type { MentionKind } from '@/lib/validators/mention';

const MAX_USERS = 50;

/** kind → 表示ラベル (ja のみ MVP、i18n は将来) */
const KIND_LABELS: Record<MentionKind, string> = {
  user: '個別',
  all: '全アカウント',
  project_member: 'ProjectMember',
  role_pm_tl: 'PM/PL',
  role_general: '一般 (メンバー)',
  role_viewer: '閲覧のみ',
  assignee: '担当者',
};

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const url = new URL(req.url);
  const entityType = url.searchParams.get('entityType');
  const entityId = url.searchParams.get('entityId');
  const query = (url.searchParams.get('query') ?? '').trim();
  // context: UI 経路ヒント (tab 表示制御)。'project_list' / 'cross_list' / 'wbs' のいずれか。
  // 省略時は entity ベースの全許可 kind を返す (UI 信頼しないサーバ側 enforce はもとから働く)。
  const context = url.searchParams.get('context') ?? '';

  if (!entityType || !COMMENT_ENTITY_TYPES.includes(entityType as CommentEntityType)) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'invalid entityType' } },
      { status: 400 },
    );
  }
  const typed = entityType as CommentEntityType;
  const allowedKinds = getAllowedMentionKinds(typed);

  // ---- groups (kind ベース、'user' は個別なので除外) ----
  // context によって追加的に絞る (ユーザの spec):
  //   - 'cross_list' (全○○): 'all' / 'assignee' のみ (プロジェクト関連は隠す)
  //   - 'wbs': 'all' を隠す (project スコープのみ)
  //   - 'project_list' (○○一覧): 全 kind 表示
  const allGroupKinds: MentionKind[] = ['all', 'project_member', 'role_pm_tl', 'role_general', 'role_viewer', 'assignee'];
  const contextFilter = (k: MentionKind): boolean => {
    if (context === 'cross_list') {
      return k === 'all' || k === 'assignee';
    }
    if (context === 'wbs') {
      return k !== 'all';
    }
    return true; // project_list or 不明
  };
  const groups = allGroupKinds
    .filter((k) => allowedKinds.has(k))
    .filter(contextFilter)
    .map((k) => ({ kind: k, label: KIND_LABELS[k] }));

  // ---- users (個別候補) ----
  let users: { id: string; name: string; email: string }[] = [];

  if (typed === 'customer') {
    // customer は admin のみ対象
    users = await prisma.user.findMany({
      where: {
        systemRole: 'admin',
        isActive: true,
        deletedAt: null,
        ...(query ? { name: { contains: query, mode: 'insensitive' as const } } : {}),
      },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
      take: MAX_USERS,
    });
  } else if (typed === 'task' || typed === 'stakeholder') {
    // project-scoped: project member のみ
    if (!entityId) {
      return NextResponse.json({ data: { groups, users: [] } });
    }
    let projectId: string | null = null;
    if (typed === 'task') {
      const t = await prisma.task.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { projectId: true },
      });
      projectId = t?.projectId ?? null;
    } else {
      const s = await prisma.stakeholder.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { projectId: true },
      });
      projectId = s?.projectId ?? null;
    }
    if (projectId) {
      const members = await prisma.projectMember.findMany({
        where: { projectId },
        select: { user: { select: { id: true, name: true, email: true, isActive: true, deletedAt: true } } },
      });
      users = members
        .map((m) => m.user)
        .filter((u): u is { id: string; name: string; email: string; isActive: boolean; deletedAt: Date | null } =>
          u !== null && u.isActive && u.deletedAt === null,
        )
        .filter((u) => !query || u.name.toLowerCase().includes(query.toLowerCase()))
        .slice(0, MAX_USERS)
        .map(({ id, name, email }) => ({ id, name, email }));
    }
  } else {
    // issue / risk / retrospective / knowledge: 認証済全員 (cross-list でもアクセス可能)
    users = await prisma.user.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        permanentLock: false,
        ...(query ? { name: { contains: query, mode: 'insensitive' as const } } : {}),
      },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
      take: MAX_USERS,
    });
  }

  return NextResponse.json({ data: { groups, users } });
}
