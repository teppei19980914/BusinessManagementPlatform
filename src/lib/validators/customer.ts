/**
 * 顧客管理バリデータ (PR #111)。
 *
 * 運用:
 *   - システム管理者 (admin) のみ CRUD 可能 (認可は呼び出し元 API route で実施)
 *   - 物理削除方針 (論理削除列なし、将来論理削除に移行する可能性あり)
 *
 * 関連:
 *   - prisma/schema.prisma Customer モデル
 *   - docs/developer/DESIGN.md §Customer (PR #111-2 で追記)
 */

import { z } from 'zod/v4';
import { NAME_MAX_LENGTH, NOTES_MAX_LENGTH } from '@/config';

/**
 * 顧客作成スキーマ。
 * 必須: name のみ。他は任意項目 (段階的に情報拡充できる設計)。
 */
export const createCustomerSchema = z.object({
  name: z
    .string()
    .min(1, '顧客名を入力してください')
    .max(NAME_MAX_LENGTH, `顧客名は ${NAME_MAX_LENGTH} 文字以内で入力してください`),
  department: z.string().max(NAME_MAX_LENGTH).optional().nullable(),
  contactPerson: z.string().max(NAME_MAX_LENGTH).optional().nullable(),
  contactEmail: z
    .string()
    .email('有効なメールアドレスを入力してください')
    .max(255)
    .optional()
    .nullable()
    .or(z.literal('')),
  notes: z.string().max(NOTES_MAX_LENGTH).optional().nullable(),
});

export const updateCustomerSchema = createCustomerSchema.partial();

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
