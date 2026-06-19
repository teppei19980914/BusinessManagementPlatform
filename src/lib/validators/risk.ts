import { z } from 'zod/v4';
import {
  NAME_MAX_LENGTH,
  MEDIUM_TEXT_MAX_LENGTH,
  NOTES_MAX_LENGTH,
} from '@/config';

// feat/account-lock-and-ui-consistency 後 hotfix:
// DB schema (RiskIssue) で nullable な列は **`.nullable().optional()`** とすること。
// `.optional()` だけでは Zod は `null` を拒否するため、編集 dialog が
// `assigneeId: form.assigneeId || null` のように null 送信したとき
// 「Invalid input: expected string, received null」400 を返してしまう。
// 関連: DEVELOPER_GUIDE.md §5.12
/**
 * 2026-05-11 / v1.3.0 軽量入力 (2026-06-19) 改訂: リスク/課題 作成スキーマ。
 *
 * 公開範囲 (visibility) に応じて必須チェックを切り替える:
 *   - 'draft' (自分のみ): **件名 (title) のみ必須**。他項目は空でも保存可 (impact は default 'medium')
 *   - 'public' (全メンバー): 件名 + 「Embedding 対象 ∩ UI 入力欄あり」項目
 *     (occurrence / cause / responsePolicy / content) を必須化。
 *     impact / likelihood / priority は Embedding 対象外のため常に任意。
 *     responseDetail は UI 入力欄が無い (インポート専用) ため必須対象外 (embedding 合成には含む)。
 *
 *   type ('risk' / 'issue') は UI 上「リスク追加」「課題追加」ボタンから生成され、
 *   ユーザが直接入力しない (常に UI コンテキストで設定済)。
 */
export const createRiskSchema = z
  .object({
    type: z.enum(['risk', 'issue']),
    // 2026-05-11: draft 保存時に空 OK (default '')。public 時は superRefine で必須化。
    title: z.string().max(NAME_MAX_LENGTH).default(''),
    // refactor/list-create-content-optional (2026-04-27 ユーザ要望 #6):
    // 内容は visibility に関わらず任意 (空文字許容)。
    // feat/risk-issue-4-section (2026-05-26): UI 上 content は「メモ」セクションにリネーム。
    //   フィールド名は変更せず後方互換維持 (DB 列名 / API 入力名 / 既存呼出側に影響しない)。
    content: z.string().max(MEDIUM_TEXT_MAX_LENGTH).default(''),
    // feat/risk-issue-4-section (2026-05-26): 発生事象 (issue) / 考えられる事象 (risk)。
    //   visibility='public' のとき superRefine で必須化 (= 共有時に「何が起きたか」明示を強制)。
    occurrence: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
    cause: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
    // 2026-05-11: draft 時のデフォルトとして 'medium' を採用 (NOT NULL VarChar(10) を満たす)
    impact: z.enum(['low', 'medium', 'high']).default('medium'),
    likelihood: z.enum(['low', 'medium', 'high']).nullable().optional(),
    // PR-γ / 項目 2/7: priority は service 層 computePriority() で自動算出される。
    priority: z.enum(['high', 'medium', 'low', 'minimal']).optional(),
    responsePolicy: z.string().max(NOTES_MAX_LENGTH).nullable().optional(),
    responseDetail: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
    // assigneeId / deadline は編集 dialog で空に戻すと null 送信される (DB schema nullable)
    assigneeId: z.string().uuid().nullable().optional(),
    deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    // PR #60: 公開範囲 (draft/public) と リスク脅威/好機分類
    // 2026-05-11: default 'draft' に変更 (= 「自分のみ」として一時保存可)
    visibility: z.enum(['draft', 'public']).default('draft'),
    riskNature: z.enum(['threat', 'opportunity']).nullable().optional(),
  })
  .superRefine((data, ctx) => {
    // v1.3.0 軽量入力 (2026-06-19): 件名 (title) は draft / public とも常に必須。
    if (!data.title || data.title.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: '件名を入力してください', path: ['title'] });
    }
    // v1.3.0: public 化時は「Embedding 対象 ∩ UI 入力欄あり」項目を必須化。
    //   occurrence (発生事象/考えられる事象) / content (メモ) / cause (原因) / responsePolicy (対応策)。
    //   responseDetail は UI 入力欄が無い (インポート専用) ため必須対象外。
    //   draft (自分のみ) は気軽に下書きできるよう任意のまま。
    if (data.visibility === 'public') {
      if (!data.occurrence || data.occurrence.trim().length === 0) {
        ctx.addIssue({
          code: 'custom',
          message:
            data.type === 'risk'
              ? '「全メンバー」に公開する場合は「考えられる事象」を入力してください'
              : '「全メンバー」に公開する場合は「発生事象」を入力してください',
          path: ['occurrence'],
        });
      }
      if (!data.cause || data.cause.trim().length === 0) {
        ctx.addIssue({
          code: 'custom',
          message:
            data.type === 'risk'
              ? '「全メンバー」に公開する場合は「考えられる原因」を入力してください'
              : '「全メンバー」に公開する場合は「直接原因」を入力してください',
          path: ['cause'],
        });
      }
      if (!data.responsePolicy || data.responsePolicy.trim().length === 0) {
        ctx.addIssue({
          code: 'custom',
          message:
            data.type === 'risk'
              ? '「全メンバー」に公開する場合は「考えられる対応策」を入力してください'
              : '「全メンバー」に公開する場合は「対応策」を入力してください',
          path: ['responsePolicy'],
        });
      }
      if (!data.content || data.content.trim().length === 0) {
        ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合はメモを入力してください', path: ['content'] });
      }
    }
  });

