import { z } from 'zod/v4';

/**
 * プロジェクト「リスク/課題一覧」からの一括更新リクエスト schema (PR #165 で project-scoped 化、
 * 元実装は PR #161 cross-list 用 / refactor/bulk-update-to-project-list)。
 *
 * 設計判断:
 *   - filterFingerprint は schema 互換維持のため残すが、サーバ側で値の検証はしない
 *     (Phase C 要件 18 でフィルター必須は撤廃。任意の複数行に対する一括編集を許可)。
 *   - **type フィールド (risk / issue) は維持**: 1 ページ (例: /projects/[id]/risks) では
 *     片方のみ表示するが、Issue 一覧 (/projects/[id]/issues) も同じ RisksClient を
 *     typeFilter='issue' で再利用するため、UI 表示状態として fingerprint に含める。
 *   - patch.deadline は YYYY-MM-DD 形式の文字列、または null (期限クリア)。
 *   - 全フィールドが省略された patch は no-op として 400 で弾く (誤操作防止)。
 *
 * 履歴:
 *   - Phase C 要件 18 (2026-04-28): isFilterApplied 撤廃。per-row reporter 判定 +
 *     ids 上限 500 + projectId scope で多層防御に集約。
 */
export const bulkUpdateRisksSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, '対象を 1 件以上選択してください').max(500, '一度に処理できるのは 500 件までです'),
  filterFingerprint: z.object({
    type: z.enum(['risk', 'issue']).optional(),
    state: z.enum(['open', 'in_progress', 'monitoring', 'resolved']).optional(),
    impact: z.enum(['low', 'medium', 'high']).optional(),
    assigneeId: z.string().uuid().optional(),
    keyword: z.string().optional(),
    /** PR #165: 「自分作成のみ」フィルター。project-list 共通の絞り込み軸。 */
    mineOnly: z.boolean().optional(),
  }),
  patch: z.object({
    state: z.enum(['open', 'in_progress', 'monitoring', 'resolved']).optional(),
    // null は明示クリア (担当者を外す)
    assigneeId: z.string().uuid().nullable().optional(),
    // null は明示クリア (期限を外す)
    deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  }).refine(
    (p) => p.state !== undefined || p.assigneeId !== undefined || p.deadline !== undefined,
    { message: '更新する項目を 1 つ以上指定してください' },
  ),
});

export type BulkUpdateRisksInput = z.infer<typeof bulkUpdateRisksSchema>;
