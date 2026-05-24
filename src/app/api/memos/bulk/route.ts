import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireStorageQuotaForWrite } from '@/lib/api-helpers';
import { bulkUpdateMemosVisibilityFromList } from '@/services/memo.service';
import { bulkUpdateMemoVisibilitySchema } from '@/lib/validators/cross-list-bulk-visibility';
import { recordAuditLog } from '@/services/audit.service';

/**
 * 個人「メモ一覧」(/memos) からの一括 visibility 更新 (PR #165 で /memos に移し替え、
 * 元実装は PR #162 /all-memos cross-list 用)。
 *
 * Memo は project に紐付かない個人ノートで、編集権限は元から作成者本人のみ。
 * scope は viewerUserId 自身のメモのみ (path は /api/memos/bulk のまま personal scope)。
 *
 * Memo は visibility 値域が `private` / `public` (DB schema) なので
 * 共通 schema は entity 別の enum に分かれている。
 *
 * 認可: 認証済みユーザならアクセス可、サービス層で per-row 作成者判定 + silent skip。
 * 安全策 (Phase C 要件 18): フィルター必須は撤廃。schema 側 patch 全省略禁止 +
 * per-row 作成者判定 + ids 上限で多層防御。
 */
export async function PATCH(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = bulkUpdateMemoVisibilitySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'VALIDATION_ERROR', details: parsed.error.format() },
      { status: 400 },
    );
  }

  // PR-5 (2026-05-15): ストレージ容量 Pre-check
  const quotaErr = await requireStorageQuotaForWrite(
    user.tenantId,
    JSON.stringify(parsed.data).length,
  );
  if (quotaErr) return quotaErr;

  const result = await bulkUpdateMemosVisibilityFromList(
    parsed.data.ids,
    parsed.data.visibility,
    user.id,
    user.tenantId,
  );

  // feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S1-A1): ADR-0011 全 mutation 記録に従う。
  //   個人メモのため entityId は本人 userId、scope は viewerUserId 自身のみ。
  if (result.updatedIds.length > 0) {
    await recordAuditLog({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'BULK_UPDATE',
      entityType: 'memo',
      entityId: user.id,
      afterValue: {
        visibility: parsed.data.visibility,
        updatedIds: result.updatedIds,
        skippedNotOwned: result.skippedNotOwned,
        skippedNotFound: result.skippedNotFound,
        // UI_PATTERNS §35.4.1 (2026-05-24): private→public 遷移行を batch 集約で embedding 生成した件数。
        //   Voyage API cost center のアトリビューション + 月次請求額追跡のため audit に残す。
        embeddingsGenerated: result.embeddingsGenerated,
      },
    });
  }

  return NextResponse.json({ data: result });
}
