/**
 * POST /api/attachments/upload — Pre-signed Upload URL 発行 (ADR-0021 §2.2 / §10)
 *
 * フロー:
 *   1. 認証 (getAuthenticatedUser)
 *   2. 入力 validation (uploadRequestSchema、entityType / entityId / fileName / sizeBytes)
 *   3. entity 認可 (= 親エンティティに対する write 権限)
 *   4. per-tenant Pre-signed URL 発行レート制限 (10/min、ADR-0021 §10.2.1)
 *   5. 危険拡張子 blacklist チェック (.exe / .sh 等)
 *   6. ファイル名 sanitize + sizeBytes <= 50MB
 *   7. precheckFileStorageLimit (cache 50GB ハードキャップ判定、ADR-0021 §10.7)
 *   8. Object Key 構築 (= 'tenants/{tid}/{entityType}/{eid}/{uuid}-{safeName}')
 *   9. Supabase Pre-signed Upload URL 発行 (TTL 60 秒)
 *  10. レスポンス: { uploadUrl, token, objectKey, sanitizedFileName, expiresIn }
 *
 * 認可:
 *   memo entity は Pre-signed URL アップロード対象外 (= URL 添付のみ仕様)。
 *
 * 関連:
 *   - ADR: docs/adr/0021-file-storage-usage-based-billing.md §10
 *   - 後続 finalize: src/app/api/attachments/finalize/route.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { applySubjectRateLimit } from '@/lib/rate-limit';
import { uploadRequestSchema } from '@/lib/validators/attachment-upload';
import { authorizeForAttachmentEntity } from '@/services/attachment.service';
import { precheckFileStorageLimit } from '@/services/storage-guard.service';
import { createSignedUploadUrl } from '@/lib/supabase-storage';
import {
  buildStorageObjectKey,
  isDangerousExtension,
  sanitizeFileName,
  PRESIGNED_URL_RATE_LIMIT_PER_MIN,
  PRESIGNED_URL_TTL_SECONDS,
  FILE_STORAGE_MAX_FILE_SIZE_BYTES,
} from '@/config/file-storage-pricing';
import { recordError } from '@/services/error-log.service';

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  // 1. レート制限 (per-tenant 10/min、Pre-signed URL 発行スパム防止)
  const limited = applySubjectRateLimit({
    key: 'attachment-upload',
    subjectId: user.tenantId,
    max: PRESIGNED_URL_RATE_LIMIT_PER_MIN,
  });
  if (limited) return limited;

  // 2. 入力 validation
  const body = await req.json().catch(() => null);
  const parsed = uploadRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // 3. ファイル名 sanitize + 危険拡張子チェック
  const sanitizedFileName = sanitizeFileName(input.fileName);
  if (sanitizedFileName.length === 0) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'ファイル名が無効です' } },
      { status: 400 },
    );
  }
  if (isDangerousExtension(sanitizedFileName)) {
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

  // 4. サイズ上限再検証 (validator でも検証済だが defense-in-depth)
  if (input.sizeBytes > FILE_STORAGE_MAX_FILE_SIZE_BYTES) {
    return NextResponse.json(
      {
        error: {
          code: 'FILE_TOO_LARGE',
          message: `ファイル サイズが上限 ${Math.floor(FILE_STORAGE_MAX_FILE_SIZE_BYTES / 1_000_000)}MB を超えています`,
        },
      },
      { status: 413 },
    );
  }

  // 5. entity 認可 (write モード)
  const authz = await authorizeForAttachmentEntity({
    user,
    entityType: input.entityType,
    entityId: input.entityId,
    mode: 'write',
  });
  if (!authz.ok) {
    return NextResponse.json(
      { error: { code: authz.code } },
      { status: authz.status },
    );
  }

  // 6. ストレージ pre-check (Beginner 100MB / 全プラン 50GB ハードキャップ)
  const cap = await precheckFileStorageLimit(user.tenantId, input.sizeBytes);
  if (!cap.ok) {
    // ADR-0025 (2026-05-29): Beginner プラン専用 UX 文言 + アップグレード誘導
    if (cap.code === 'BEGINNER_STORAGE_QUOTA_EXCEEDED') {
      return NextResponse.json(
        {
          error: {
            code: 'BEGINNER_STORAGE_QUOTA_EXCEEDED',
            message:
              'Beginner プランの無料枠 (DB 50MB / Storage 100MB) を超えました。不要なデータを削除する、または Expert プランへアップグレードしてください。',
            quotaType: 'storage' as const,
            currentBytes: cap.cachedUsedBytes,
            limitBytes: cap.limitBytes,
            upgradeUrl: '/settings/tenant',
          },
        },
        { status: 403 },
      );
    }
    return NextResponse.json(
      {
        error: {
          code: cap.code,
          message:
            'ファイル添付の容量が上限 50GB に達しました。不要なファイルを削除してから再度お試しください。既存ファイルのダウンロードは引き続き可能です。',
          currentBytes: cap.cachedUsedBytes,
          limitBytes: cap.limitBytes,
        },
      },
      { status: 403 },
    );
  }

  // 7. Object Key 構築 (tenant prefix 強制、ADR-0021 §10.5)
  const uploadUuid = randomUUID();
  const objectKey = buildStorageObjectKey({
    tenantId: user.tenantId,
    entityType: input.entityType,
    entityId: input.entityId,
    uuid: uploadUuid,
    fileName: sanitizedFileName,
  });

  // 8. Supabase Pre-signed Upload URL 発行
  try {
    const signed = await createSignedUploadUrl(objectKey);
    return NextResponse.json({
      data: {
        uploadUrl: signed.signedUrl,
        token: signed.token,
        objectKey: signed.path,
        sanitizedFileName,
        expiresInSeconds: PRESIGNED_URL_TTL_SECONDS,
      },
    });
  } catch (e) {
    await recordError({
      severity: 'error',
      source: 'server',
      message: '[attachments/upload] Pre-signed URL 発行失敗',
      stack: e instanceof Error ? e.stack : undefined,
      context: {
        kind: 'attachment_upload_sign_failed',
        tenantId: user.tenantId,
        objectKey,
        error: e instanceof Error ? e.message : String(e),
      },
    });
    return NextResponse.json(
      {
        error: {
          code: 'UPLOAD_URL_FAILED',
          message: 'アップロード URL の発行に失敗しました。しばらくしてから再度お試しください。',
        },
      },
      { status: 503 },
    );
  }
}
