import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { suggestRelatedIssuesForText } from '@/services/suggestion.service';

/**
 * POST /api/projects/:projectId/suggestions/related-issues
 *
 * リスク/課題 起票ダイアログから呼ばれる軽量 API (PR #65 Phase 2 (c))。
 * 起票中のテキスト (title + content) に類似する過去の解消済 Issue を最大 5 件返す。
 * debounce してフォーム入力に追従させる想定のため軽量化されている。
 *
 * POST を使う理由: 入力テキストが長くなる可能性があり URL パラメータには不向き。
 */
const bodySchema = z.object({
  text: z.string().min(1).max(3000),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'project:read');
  if (forbidden) return forbidden;

  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const data = await suggestRelatedIssuesForText(parsed.data.text, projectId);
  return NextResponse.json({ data });
}
