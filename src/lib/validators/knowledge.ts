import { z } from 'zod/v4';
import {
  TITLE_MAX_LENGTH,
  MEDIUM_TEXT_MAX_LENGTH,
  LONG_TEXT_MAX_LENGTH,
  KNOWLEDGE_CONTENT_MAX_LENGTH,
  TAGS_MAX_COUNT,
} from '@/config';

/**
 * 2026-05-11 / v1.3.0 軽量入力 (2026-06-19) 改訂: ナレッジ作成スキーマ。
 *
 * 公開範囲 (visibility) に応じて必須チェックを切り替える:
 *   - 'draft' (自分のみ): **タイトルのみ必須**。他項目は空でも保存可 (DB NOT NULL は default '' / 'other' で満たす)
 *   - 'public' (全メンバー): タイトル + 「Embedding 対象 ∩ UI 入力欄あり」項目 (background / content / result) を必須化
 *     (= 公開資産が提案エンジンで意味を持つよう本文の空公開を防ぐ)。
 *     conclusion / recommendation は UI 入力欄が無い (インポート専用) ため必須対象外。embedding 合成には引き続き含む。
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
    // v1.3.0 軽量入力 (2026-06-19): title は draft / public とも常に必須。
    //   draft (自分のみ) でも「最低限タイトルは付ける」を強制し、一覧での識別性を担保する。
    if (!data.title || data.title.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: 'タイトルを入力してください', path: ['title'] });
    }
    // v1.3.0: public 化時は「Embedding 対象 ∩ UI 入力欄あり」項目 (背景 / 内容 / 結果) も必須。
    //   公開資産が提案エンジンで意味を持つよう、本文が空のままの公開を防ぐ。
    //   conclusion / recommendation は UI 入力欄が無い (インポート専用) ため必須対象外。
    if (data.visibility === 'public') {
      if (!data.background || data.background.trim().length === 0) {
        ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合は背景を入力してください', path: ['background'] });
      }
      if (!data.content || data.content.trim().length === 0) {
        ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合は内容を入力してください', path: ['content'] });
      }
      if (!data.result || data.result.trim().length === 0) {
        ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合は結果を入力してください', path: ['result'] });
      }
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
  // v1.3.0 軽量入力: title は常に必須。明示的に空へ更新しようとした場合のみ拒否 (undefined = 変更なし)。
  if (data.title !== undefined && data.title.trim().length === 0) {
    ctx.addIssue({ code: 'custom', message: 'タイトルを入力してください', path: ['title'] });
  }
  // v1.3.0: public 化 / 維持の更新で、背景 / 内容 / 結果を空文字へ更新しようとした場合は拒否。
  //   フォーム未送信 (undefined) は既存値維持のためここでは弾かず、service 層ガードで最終検証する
  //   (= API 直叩きで本文未送信のまま public 化する経路を防ぐ)。
  if (data.visibility === 'public') {
    if (data.background !== undefined && data.background.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合は背景を入力してください', path: ['background'] });
    }
    if (data.content !== undefined && data.content.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合は内容を入力してください', path: ['content'] });
    }
    if (data.result !== undefined && data.result.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合は結果を入力してください', path: ['result'] });
    }
  }
});

export type CreateKnowledgeInput = z.infer<typeof createKnowledgeSchema>;
