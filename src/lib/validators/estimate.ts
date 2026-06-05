import { z } from 'zod/v4';
import {
  NAME_MAX_LENGTH,
  LONG_TEXT_MAX_LENGTH,
  MEDIUM_TEXT_MAX_LENGTH,
  NOTES_MAX_LENGTH,
} from '@/config';

export const createEstimateSchema = z.object({
  itemName: z.string().min(1, '見積項目名を入力してください').max(NAME_MAX_LENGTH),
  category: z.enum(['requirements', 'design', 'development', 'testing', 'other']),
  // 2026-06-02: 開発方式 (devMethod) は見積もりフォームから撤去 (DB 列削除はステージングで実施予定)。
  //   未送信を許容するため optional 化。NOT NULL 列のため createEstimate 側で 'other' を既定補完する。
  //   (旧 'power_platform' は migration で 'low_code_no_code' に一括変換済)
  devMethod: z.enum(['scratch', 'low_code_no_code', 'package', 'other']).optional(),
  estimatedEffort: z.number().positive('見積工数は正の数で入力してください'),
  effortUnit: z.enum(['person_hour', 'person_day']),
  // 2026-06-02: 見積根拠は不要 (フォームを「備考」入力に変更)。未送信を許容するため optional 化。
  //   NOT NULL 列のため createEstimate で '' を既定補完する。
  rationale: z.string().max(LONG_TEXT_MAX_LENGTH).optional(),
  // feat/account-lock-and-ui-consistency 後 hotfix: DB nullable 列は .nullable() 必須 (§5.12)
  preconditions: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
  notes: z.string().max(NOTES_MAX_LENGTH).nullable().optional(),
});

export const updateEstimateSchema = createEstimateSchema.partial();

export type CreateEstimateInput = z.infer<typeof createEstimateSchema>;
