/**
 * ステークホルダー管理 (PMBOK 13) の Zod スキーマ。
 *
 * 設計判断:
 *   - influence / interest は 1-5 の整数 (DB 側にも CHECK 制約あり)
 *   - userId は内部メンバー紐付け用の任意 FK (外部関係者は null)
 *   - tags は文字列配列 (UI でカンマ区切り入力 → parseTagsInput で正規化済の前提)
 *   - DB nullable 列は `.nullable().optional()` 必須 (DEVELOPER_GUIDE §5.12)
 */

import { z } from 'zod/v4';
import {
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  MEDIUM_TEXT_MAX_LENGTH,
} from '@/config';
import {
  STAKEHOLDER_ATTITUDES,
  STAKEHOLDER_ENGAGEMENTS,
  STAKEHOLDER_LEVEL_MIN,
  STAKEHOLDER_LEVEL_MAX,
} from '@/config/master-data';

const attitudeKeys = Object.keys(STAKEHOLDER_ATTITUDES) as [
  keyof typeof STAKEHOLDER_ATTITUDES,
  ...Array<keyof typeof STAKEHOLDER_ATTITUDES>,
];
const engagementKeys = Object.keys(STAKEHOLDER_ENGAGEMENTS) as [
  keyof typeof STAKEHOLDER_ENGAGEMENTS,
  ...Array<keyof typeof STAKEHOLDER_ENGAGEMENTS>,
];

export const createStakeholderSchema = z.object({
  // 内部紐付け (任意)。空文字は UI 側で undefined 化することを推奨。
  userId: z.string().uuid().nullable().optional(),
  name: z.string().min(1, '氏名を入力してください').max(NAME_MAX_LENGTH),
  organization: z.string().max(NAME_MAX_LENGTH).nullable().optional(),
  role: z.string().max(NAME_MAX_LENGTH).nullable().optional(),
  contactInfo: z.string().max(NOTES_MAX_LENGTH).nullable().optional(),
  influence: z
    .number()
    .int()
    .min(STAKEHOLDER_LEVEL_MIN, '影響度は 1-5 で指定してください')
    .max(STAKEHOLDER_LEVEL_MAX, '影響度は 1-5 で指定してください'),
  interest: z
    .number()
    .int()
    .min(STAKEHOLDER_LEVEL_MIN, '関心度は 1-5 で指定してください')
    .max(STAKEHOLDER_LEVEL_MAX, '関心度は 1-5 で指定してください'),
  attitude: z.enum(attitudeKeys),
  currentEngagement: z.enum(engagementKeys),
  desiredEngagement: z.enum(engagementKeys),
  personality: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
  // タグ: 既に parse 済の string[] を受け取る (UI で trim/dedup 済み)
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  strategy: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
});

export const updateStakeholderSchema = createStakeholderSchema.partial();

export type CreateStakeholderInput = z.infer<typeof createStakeholderSchema>;
export type UpdateStakeholderInput = z.infer<typeof updateStakeholderSchema>;
