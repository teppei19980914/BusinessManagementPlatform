import { z } from 'zod/v4';
import { MEDIUM_TEXT_MAX_LENGTH, LONG_TEXT_MAX_LENGTH } from '@/config';

export const createRetrospectiveSchema = z.object({
  conductedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // refactor/list-create-content-optional (2026-04-27 ユーザ要望 #6):
  // 振り返りはタイトルを持たないが、実施日 (conductedDate) のみ必須維持。
  // 5 セクション (計画総括 / 実績総括 / 良かった点 / 課題 / 次回改善事項) は全て任意化。
  planSummary: z.string().max(MEDIUM_TEXT_MAX_LENGTH),
  actualSummary: z.string().max(MEDIUM_TEXT_MAX_LENGTH),
  goodPoints: z.string().max(LONG_TEXT_MAX_LENGTH),
  problems: z.string().max(LONG_TEXT_MAX_LENGTH),
  // feat/account-lock-and-ui-consistency 後 hotfix:
  // DB schema (Retrospective) で nullable な列は `.nullable().optional()` とする
  // (詳細は DEVELOPER_GUIDE §5.12)
  estimateGapFactors: z.string().max(LONG_TEXT_MAX_LENGTH).nullable().optional(),
  scheduleGapFactors: z.string().max(LONG_TEXT_MAX_LENGTH).nullable().optional(),
  qualityIssues: z.string().max(LONG_TEXT_MAX_LENGTH).nullable().optional(),
  riskResponseEvaluation: z.string().max(LONG_TEXT_MAX_LENGTH).nullable().optional(),
  improvements: z.string().max(LONG_TEXT_MAX_LENGTH),
  knowledgeToShare: z.string().max(LONG_TEXT_MAX_LENGTH).nullable().optional(),
  // PR #60: 公開範囲 (draft/public)
  visibility: z.enum(['draft', 'public']).optional(),
});

export const updateRetrospectiveSchema = createRetrospectiveSchema.partial();

export const addCommentSchema = z.object({
  content: z.string().min(1, 'コメントを入力してください').max(MEDIUM_TEXT_MAX_LENGTH),
});

export type CreateRetrospectiveInput = z.infer<typeof createRetrospectiveSchema>;
