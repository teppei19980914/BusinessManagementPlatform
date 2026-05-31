/**
 * GET /api/attachments/[id]/download — Pre-signed Download URL 発行 + 302 redirect (ADR-0021)
 *
 * 認可:
 *   - 認証必須
 *   - getAttachment で viewerTenantId スコープ強制 (= 越境拒否)
 *   - 親 entity 認可 (read mode) で member 限定アクセス
 *
 * フロー:
 *   1. /api/attachments/{id}/download にアクセス
 *   2. 認証 + 認可 + storageProvider 判定
 *   3. supabase 型: Pre-signed Download URL (TTL 60s) を発行 → 302 redirect
 *   4. url 型: 既存 url 列を 302 redirect (legacy)
 *
 * 関連:
 *   - ADR: docs/adr/0021-file-storage-usage-based-billing.md §10
 *   - Pre-signed URL 発行: src/lib/supabase-storage.ts createSignedDownloadUrl()
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { authorizeForAttachmentEntity } from '@/services/attachment.service';
import type { AttachmentEntityType } from '@/lib/validators/attachment';
import { createSignedDownloadUrl } from '@/lib/supabase-storage';
import { recordError } from '@/services/error-log.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const t = await getTranslations('message');

  // tenant scope を強制した attachment lookup (越境試行は 404)
  const attachment = await prisma.attachment.findFirst({
    where: { id, deletedAt: null, tenantId: user.tenantId },
    select: {
      id: true,
      entityType: true,
      entityId: true,
      storageProvider: true,
      storageObjectKey: true,
      url: true,
      // security/phase-2 (2026-05-31): downloadFilename として Pre-signed URL の
      //   Content-Disposition: attachment; filename="..." に差し込む
      displayName: true,
    },
  });
  if (!attachment) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }

  // 親 entity 認可 (read)
  const authz = await authorizeForAttachmentEntity({
    user,
    entityType: attachment.entityType as AttachmentEntityType,
    entityId: attachment.entityId,
    mode: 'read',
  });
  if (!authz.ok) {
    return NextResponse.json(
      {
        error: {
          code: authz.code,
          message: authz.code === 'NOT_FOUND' ? t('notFoundTarget') : t('forbidden'),
        },
      },
      { status: authz.status },
    );
  }

  // url 型 (= legacy 外部リンク): そのまま redirect
  if (attachment.storageProvider !== 'supabase' || !attachment.storageObjectKey) {
    return NextResponse.redirect(attachment.url, 302);
  }

  // supabase 型: Pre-signed Download URL を発行 (60 秒 TTL)
  //   security/phase-2 (2026-05-31): downloadFilename を渡し Content-Disposition: attachment 強制。
  //     SVG/HTML/危険 PDF の inline 実行 → 保管型 XSS の経路を構造的に遮断。
  try {
    const signedUrl = await createSignedDownloadUrl(attachment.storageObjectKey, 60, {
      downloadFilename: attachment.displayName ?? undefined,
    });
    return NextResponse.redirect(signedUrl, 302);
  } catch (e) {
    await recordError({
      severity: 'error',
      source: 'server',
      message: '[attachments/download] Pre-signed URL 発行失敗',
      stack: e instanceof Error ? e.stack : undefined,
      context: {
        kind: 'attachment_download_sign_failed',
        attachmentId: id,
        tenantId: user.tenantId,
        error: e instanceof Error ? e.message : String(e),
      },
    });
    return NextResponse.json(
      {
        error: {
          code: 'DOWNLOAD_URL_FAILED',
          message: 'ダウンロード URL の発行に失敗しました。',
        },
      },
      { status: 503 },
    );
  }
}
