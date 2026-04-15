import { z } from 'zod/v4';

export const createEstimateSchema = z.object({
  itemName: z.string().min(1, '見積項目名を入力してください').max(100),
  category: z.enum(['requirements', 'design', 'development', 'testing', 'other']),
  devMethod: z.enum(['scratch', 'power_platform', 'package', 'other']),
  estimatedEffort: z.number().positive('見積工数は正の数で入力してください'),
  effortUnit: z.enum(['person_hour', 'person_day']),
  rationale: z.string().min(1, '見積根拠を入力してください').max(3000),
  preconditions: z.string().max(2000).optional(),
  notes: z.string().max(1000).optional(),
});

export const updateEstimateSchema = createEstimateSchema.partial();

export type CreateEstimateInput = z.infer<typeof createEstimateSchema>;
