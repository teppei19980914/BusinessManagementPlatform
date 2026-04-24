/**
 * ユーザ i18n 設定 (タイムゾーン / ロケール) 更新の入力バリデータ (PR #119)。
 *
 * 設計:
 *   - `timezone`: IANA タイムゾーン名 (例 'Asia/Tokyo') または null (システム既定に戻す)
 *   - `locale`: SUPPORTED_LOCALES のキー (例 'ja-JP') または null (システム既定に戻す)
 *   - 両キー optional: 片方だけ変更可能 ({ timezone: null } で TZ のみリセット 等)
 *
 * セキュリティ:
 *   - timezone は `Intl.DateTimeFormat` が受理する値かを `isValidTimezone` で検査 (DB 汚染防止)
 *   - locale は `SUPPORTED_LOCALES` に含まれるものだけ受理 (UI カタログ未整備の値を DB に書かない)
 */

import { z } from 'zod';
import { isValidTimezone, isSupportedLocale } from '@/config/i18n';

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
      z.string().refine(isSupportedLocale, {
        message: '未対応のロケールです',
      }),
      z.null(),
    ])
    .optional(),
});

export type UpdateI18nInput = z.infer<typeof updateI18nSchema>;
