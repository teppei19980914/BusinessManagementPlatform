/**
 * ユーザ i18n 設定 (タイムゾーン / ロケール) 更新の入力バリデータ (PR #119 / PR #120)。
 *
 * 設計:
 *   - `timezone`: IANA タイムゾーン名 (例 'Asia/Tokyo') または null (システム既定に戻す)
 *   - `locale`: SELECTABLE_LOCALES=true のキー (例 'ja-JP') または null (システム既定に戻す)
 *   - 両キー optional: 片方だけ変更可能 ({ timezone: null } で TZ のみリセット 等)
 *
 * セキュリティ:
 *   - timezone は `Intl.DateTimeFormat` が受理する値かを `isValidTimezone` で検査 (DB 汚染防止)
 *   - locale は **`isSelectableLocale`** で検査 (PR #120)。SUPPORTED_LOCALES に載っていても
 *     SELECTABLE_LOCALES=false なロケール (例 en-US = 翻訳未完) は **API 層で 400 拒否**。
 *     UI 層の disabled と多層防御になり、curl 直叩き等の迂回を防ぐ。
 */

import { z } from 'zod';
import { isValidTimezone, isSelectableLocale } from '@/config/i18n';

export const updateI18nSchema = z.object({
  timezone: z
    .union([
      z.string().refine(isValidTimezone, {
        message: '未対応のタイムゾーンです',
      }),
      z.null(),
    ])
    .optional(),
  locale: z
    .union([
      z.string().refine(isSelectableLocale, {
        message: '未対応のロケールです (現時点で選択可能なロケールではありません)',
      }),
      z.null(),
    ])
    .optional(),
});

export type UpdateI18nInput = z.infer<typeof updateI18nSchema>;
