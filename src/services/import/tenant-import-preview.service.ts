/**
 * tenant import preview の共通ライフサイクル (TTL クリーンアップ)
 *
 * CSV 取込 (migration-import) と ZIP 取込が共有する `tenantImportPreview` テーブルの
 * 期限切れ行を物理削除する。日次 cron (daily-notifications) から呼ばれる。
 *
 * 経緯:
 *   旧「外部データ移行ウィザード」(external-data-import.service.ts) が保持していた
 *   `deleteExpiredPreviews` を、ウィザード撤去 (2026-06-08) に伴い本モジュールへ移設。
 *   preview テーブルは migration-import が引き続き利用するため、GC は存続が必要。
 *
 * 関連:
 *   - 利用元 cron: src/app/api/cron/daily-notifications/route.ts
 *   - preview 生成: src/services/import/migration-import.service.ts
 */

import { prisma } from '@/lib/db';

/**
 * 期限切れ (expiresAt < now) の取込プレビューを物理削除する。
 * @returns 削除件数
 */
export async function deleteExpiredPreviews(now: Date = new Date()): Promise<number> {
  const result = await prisma.tenantImportPreview.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return result.count;
}
