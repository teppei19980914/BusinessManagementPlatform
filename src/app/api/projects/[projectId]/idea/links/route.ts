/**
 * GET    /api/projects/[projectId]/idea/links  — アイデアアセットリンク一覧 (source or target)
 * POST   /api/projects/[projectId]/idea/links  — リンク作成
 * DELETE /api/projects/[projectId]/idea/links?linkId=  — リンク削除
 *
 * クエリパラメータ (GET):
 *   sourceType + sourceId: アイデアソース側から取得
 *   targetType + targetId: 資産側から逆引き (リンクアイコン表示用)
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireActualProjectMember,
} from '@/lib/api-helpers';
import {
  createIdeaAssetLinkSchema,
  IDEA_LINK_SOURCE_TYPES,
  IDEA_LINK_TARGET_TYPES,
  type IdeaLinkSourceType,
  type IdeaLinkTargetType,
} from '@/lib/validators/idea-session';
import {
  getIdeaAssetLinks,
  getIdeaAssetLinksByTarget,
  createIdeaAssetLink,
  deleteIdeaAssetLink,
} from '@/services/idea-asset-link.service';
import { recordAuditLog } from '@/services/audit.service';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'idea:read');
  if (forbidden) return forbidden;

  const sp = new URL(req.url).searchParams;
  const sourceType = sp.get('sourceType');
  const sourceId = sp.get('sourceId');
  const targetType = sp.get('targetType');
  const targetId = sp.get('targetId');

  if (sourceType && sourceId) {
    if (!(IDEA_LINK_SOURCE_TYPES as readonly string[]).includes(sourceType)) {
      return NextResponse.json({ error: { code: 'INVALID_SOURCE_TYPE' } }, { status: 400 });
    }
    const links = await getIdeaAssetLinks(sourceType as IdeaLinkSourceType, sourceId, user.tenantId);
    return NextResponse.json({ data: links });
  }

  if (targetType && targetId) {
    if (!(IDEA_LINK_TARGET_TYPES as readonly string[]).includes(targetType)) {
      return NextResponse.json({ error: { code: 'INVALID_TARGET_TYPE' } }, { status: 400 });
    }
    const links = await getIdeaAssetLinksByTarget(targetType as IdeaLinkTargetType, targetId, user.tenantId);
    return NextResponse.json({ data: links });
  }

  return NextResponse.json(
    { error: { code: 'INVALID_PARAMS', message: 'sourceType+sourceId または targetType+targetId が必要です' } },
    { status: 400 },
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const memberOnly = await requireActualProjectMember(user, projectId);
  if (memberOnly) return memberOnly;
  const forbidden = await checkProjectPermission(user, projectId, 'idea:manage');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = createIdeaAssetLinkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  let link;
  try {
    link = await createIdeaAssetLink(
      parsed.data.sourceType,
      parsed.data.sourceId,
      parsed.data.targetType,
      parsed.data.targetId,
      user.id,
      user.tenantId,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'TARGET_NOT_FOUND') {
      return NextResponse.json({ error: { code: 'TARGET_NOT_FOUND' } }, { status: 404 });
    }
    if (msg === 'ALREADY_LINKED') {
      return NextResponse.json({ error: { code: 'ALREADY_LINKED' } }, { status: 409 });
    }
    throw e;
  }

  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'CREATE',
    entityType: 'idea_asset_link',
    entityId: link.id,
    afterValue: {
      sourceType: link.sourceType,
      sourceId: link.sourceId,
      targetType: link.targetType,
      targetId: link.targetId,
    },
  });

  return NextResponse.json({ data: link }, { status: 201 });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const memberOnly = await requireActualProjectMember(user, projectId);
  if (memberOnly) return memberOnly;
  const forbidden = await checkProjectPermission(user, projectId, 'idea:manage');
  if (forbidden) return forbidden;

  const linkId = new URL(req.url).searchParams.get('linkId');
  if (!linkId) {
    return NextResponse.json({ error: { code: 'MISSING_LINK_ID' } }, { status: 400 });
  }

  const deleted = await deleteIdeaAssetLink(linkId, user.id, user.tenantId);
  if (!deleted) {
    return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }

  return new NextResponse(null, { status: 204 });
}
