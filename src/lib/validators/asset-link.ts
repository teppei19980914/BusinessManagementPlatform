import { z } from 'zod/v4';

/**
 * 手動リンクの対象資産種別 (v1.3.0 資産導線機能)。
 *
 * 5 種に固定: risk / issue (RiskIssue モデル、type discriminator で区別) /
 * knowledge / retrospective / memo。
 *
 * comment.ts の COMMENT_ENTITY_TYPES と同じ理由で as const 配列を単一ソースとし、
 * 型と実行時バリデーション (z.enum / Array.includes) の両方をここから導出する
 * (union 型に値を追加する際の実行時検証漏れを防ぐ)。
 */
export const LINKABLE_ENTITY_TYPES = ['risk', 'issue', 'knowledge', 'retrospective', 'memo'] as const;

export type LinkableEntityType = (typeof LINKABLE_ENTITY_TYPES)[number];

export const createAssetLinkSchema = z.object({
  fromEntityType: z.enum(LINKABLE_ENTITY_TYPES),
  fromEntityId: z.string().uuid(),
  toEntityType: z.enum(LINKABLE_ENTITY_TYPES),
  toEntityId: z.string().uuid(),
});

export type CreateAssetLinkInput = z.infer<typeof createAssetLinkSchema>;
