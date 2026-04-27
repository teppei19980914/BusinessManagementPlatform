import { z } from 'zod/v4';

/**
 * 「全リスク / 全課題」横断ビューからの一括更新リクエスト schema (PR #161)。
 *
 * 設計判断:
 *   - filterApplied は **クライアントが何らかのフィルターを適用したか** を示す boolean。
 *     ユーザ要望「フィルターをかけずに行うと一括選択した時の対象がやけに広くなるので、
 *     危険性を排除するため、必ずフィルターをかけることを必須としてください」を
 *     **サーバ側でも強制** する (UI 側だけでは API 直叩きで bypass できるため)。
 *     boolean 単体ではなく filterFingerprint object でフィルター内容を貰い、
 *     そこから「any field set?」で判定することで「ボタン無効化を JS で剥がした」回避を防ぐ。
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
 * type 指定 (risk / issue タブ) は **暗黙のフィルターとしてカウントする** (ユーザは
 * 「全課題」タブを選んだ時点で課題に絞り込んでいる)。
 */
export function isFilterApplied(fingerprint: BulkUpdateRisksInput['filterFingerprint']): boolean {
  return Boolean(
    fingerprint.type ||
    fingerprint.state ||
    fingerprint.impact ||
    fingerprint.assigneeId ||
    (fingerprint.keyword && fingerprint.keyword.trim().length > 0),
  );
}
