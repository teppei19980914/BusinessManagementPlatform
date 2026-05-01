import { z } from 'zod/v4';
import type { CommentEntityType } from './comment';

/**
 * Mention kind の列挙 (PR feat/comment-mentions)。
 *
 * - 'user': 個別ユーザ指定 (targetUserId 必須)
 * - 'all': 全アカウント (認証済全員)
 * - 'project_member': 当該 entity のプロジェクトメンバー全員
 * - 'role_pm_tl' / 'role_general' / 'role_viewer': プロジェクト内のロール別
 * - 'assignee': entity の担当者
 */
export const MENTION_KINDS = [
  'user',
  'all',
  'project_member',
  'role_pm_tl',
  'role_general',
  'role_viewer',
  'assignee',
] as const;

export type MentionKind = (typeof MENTION_KINDS)[number];

/**
 * 単一の mention 入力 (フロントから受信)。
 * - kind='user' のとき targetUserId 必須
 * - それ以外 (グループメンション) は targetUserId 不要
 */
export const mentionInputSchema = z
  .object({
    kind: z.enum(MENTION_KINDS),
    targetUserId: z.string().uuid().optional(),
  })
  .refine(
    (m) => (m.kind === 'user' ? !!m.targetUserId : !m.targetUserId),
    {
      message: "targetUserId は kind='user' のときのみ必須、それ以外は省略してください",
    },
  );

export type MentionInput = z.infer<typeof mentionInputSchema>;

/**
 * Entity 種別ごとに **許可される mention kind** を返す (Q3 サーバ側バリデーション)。
 * UI 側でも同じマトリクスで tab を出し分けるが、サーバ側でも必ず enforce する。
 *
 * - task / stakeholder: project_member / role / assignee / individual user
 *   ('all' 不可: WBS / stakeholder は project スコープ、全アカウントメンションは意味がない)
 * - issue / risk / retrospective / knowledge: 全 kind 可 ('all' 含む)
 *   (これらは「全○○」横断ビューもあり、認証済全員にメンションが届きうる)
 * - customer: 'user' のみ (admin only entity、グループメンションは不要)
 */
export function getAllowedMentionKinds(
  entityType: CommentEntityType,
): ReadonlySet<MentionKind> {
  switch (entityType) {
    case 'issue':
    case 'risk':
    case 'retrospective':
    case 'knowledge':
      // 全 kind 可
      return new Set<MentionKind>([
        'user',
        'all',
        'project_member',
        'role_pm_tl',
        'role_general',
        'role_viewer',
        'assignee',
      ]);
    case 'task':
    case 'stakeholder':
      // project スコープのみ、'all' 不可
      return new Set<MentionKind>([
        'user',
        'project_member',
        'role_pm_tl',
        'role_general',
        'role_viewer',
        'assignee',
      ]);
    case 'customer':
      // admin only entity、個別 user のみ (admin 同士の指定)
      return new Set<MentionKind>(['user']);
  }
}
