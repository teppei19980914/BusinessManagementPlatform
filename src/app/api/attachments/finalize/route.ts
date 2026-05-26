/**
 * POST /api/attachments/finalize — アップロード完了後の DB row 確定 (ADR-0021 §2.2 / §10.2.2)
 *
 * Pre-signed URL でブラウザが直接 Supabase Storage に PUT した後に呼ばれる。
 *
 * フロー:
 *   1. 認証 (getAuthenticatedUser)
 *   2. 入力 validation (finalizeRequestSchema)
 *   3. objectKey が tenant prefix と一致するか検証 (path traversal 防止)
 *   4. 危険拡張子の再チェック (defense-in-depth)
 *   5. entity 認可 (write モード)
 *   6. Supabase API でオブジェクト実在 + 実サイズ確認
 *   7. 実サイズ > 50MB なら即時削除 + 413 reject
 *   8. transaction:
 *      a. Attachment row 作成 (storageProvider='supabase'、embeddingStatus=判定済)
 *      b. assertFileStorageLimitInTx (50GB ハードキャップ + peak MAX + level)
 *   9. audit log
 *  10. レスポンス: { attachment }
 *
 * 関連:
 *   - ADR: docs/adr/0021-file-storage-usage-based-billing.md §10.2.2
 *   - 前段: src/app/api/attachments/upload/route.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { finalizeRequestSchema } from '@/lib/validators/attachment-upload';
import { authorizeForAttachmentEntity } from '@/services/attachment.service';
import {
  assertFileStorageLimitInTx,
  mapFileStorageGuardErrorToResponse,
  FileStorageLimitExceededError,
} from '@/services/storage-guard.service';
import { deleteObject, getObjectInfo } from '@/lib/supabase-storage';
import {
  isDangerousExtension,
  isEmbeddingSupported,
  FILE_STORAGE_MAX_FILE_SIZE_BYTES,
} from '@/config/file-storage-pricing';
import { recordAuditLog } from '@/services/audit.service';
import { recordError } from '@/services/error-log.service';

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const t = await getTranslations('message');
  const body = await req.json().catch(() => null);
  const parsed = finalizeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // 1. objectKey の tenant prefix 検証 (path traversal / 越境防止、ADR-0021 §10.5)
  const expectedPrefix = `tenants/${user.tenantId}/${input.entityType}/${input.entityId}/`;
  if (!input.objectKey.startsWith(expectedPrefix)) {
    return NextResponse.json(
      { error: { code: 'INVALID_OBJECT_KEY', message: 'object key が不正です' } },
      { status: 400 },
    );
  }

  // 2. 危険拡張子 再チェック (defense-in-depth)
  if (isDangerousExtension(input.fileName)) {
    // 既にアップロード済なので Storage からも削除
    await deleteObject(input.objectKey).catch(() => undefined);
    return NextResponse.json(
      {
        error: {
          code: 'DANGEROUS_FILE_TYPE',
          message: 'この拡張子のファイルはセキュリティ上の理由でアップロードできません',
        },
      },
      { status: 400 },
    );
  }

  // 3. entity 認可 (write)
  const authz = await authorizeForAttachmentEntity({
    user,
    entityType: input.entityType,
    entityId: input.entityId,
    mode: 'write',
  });
  if (!authz.ok) {
    // 認可失敗時もアップロード済オブジェクトを掃除する (= 越境で他テナント領域に書かれないが、念のため)
    await deleteObject(input.objectKey).catch(() => undefined);
    return NextResponse.json(
      { error: { code: authz.code, message: authz.code === 'NOT_FOUND' ? t('notFoundTarget') : t('forbidden') } },
      { status: authz.status },
    );
  }

  // 4. Supabase 上のオブジェクト実在 + 実サイズ確認
  let actualSize: number;
  let actualMime: string | null;
  try {
    const info = await getObjectInfo(input.objectKey);
    if (!info) {
      return NextResponse.json(
        {
          error: {
            code: 'OBJECT_NOT_FOUND',
            message: 'アップロードされたファイルが見つかりません。再度アップロードしてください。',
          },
        },
        { status: 404 },
      );
    }
    actualSize = info.size;
    actualMime = info.contentType;
  } catch (e) {
    await recordError({
      severity: 'error',
      source: 'server',
      message: '[attachments/finalize] Storage オブジェクト情報取得失敗',
      stack: e instanceof Error ? e.stack : undefined,
      context: {
        kind: 'attachment_finalize_info_failed',
        tenantId: user.tenantId,
        objectKey: input.objectKey,
        error: e instanceof Error ? e.message : String(e),
      },
    });
    return NextResponse.json(
      { error: { code: 'STORAGE_UNAVAILABLE', message: 'ストレージにアクセスできません。' } },
      { status: 503 },
    );
  }

  // 5. 実サイズが 50MB 超なら即時削除 (= 申告サイズ詐称対策)
  if (actualSize > FILE_STORAGE_MAX_FILE_SIZE_BYTES) {
    await deleteObject(input.objectKey).catch(() => undefined);
    return NextResponse.json(
      {
        error: {
          code: 'FILE_TOO_LARGE',
          message: `ファイル サイズが上限 ${Math.floor(FILE_STORAGE_MAX_FILE_SIZE_BYTES / 1_000_000)}MB を超えています`,
          actualBytes: actualSize,
        },
      },
      { status: 413 },
    );
  }

  // 6. transaction: Attachment row 作成 + storage-guard post-check (50GB ハードキャップ)
  const embeddingStatus = isEmbeddingSupported(input.fileName) ? 'pending' : 'unsupported';

  try {
    const created = await prisma.$transaction(async (tx) => {
      const attachment = await tx.attachment.create({
        data: {
          tenantId: user.tenantId,
          entityType: input.entityType,
          entityId: input.entityId,
          slot: input.slot,
          displayName: input.displayName,
          // ADR-0021: storage provider が supabase の場合 url は Supabase 経由の参照表示用
          //   path のみ DB に保持し、表示は Pre-signed Download URL を都度発行する設計。
          //   url 列は post-PR-A 互換のため Storage Object Key と同値を入れておく。
          url: input.objectKey,
          mimeHint: input.mimeType ?? actualMime,
          addedBy: user.id,
          storageProvider: 'supabase',
          storageObjectKey: input.objectKey,
          sizeBytes: BigInt(actualSize),
          embeddingStatus,
        },
        include: { addedByUser: { select: { name: true } } },
      });
      await assertFileStorageLimitInTx(tx, user.tenantId, actualSize);
      return attachment;
    });

    await recordAuditLog({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'CREATE',
      entityType: 'attachment',
      entityId: created.id,
    });

    return NextResponse.json(
      {
        data: {
          id: created.id,
          entityType: created.entityType,
          entityId: created.entityId,
          slot: created.slot,
          displayName: created.displayName,
          mimeHint: created.mimeHint,
          sizeBytes: created.sizeBytes ? Number(created.sizeBytes) : null,
          storageObjectKey: created.storageObjectKey,
          storageProvider: created.storageProvider,
          embeddingStatus: created.embeddingStatus,
          addedBy: created.addedBy,
          addedByName: created.addedByUser?.name ?? null,
          createdAt: created.createdAt.toISOString(),
        },
      },
      { status: 201 },
    );
  } catch (e) {
    // ★ KDD §5.X+146: finalize transaction が失敗した時は **どの例外でも** Storage 上のオブジェクトを削除。
    //   ハードキャップ超過 (FileStorageLimitExceededError) のみ削除する旧実装では、
    //   DB conflict / FK 制約違反 / network blip 等の予期せぬ例外で orphan Storage object が
    //   残り、bucket 使用量に課金されてしまう (= 数 % drift の原因)。
    //   失敗時にこの cleanup を実行 → 例外を再 throw する設計に統一する。
    await deleteObject(input.objectKey).catch(() => undefined);

    if (e instanceof FileStorageLimitExceededError) {
      const mapped = mapFileStorageGuardErrorToResponse(e);
      if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
    }
    throw e;
  }
}
