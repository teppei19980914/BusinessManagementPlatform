import { z } from 'zod/v4';
import { MEDIUM_TEXT_MAX_LENGTH, LONG_TEXT_MAX_LENGTH } from '@/config';

/**
 * 2026-05-11 / v1.3.0 軽量入力 (2026-06-19) 改訂: 振り返り作成スキーマ。
 *
 * 公開範囲 (visibility) に応じて必須チェックを切り替える:
 *   - 'draft' (自分のみ): 必須項目なし。実施日未入力でもサーバ側で当日日付を default 補完
 *     (振り返りは title 列が無いため「draft=title のみ必須」ルールの対象外)
 *   - 'public' (全メンバー): 「Embedding 対象 ∩ UI 入力欄あり」の 5 セクション
 *     (計画総括 / 実績総括 / 良かった点 / 課題 / 改善事項) を必須化。
 *
 *   実施日 (conductedDate) は日付項目のため常に任意 (v1.3.0 で public 必須を撤去)。
 *   knowledgeToShare は UI 入力欄が無い (インポート専用) ため必須対象外 (embedding 合成には含む)。
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
    // v1.3.0 軽量入力 (2026-06-19): 実施日 (conductedDate) は日付項目のため常に任意化
    //   (旧: public 必須)。代わりに public 化時は「Embedding 対象 ∩ UI 入力欄あり」の
    //   5 セクション (計画総括 / 実績総括 / 良かった点 / 課題 / 改善事項) を必須化し、
    //   公開資産が提案エンジンで意味を持つよう本文の空公開を防ぐ。
    //   knowledgeToShare は UI 入力欄が無い (インポート専用) ため必須対象外。
    if (data.visibility === 'public') {
      if (!data.planSummary || data.planSummary.trim().length === 0) {
        ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合は計画総括を入力してください', path: ['planSummary'] });
      }
      if (!data.actualSummary || data.actualSummary.trim().length === 0) {
        ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合は実績総括を入力してください', path: ['actualSummary'] });
      }
      if (!data.goodPoints || data.goodPoints.trim().length === 0) {
        ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合は良かった点を入力してください', path: ['goodPoints'] });
      }
      if (!data.problems || data.problems.trim().length === 0) {
        ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合は課題を入力してください', path: ['problems'] });
      }
      if (!data.improvements || data.improvements.trim().length === 0) {
        ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合は改善事項を入力してください', path: ['improvements'] });
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
  // v1.3.0 軽量入力: 実施日 (conductedDate) は常に任意 (public 必須を撤去。形式 regex は field 側で担保)。
  //   public 化 / 維持の更新で 5 セクションを空へ更新しようとした場合は拒否 (= undefined は既存値維持。
  //   本文未送信での public 化は service 層ガードで最終検証)。
  if (data.visibility === 'public') {
    if (data.planSummary !== undefined && data.planSummary.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合は計画総括を入力してください', path: ['planSummary'] });
    }
    if (data.actualSummary !== undefined && data.actualSummary.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合は実績総括を入力してください', path: ['actualSummary'] });
    }
    if (data.goodPoints !== undefined && data.goodPoints.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合は良かった点を入力してください', path: ['goodPoints'] });
    }
    if (data.problems !== undefined && data.problems.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合は課題を入力してください', path: ['problems'] });
    }
    if (data.improvements !== undefined && data.improvements.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合は改善事項を入力してください', path: ['improvements'] });
    }
  }
});

// PR #199: コメントは polymorphic comments テーブルへ移行。
//   schema は src/lib/validators/comment.ts (createCommentSchema / updateCommentSchema) へ移管。

export type CreateRetrospectiveInput = z.infer<typeof createRetrospectiveSchema>;
