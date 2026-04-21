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
  devMethod: z.enum(['scratch', 'power_platform', 'package', 'other']),
  estimatedEffort: z.number().positive('見積工数は正の数で入力してください'),
  effortUnit: z.enum(['person_hour', 'person_day']),
  rationale: z.string().min(1, '見積根拠を入力してください').max(LONG_TEXT_MAX_LENGTH),
  preconditions: z.string().max(MEDIUM_TEXT_MAX_LENGTH).optional(),
  notes: z.string().max(NOTES_MAX_LENGTH).optional(),
});

export const updateEstimateSchema = createEstimateSchema.partial();

export type CreateEstimateInput = z.infer<typeof createEstimateSchema>;
