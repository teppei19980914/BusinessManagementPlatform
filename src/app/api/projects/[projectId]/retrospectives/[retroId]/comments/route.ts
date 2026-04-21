/**
 * POST /api/projects/[projectId]/retrospectives/[retroId]/comments - 振り返りコメント追加
 *
 * 役割:
 *   振り返り記事に対して関係者がコメントを追加する。コメントは時系列で
 *   振り返りエントリ配下に表示され、議論の足跡を残す。
 *
 * 認可: checkProjectPermission('retrospective:comment')
 *
 * 関連: DESIGN.md §5 (テーブル定義: retrospective_comments)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
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

  const body = await req.json();
  const parsed = addCommentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } }, { status: 400 });
  }

  await addComment(retroId, parsed.data.content, user.id);
  return NextResponse.json({ data: { success: true } }, { status: 201 });
}
