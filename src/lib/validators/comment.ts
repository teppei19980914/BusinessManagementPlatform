import { z } from 'zod/v4';
import { COMMENT_CONTENT_MAX_LENGTH } from '@/config';
import { mentionInputSchema } from './mention';

/**
 * コメントの親エンティティ種別 (PR #199、PR #213 で memo 追加)。
 *
 * 8 種に固定:
 *   - issue / risk: RiskIssue モデル (type discriminator で区別)
 *   - task: Task モデル
 *   - retrospective: Retrospective モデル
 *   - knowledge: Knowledge モデル (複数 project に紐付き得る)
 *   - customer: Customer モデル (admin only エンティティ)
 *   - stakeholder: Stakeholder モデル
 *   - memo: Memo モデル (PR #213、ユーザ単位で project に紐付かない)
 *
 * DB 層は VARCHAR(30) だが、入力は enum で厳格に制限する (列挙外の値で
 * 不正な entity_id 探索を行われないため)。
 */
export const COMMENT_ENTITY_TYPES = [
  'issue',
  'task',
  'risk',
  'retrospective',
  'knowledge',
  'customer',
  'stakeholder',
  'memo',
] as const;

export type CommentEntityType = (typeof COMMENT_ENTITY_TYPES)[number];

/**
 * コメント新規作成スキーマ。
 * content は trim 後 1 文字以上、上限 COMMENT_CONTENT_MAX_LENGTH (2000)。
 * mentions は省略可、最大 50 件 (PR feat/comment-mentions、Q3 サーバ側 validate は service 層で entity と突合)。
 */
export const createCommentSchema = z.object({
  entityType: z.enum(COMMENT_ENTITY_TYPES),
  entityId: z.string().uuid(),
  content: z
    .string()
    .trim()
    .min(1, 'コメントを入力してください')
    .max(COMMENT_CONTENT_MAX_LENGTH),
  mentions: z.array(mentionInputSchema).max(50).default([]),
});

/** コメント編集スキーマ (content / mentions 共更新可)。 */
export const updateCommentSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, 'コメントを入力してください')
    .max(COMMENT_CONTENT_MAX_LENGTH),
  mentions: z.array(mentionInputSchema).max(50).optional(),
});

export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;
