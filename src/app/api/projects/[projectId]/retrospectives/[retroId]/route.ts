import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireProjectNotClosed,
  requireStorageQuotaForWrite,
} from '@/lib/api-helpers';
import {
  deleteRetrospective,
  getRetrospective,
  updateRetrospective,
} from '@/services/retrospective.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

/**
 * 振り返り更新。
 *
 * 2026-04-24: 認可は **作成者本人のみ**。admin であっても他人の振り返りは編集不可。
 * (管理業務は削除のみに限定する方針)
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; retroId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, retroId } = await params;
  const t = await getTranslations('message');

  const existing = await getRetrospective(retroId, undefined, undefined, user.tenantId);
  // PR feat/asset-multi-project-linking: 紐付け判定は linkedProjectIds 経由
  if (!existing || !existing.linkedProjectIds.includes(projectId)) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }

  // プロジェクトアクセス自体は担保 (メンバーシップ + 越境遮断)。
  // 更新の可否 (作成者本人のみ) は service 層で判定するため、ここは read アクションで通す。
  const forbidden = await checkProjectPermission(user, projectId, 'project:read');
  if (forbidden) return forbidden;

  // 2026-06-12: クローズ済みPJは読み取り専用。project:read 認可ではクローズ制約が効かないため明示ガード。
  const closed = await requireProjectNotClosed(projectId, user.tenantId);
  if (closed) return closed;

  const body = await req.json();

  // PR-5 (2026-05-15): ストレージ容量 Pre-check
  const quotaErr = await requireStorageQuotaForWrite(
    user.tenantId,
    Buffer.byteLength(JSON.stringify(body), 'utf8'),
  );
  if (quotaErr) return quotaErr;

  try {
    await updateRetrospective(retroId, body, user.id, user.tenantId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'FORBIDDEN') {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: t('creatorOnlyEdit') } },
        { status: 403 },
      );
    }
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    // v1.3.0 軽量入力 (2026-06-19): public 化を試みたが 5 セクションのいずれかが空 (input + DB 共に) のケース
    if (msg === 'PUBLIC_REQUIRES_FIELDS') {
      return NextResponse.json(
        {
          error: {
            code: 'PUBLIC_REQUIRES_FIELDS',
            message: '「全メンバー」に公開する場合は計画総括・実績総括・良かった点・課題・改善事項をすべて入力してください',
          },
        },
        { status: 400 },
      );
    }
    // feat/asset-assignee-expansion (2026-05-26) severity-1 越境防御
    if (msg === 'ASSIGNEE_TENANT_MISMATCH') {
      return NextResponse.json(
        {
          error: {
            code: 'ASSIGNEE_TENANT_MISMATCH',
            message: '指定された担当者は同じテナントのメンバーではありません',
          },
        },
        { status: 400 },
      );
    }
    throw e;
  }

  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'UPDATE',
    entityType: 'retrospective',
    entityId: retroId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
    afterValue: sanitizeForAudit(body as Record<string, unknown>),
  });

  return NextResponse.json({ data: { success: true } });
}

/**
 * 振り返り削除エンドポイント。
 *
 * 2026-04-24: 認可は **作成者本人 OR admin**。admin は「全振り返り」からの管理削除を想定。
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; retroId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, retroId } = await params;
  const t = await getTranslations('message');

  const existing = await getRetrospective(retroId, undefined, undefined, user.tenantId);
  // PR feat/asset-multi-project-linking: 紐付け判定は linkedProjectIds 経由
  if (!existing || !existing.linkedProjectIds.includes(projectId)) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }

  const forbidden = await checkProjectPermission(user, projectId, 'project:read');
  if (forbidden) return forbidden;

  // 2026-06-12: クローズ済みPJは読み取り専用 (個別資産の削除も不可。プロジェクト自体の削除のみ別経路で許可)。
  const closed = await requireProjectNotClosed(projectId, user.tenantId);
  if (closed) return closed;

  try {
    // feat/crud-permission-redesign (2026-05-20): project 経路は作成者本人のみ削除可。
    //   admin も「振り返り一覧」上では削除不可 (横断「全振り返り」経路で削除する)。
    await deleteRetrospective(retroId, user.id, user.systemRole, user.tenantId, 'project');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'FORBIDDEN') {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: t('creatorOrAdminOnlyDelete') } },
        { status: 403 },
      );
    }
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    throw e;
  }
  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'DELETE',
    entityType: 'retrospective',
    entityId: retroId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
  });
  return NextResponse.json({ data: { success: true } });
}
