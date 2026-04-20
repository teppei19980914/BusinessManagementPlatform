/**
 * テーマ設定の入力バリデータ (PR #72)。
 * THEMES 定数のキーと完全一致するもののみ許可する。
 */

import { z } from 'zod';
import { THEMES } from '@/types';

const themeKeys = Object.keys(THEMES) as [keyof typeof THEMES, ...(keyof typeof THEMES)[]];

export const updateThemeSchema = z.object({
  theme: z.enum(themeKeys),
});

export type UpdateThemeInput = z.infer<typeof updateThemeSchema>;
