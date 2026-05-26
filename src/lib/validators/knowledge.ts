import { z } from 'zod/v4';
import {
  TITLE_MAX_LENGTH,
  MEDIUM_TEXT_MAX_LENGTH,
  LONG_TEXT_MAX_LENGTH,
  KNOWLEDGE_CONTENT_MAX_LENGTH,
  TAGS_MAX_COUNT,
} from '@/config';

/**
 * 2026-05-11: ナレッジ作成スキーマ。
 *
 * 公開範囲 (visibility) に応じて必須チェックを切り替える:
 *   - 'draft' (自分のみ): 一時保存的に必須項目を空でも保存可 (DB NOT NULL は default '' / 'other' で満たす)
 *   - 'public' (全メンバー): タイトル必須 + knowledgeType を含む必須項目を強制
 */
export const createKnowledgeSchema = z
  .object({
    // 2026-05-11: draft 保存時に空 OK。DB NOT NULL は '' で満たす。public 時は superRefine で必須化。
    title: z.string().max(TITLE_MAX_LENGTH).default(''),
    // 2026-05-11: draft 保存時はデフォルト 'other' を採用 (NOT NULL VarChar(30) を満たす)
    knowledgeType: z
      .enum(['research', 'verification', 'incident', 'decision', 'lesson', 'best_practice', 'other'])
      .default('other'),
    // refactor/list-create-content-optional (2026-04-27 ユーザ要望 #6):
    // 背景/内容/結果は visibility に関わらず任意 (空文字許容)。
    background: z.string().max(MEDIUM_TEXT_MAX_LENGTH).default(''),
    content: z.string().max(KNOWLEDGE_CONTENT_MAX_LENGTH).default(''),
    result: z.string().max(LONG_TEXT_MAX_LENGTH).default(''),
    // feat/account-lock-and-ui-consistency 後 hotfix:
    // DB schema (Knowledge) で nullable な列は `.nullable().optional()` とする
    // (編集 dialog で空に戻すと null 送信されるため。詳細は DEVELOPER_GUIDE §5.12)
    conclusion: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
    recommendation: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
    reusability: z.enum(['low', 'medium', 'high']).nullable().optional(),
    techTags: z.array(z.string()).max(TAGS_MAX_COUNT).optional(),
    // PR-β / 項目 13 横展開: master-data.ts の DEV_METHODS と整合
    devMethod: z.enum(['scratch', 'low_code_no_code', 'package', 'other']).nullable().optional(),
    processTags: z.array(z.string()).max(TAGS_MAX_COUNT).optional(),
    // PR #65 Phase 2 (b): Project.businessDomainTags と対称化し提案精度を上げる
    businessDomainTags: z.array(z.string()).max(TAGS_MAX_COUNT).optional(),
    // PR #60: visibility を 2 値体系に統合 (project/company は migration で public に集約済)
    // 2026-05-11: default 'draft' に変更 (= 「自分のみ」として一時保存可)
    visibility: z.enum(['draft', 'public']).default('draft'),
    projectIds: z.array(z.string().uuid()).optional(),
    // feat/asset-assignee-expansion (2026-05-26): 担当者 (作成者と並ぶ編集権限保持者)。
    //   null/undefined は「担当者なし」(従来通り作成者のみ編集可)。
    assigneeId: z.string().uuid().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.visibility === 'public' && (!data.title || data.title.trim().length === 0)) {
      ctx.addIssue({
        code: 'custom',
        message: '「全メンバー」に公開する場合はタイトルを入力してください',
        path: ['title'],
      });
    }
  });

// updateKnowledgeSchema は superRefine 後では .partial() が使えないため、内部 object から再構築。
const baseUpdateKnowledgeSchema = z.object({
  title: z.string().max(TITLE_MAX_LENGTH).optional(),
  knowledgeType: z
    .enum(['research', 'verification', 'incident', 'decision', 'lesson', 'best_practice', 'other'])
    .optional(),
  background: z.string().max(MEDIUM_TEXT_MAX_LENGTH).optional(),
  content: z.string().max(KNOWLEDGE_CONTENT_MAX_LENGTH).optional(),
  result: z.string().max(LONG_TEXT_MAX_LENGTH).optional(),
  conclusion: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
  recommendation: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
  reusability: z.enum(['low', 'medium', 'high']).nullable().optional(),
  techTags: z.array(z.string()).max(TAGS_MAX_COUNT).optional(),
  devMethod: z.enum(['scratch', 'low_code_no_code', 'package', 'other']).nullable().optional(),
  processTags: z.array(z.string()).max(TAGS_MAX_COUNT).optional(),
  businessDomainTags: z.array(z.string()).max(TAGS_MAX_COUNT).optional(),
  visibility: z.enum(['draft', 'public']).optional(),
  projectIds: z.array(z.string().uuid()).optional(),
  // feat/asset-assignee-expansion (2026-05-26): 編集時 assigneeId 更新も受入れ
  assigneeId: z.string().uuid().nullable().optional(),
});

export const updateKnowledgeSchema = baseUpdateKnowledgeSchema.superRefine((data, ctx) => {
  // visibility='public' に変更 / 維持する更新では title が空文字でないこと
  if (data.visibility === 'public' && data.title !== undefined && data.title.trim().length === 0) {
    ctx.addIssue({
      code: 'custom',
      message: '「全メンバー」に公開する場合はタイトルを入力してください',
      path: ['title'],
    });
  }
});

export type CreateKnowledgeInput = z.infer<typeof createKnowledgeSchema>;