// updateRiskSchema: superRefine 後では .partial().extend が使えないため、内部 object から再構築。
const baseUpdateRiskSchema = z.object({
  type: z.enum(['risk', 'issue']).optional(),
  title: z.string().max(NAME_MAX_LENGTH).optional(),
  content: z.string().max(MEDIUM_TEXT_MAX_LENGTH).optional(),
  // feat/risk-issue-4-section (2026-05-26): 編集時の occurrence 受入
  occurrence: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
  cause: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
  impact: z.enum(['low', 'medium', 'high']).optional(),
  likelihood: z.enum(['low', 'medium', 'high']).nullable().optional(),
  priority: z.enum(['high', 'medium', 'low', 'minimal']).optional(),
  responsePolicy: z.string().max(NOTES_MAX_LENGTH).nullable().optional(),
  responseDetail: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  visibility: z.enum(['draft', 'public']).optional(),
  riskNature: z.enum(['threat', 'opportunity']).nullable().optional(),
  state: z.enum(['open', 'in_progress', 'monitoring', 'resolved']).optional(),
  result: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
  lessonLearned: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
});

export const updateRiskSchema = baseUpdateRiskSchema.superRefine((data, ctx) => {
  // v1.3.0 軽量入力: 件名は常に必須。明示的に空へ更新しようとした場合のみ拒否。
  if (data.title !== undefined && data.title.trim().length === 0) {
    ctx.addIssue({ code: 'custom', message: '件名を入力してください', path: ['title'] });
  }
  // v1.3.0: public 化 / 維持の更新で occurrence / cause / responsePolicy / content を空へ更新しようとした
  //   場合は拒否 (= undefined はサーバ既存値維持。本文未送信での public 化は service 層ガードで最終検証)。
  if (data.visibility === 'public') {
    if (data.occurrence !== undefined && data.occurrence !== null && data.occurrence.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        message:
          data.type === 'risk'
            ? '「全メンバー」に公開する場合は「考えられる事象」を入力してください'
            : '「全メンバー」に公開する場合は「発生事象」を入力してください',
        path: ['occurrence'],
      });
    }
    if (data.cause !== undefined && data.cause !== null && data.cause.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        message:
          data.type === 'risk'
            ? '「全メンバー」に公開する場合は「考えられる原因」を入力してください'
            : '「全メンバー」に公開する場合は「直接原因」を入力してください',
        path: ['cause'],
      });
    }
    if (data.responsePolicy !== undefined && data.responsePolicy !== null && data.responsePolicy.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        message:
          data.type === 'risk'
            ? '「全メンバー」に公開する場合は「考えられる対応策」を入力してください'
            : '「全メンバー」に公開する場合は「対応策」を入力してください',
        path: ['responsePolicy'],
      });
    }
    if (data.content !== undefined && data.content.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合はメモを入力してください', path: ['content'] });
    }
  }
});

export type CreateRiskInput = z.infer<typeof createRiskSchema>;
