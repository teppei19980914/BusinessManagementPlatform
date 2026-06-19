import { z } from 'zod/v4';
import { createRiskSchema } from './risk';
import { createKnowledgeSchema } from './knowledge';

/**
 * リスク → 課題 昇華リクエストのスキーマ (v1.3.0 資産導線機能)。
 *
 * createRiskSchema は superRefine 済みのため .extend() できない (risk.ts コメント参照)。
 * そのため riskId / projectId をトップレベルに、転記フォーム本体を input に nest する。
 */
export const promoteRiskToIssueSchema = z.object({
  riskId: z.string().uuid(),
  projectId: z.string().uuid(),
  input: createRiskSchema,
});

/**
 * 課題 → ナレッジ 昇華リクエストのスキーマ。
 * createKnowledge は projectId を取らず、input.projectIds (任意) で紐付けを行う
 * (knowledge.service.ts / createKnowledgeSchema と同じ規約)。
 */
export const promoteIssueToKnowledgeSchema = z.object({
  issueId: z.string().uuid(),
  input: createKnowledgeSchema,
});

export type PromoteRiskToIssueInput = z.infer<typeof promoteRiskToIssueSchema>;
export type PromoteIssueToKnowledgeInput = z.infer<typeof promoteIssueToKnowledgeSchema>;
