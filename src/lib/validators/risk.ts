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
 * 2026-05-11: リスク/課題 作成スキーマ。
 *
 * 公開範囲 (visibility) に応じて必須チェックを切り替える:
 *   - 'draft' (自分のみ): 件名空 / impact 未指定でも保存可 (DB は default 'medium' で NOT NULL を満たす)
 *   - 'public' (全メンバー): 件名必須 + impact 必須
 *
 *   type ('risk' / 'issue') は UI 上「リスク追加」「課題追加」ボタンから生成され、
 *   ユーザが直接入力しない (常に UI コンテキストで設定済) ため draft でも必須を維持する。
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
    if (data.visibility === 'public' && (!data.title || data.title.trim().length === 0)) {
      ctx.addIssue({
        code: 'custom',
        message: '「全メンバー」に公開する場合は件名を入力してください',
        path: ['title'],
      });
    }
    // feat/risk-issue-4-section (2026-05-26): public 共有時は「発生事象」必須化。
    //   draft (自分のみ) は気軽に下書きできるよう任意のまま。共有 = 他者に状況伝達するため
    //   何が起きたか / 何を懸念するか を明示する設計。
    if (
      data.visibility === 'public'
      && (!data.occurrence || data.occurrence.trim().length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          data.type === 'risk'
            ? '「全メンバー」に公開する場合は「考えられる事象」を入力してください'
            : '「全メンバー」に公開する場合は「発生事象」を入力してください',
        path: ['occurrence'],
      });
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
  if (data.visibility === 'public' && data.title !== undefined && data.title.trim().length === 0) {
    ctx.addIssue({
      code: 'custom',
      message: '「全メンバー」に公開する場合は件名を入力してください',
      path: ['title'],
    });
  }
  // feat/risk-issue-4-section (2026-05-26): public 化更新時の occurrence 必須チェック。
  //   入力で明示的に空文字を指定するケースのみ拒否 (= undefined はサーバ既存値維持)。
  if (
    data.visibility === 'public'
    && data.occurrence !== undefined
    && data.occurrence !== null
    && data.occurrence.trim().length === 0
  ) {
    ctx.addIssue({
      code: 'custom',
      message:
        data.type === 'risk'
          ? '「全メンバー」に公開する場合は「考えられる事象」を入力してください'
          : '「全メンバー」に公開する場合は「発生事象」を入力してください',
      path: ['occurrence'],
    });
  }
});

export type CreateRiskInput = z.infer<typeof createRiskSchema>;
