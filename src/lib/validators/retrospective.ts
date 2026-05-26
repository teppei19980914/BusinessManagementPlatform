import { z } from 'zod/v4';
import { MEDIUM_TEXT_MAX_LENGTH, LONG_TEXT_MAX_LENGTH } from '@/config';

/**
 * 2026-05-11: 振り返り作成スキーマ。
 *
 * 公開範囲 (visibility) に応じて必須チェックを切り替える:
 *   - 'draft' (自分のみ): 実施日が未入力でも保存可。サーバ側で当日日付を default として補完
 *   - 'public' (全メンバー): 実施日必須
 *
 *   5 本文セクション (計画総括 / 実績総括 / 良かった点 / 問題点 / 改善事項) は visibility に
 *   関わらず任意 (空文字許容)。
 */

/** 今日の日付を 'YYYY-MM-DD' で返す (Retrospective draft の conductedDate default 用)。 */
function todayDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export const createRetrospectiveSchema = z
  .object({
    // 2026-05-11: draft 保存時は当日日付を default として採用 (NOT NULL Date を満たす)。
    //   public 時は明示的に入力されていることを superRefine で検証 (= UI で意識的に選択させる)。
    conductedDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .default(todayDateString),
    // 5 セクション (計画総括 / 実績総括 / 良かった点 / 課題 / 次回改善事項) は visibility に関わらず任意。
    planSummary: z.string().max(MEDIUM_TEXT_MAX_LENGTH).default(''),
    actualSummary: z.string().max(MEDIUM_TEXT_MAX_LENGTH).default(''),
    goodPoints: z.string().max(LONG_TEXT_MAX_LENGTH).default(''),
    problems: z.string().max(LONG_TEXT_MAX_LENGTH).default(''),
    // feat/account-lock-and-ui-consistency 後 hotfix:
    // DB schema (Retrospective) で nullable な列は `.nullable().optional()` とする
    // (詳細は DEVELOPER_GUIDE §5.12)
    estimateGapFactors: z.string().max(LONG_TEXT_MAX_LENGTH).nullable().optional(),
    scheduleGapFactors: z.string().max(LONG_TEXT_MAX_LENGTH).nullable().optional(),
    qualityIssues: z.string().max(LONG_TEXT_MAX_LENGTH).nullable().optional(),
    riskResponseEvaluation: z.string().max(LONG_TEXT_MAX_LENGTH).nullable().optional(),
    improvements: z.string().max(LONG_TEXT_MAX_LENGTH).default(''),
    knowledgeToShare: z.string().max(LONG_TEXT_MAX_LENGTH).nullable().optional(),
    // PR #60: 公開範囲 (draft/public)
    // 2026-05-11: default 'draft' に変更 (= 「自分のみ」として一時保存可)
    visibility: z.enum(['draft', 'public']).default('draft'),
    // feat/asset-assignee-expansion (2026-05-26): 担当者 (作成者と並ぶ編集権限保持者)
    assigneeId: z.string().uuid().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    // 2026-05-11: public 時のみ conductedDate を厳格に検証 (draft 時は default で today が入る)
    if (data.visibility === 'public') {
      if (!data.conductedDate || !/^\d{4}-\d{2}-\d{2}$/.test(data.conductedDate)) {
        ctx.addIssue({
          code: 'custom',
          message: '「全メンバー」に公開する場合は実施日を入力してください',
          path: ['conductedDate'],
        });
      }
    }
  });

// updateRetrospectiveSchema: superRefine 後では .partial() が使えないため、内部 object から再構築。
const baseUpdateRetrospectiveSchema = z.object({
  conductedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  planSummary: z.string().max(MEDIUM_TEXT_MAX_LENGTH).optional(),
  actualSummary: z.string().max(MEDIUM_TEXT_MAX_LENGTH).optional(),
  goodPoints: z.string().max(LONG_TEXT_MAX_LENGTH).optional(),
  problems: z.string().max(LONG_TEXT_MAX_LENGTH).optional(),
  estimateGapFactors: z.string().max(LONG_TEXT_MAX_LENGTH).nullable().optional(),
  scheduleGapFactors: z.string().max(LONG_TEXT_MAX_LENGTH).nullable().optional(),
  qualityIssues: z.string().max(LONG_TEXT_MAX_LENGTH).nullable().optional(),
  riskResponseEvaluation: z.string().max(LONG_TEXT_MAX_LENGTH).nullable().optional(),
  improvements: z.string().max(LONG_TEXT_MAX_LENGTH).optional(),
  knowledgeToShare: z.string().max(LONG_TEXT_MAX_LENGTH).nullable().optional(),
  visibility: z.enum(['draft', 'public']).optional(),
  // feat/asset-assignee-expansion (2026-05-26): 編集時 assigneeId 更新も受入れ
  assigneeId: z.string().uuid().nullable().optional(),
});

export const updateRetrospectiveSchema = baseUpdateRetrospectiveSchema.superRefine((data, ctx) => {
  // public 化する更新では conductedDate が未指定 / 不正形式でないこと
  if (
    data.visibility === 'public' &&
    data.conductedDate !== undefined &&
    !/^\d{4}-\d{2}-\d{2}$/.test(data.conductedDate)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: '「全メンバー」に公開する場合は実施日を入力してください',
      path: ['conductedDate'],
    });
  }
});

// PR #199: コメントは polymorphic comments テーブルへ移行。
//   schema は src/lib/validators/comment.ts (createCommentSchema / updateCommentSchema) へ移管。

export type CreateRetrospectiveInput = z.infer<typeof createRetrospectiveSchema>;
