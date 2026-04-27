import { z } from 'zod/v4';

/**
 * プロジェクト「リスク/課題一覧」からの一括更新リクエスト schema (PR #165 で project-scoped 化、
 * 元実装は PR #161 cross-list 用 / refactor/bulk-update-to-project-list)。
 *
 * 設計判断:
 *   - filterFingerprint で「クライアントが何らかのフィルターを適用したか」をサーバ側でも強制。
 *     ユーザ要望「フィルターをかけずに行うと一括選択した時の対象がやけに広くなるので、
 *     危険性を排除するため、必ずフィルターをかけることを必須としてください」を二重防御。
 *     boolean 単体ではなく fingerprint object でフィルター内容を貰い、そこから
 *     「any field set?」で判定することで「ボタン無効化を JS で剥がした」回避を防ぐ。
 *   - **type フィールド (risk / issue) は維持**: 1 ページ (例: /projects/[id]/risks) では
 *     片方のみ表示するが、Issue 一覧 (/projects/[id]/issues) も同じ RisksClient を
 *     typeFilter='issue' で再利用するため、暗黙のフィルターとしてカウントする。
 *   - patch.deadline は YYYY-MM-DD 形式の文字列、または null (期限クリア)。
 *   - 全フィールドが省略された patch は no-op として 400 で弾く (誤操作防止)。
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

/**
 * filterFingerprint が「実質的にフィルター適用あり」かを判定する。
 * type 指定 (risk / issue ページ識別) は **暗黙のフィルターとしてカウントする**
 * (Risk ページ vs Issue ページで RisksClient が type で絞り込んだ状態を表現)。
 */
export function isFilterApplied(fingerprint: BulkUpdateRisksInput['filterFingerprint']): boolean {
  return Boolean(
    fingerprint.type ||
    fingerprint.state ||
    fingerprint.impact ||
    fingerprint.assigneeId ||
    fingerprint.mineOnly === true ||
    (fingerprint.keyword && fingerprint.keyword.trim().length > 0),
  );
}
