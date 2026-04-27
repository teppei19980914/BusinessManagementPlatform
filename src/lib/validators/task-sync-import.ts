/**
 * WBS 上書きインポート (Sync by ID) の Zod 検証 (feat/wbs-overwrite-import)。
 *
 * sync-import API の form-data:
 *   - file       : CSV ファイル
 *   - removeMode : 'keep' | 'warn' | 'delete' (確定実行時のみ必要)
 *
 * dryRun=1 のときは removeMode は不要 (preview だけ返す)。
 */

import { z } from 'zod/v4';

export const removeModeSchema = z.enum(['keep', 'warn', 'delete']);

export type RemoveMode = z.infer<typeof removeModeSchema>;
