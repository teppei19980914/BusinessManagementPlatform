/**
 * POST /api/projects/[projectId]/retrospectives/[retroId]/comments - 振り返りコメント追加
 *
 * 役割:
 *   振り返り記事に対して関係者がコメントを追加する。コメントは時系列で
 *   振り返りエントリ配下に表示され、議論の足跡を残す。
 *
 * 認可 (2026-04-24 修正 L-3):
 *   - プロジェクトのメンバーシップ必須 (viewer も含む基本読み取り権は checkProjectPermission で担保)
 *   - **投稿自体は実際の ProjectMember の pm_tl / member のみ** (viewer は書き込み不可)。
 *     項目 10 (PR-α) で UI は非表示化済 (将来 cross-list 横ぐし実装で再利用予定)。
 *     UI を経由しない直接 POST も含めて API 側で境界を enforce する。
 *
 * 関連: DESIGN.md §5 (テーブル定義: retrospective_comments) / §8.3 (権限マトリクス)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireActualProjectMember,
} from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { addCommentSchema } from '@/lib/validators/retrospective';
import { addComment } from '@/services/retrospective.service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; retroId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const { projectId, retroId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:read');
  if (forbidden) return forbidden;

  // PR #114 (L-3): viewer ロールは書き込み不可。admin 短絡なしの実メンバーで projectRole 判定。
  const memberOnly = await requireActualProjectMember(user, projectId);
  if (memberOnly) return memberOnly;
  const member = await prisma.projectMember.findFirst({
    where: { projectId, userId: user.id },
    select: { projectRole: true },
  });
  if (!member || member.projectRole === 'viewer') {
    const t = await getTranslations('message');
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: t('noCommentPermission') } },
      { status: 403 },
    );
  }

  const body = await req.json();
  const parsed = addCommentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } }, { status: 400 });
  }

  await addComment(retroId, parsed.data.content, user.id);
  return NextResponse.json({ data: { success: true } }, { status: 201 });
}
