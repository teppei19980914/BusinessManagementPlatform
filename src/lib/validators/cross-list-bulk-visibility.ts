import { z } from 'zod/v4';

/**
 * 「全○○一覧」横断ビューからの **visibility 一括更新** schema (PR #162 / Phase 2)。
 *
 * 設計方針:
 *   - PR #161 (Risk/Issue 用) と同じ二重防御パターンを踏襲。filterFingerprint を
 *     必須化し、UI/API 両方で「フィルター無し全件更新」を防ぐ。
 *   - visibility の取りうる値は entity ごとに異なる:
 *       Retrospective / Knowledge: 'draft' / 'public'
 *       Memo                     : 'private' / 'public'
 *     → entity ごとに 3 つの schema を export し、enum で値域を限定する。
 *   - patch 対象は visibility 1 項目のみ (Phase 2 の対象範囲)。
 *     status / state / 担当者などはエンティティ間で意味が違うので Phase 2 では出さない。
 */

const filterFingerprintSchema = z.object({
  // 件名/タイトルに含まれる検索キーワード
  keyword: z.string().optional(),
  // 自分作成のみフィルター適用 (UI 側のチェックボックス)
  mineOnly: z.boolean().optional(),
});

export type CrossListBulkFilterFingerprint = z.infer<typeof filterFingerprintSchema>;

/**
 * filterFingerprint が「実質的にフィルター適用あり」かを判定する。
 * trim 後 0 文字の keyword はカウントしない (空白だけの保険を防ぐ)。
 */
export function isCrossListFilterApplied(f: CrossListBulkFilterFingerprint): boolean {
  return Boolean(
    f.mineOnly === true
    || (f.keyword && f.keyword.trim().length > 0),
  );
}

const idsSchema = z
  .array(z.string().uuid())
  .min(1, '対象を 1 件以上選択してください')
  .max(500, '一度に処理できるのは 500 件までです');

/**
 * 振り返り (Retrospective) 一括 visibility 更新。
 * 値域は schema 定義に従い 'draft' / 'public'。
 */
export const bulkUpdateRetrospectiveVisibilitySchema = z.object({
  ids: idsSchema,
  filterFingerprint: filterFingerprintSchema,
  visibility: z.enum(['draft', 'public']),
});

/**
 * ナレッジ (Knowledge) 一括 visibility 更新。'draft' / 'public'。
 */
export const bulkUpdateKnowledgeVisibilitySchema = z.object({
  ids: idsSchema,
  filterFingerprint: filterFingerprintSchema,
  visibility: z.enum(['draft', 'public']),
});

/**
 * メモ (Memo) 一括 visibility 更新。Memo だけは 'private' / 'public' (DB schema に準拠)。
 */
export const bulkUpdateMemoVisibilitySchema = z.object({
  ids: idsSchema,
  filterFingerprint: filterFingerprintSchema,
  visibility: z.enum(['private', 'public']),
});

export type BulkUpdateRetrospectiveVisibilityInput = z.infer<typeof bulkUpdateRetrospectiveVisibilitySchema>;
export type BulkUpdateKnowledgeVisibilityInput = z.infer<typeof bulkUpdateKnowledgeVisibilitySchema>;
export type BulkUpdateMemoVisibilityInput = z.infer<typeof bulkUpdateMemoVisibilitySchema>;
