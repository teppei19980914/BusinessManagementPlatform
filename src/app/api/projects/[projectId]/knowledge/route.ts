import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { createKnowledgeSchema } from '@/lib/validators/knowledge';
import { listKnowledgeByProject, createKnowledge } from '@/services/knowledge.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

/**
 * プロジェクトに紐づくナレッジ一覧。
 *
 * 設計 (2026-04-18):
 *   プロジェクト詳細「ナレッジ一覧」タブと横断「全ナレッジ」ビューは同一テーブル
 *   (knowledge) を参照するため、どちらから CRUD しても相互に反映される (連動)。
 *   差分は「表示スコープ」だけ: 一覧は projectId 紐付け有のもののみ、全は全件。
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'knowledge:read');
  if (forbidden) return forbidden;

  const knowledges = await listKnowledgeByProject(projectId);
  return NextResponse.json({ data: knowledges });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'knowledge:create');
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = createKnowledgeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  // プロジェクト紐付けを自動付与: ユーザ入力の projectIds に現在の projectId を
  // マージ (重複排除)。これにより「ナレッジ一覧」タブから作成したナレッジが
  // 必ずそのプロジェクトに紐づき、プロジェクト scoped な一覧で表示される。
  const projectIds = Array.from(
    new Set([...(parsed.data.projectIds ?? []), projectId]),
  );
  const knowledge = await createKnowledge(
    { ...parsed.data, projectIds },
    user.id,
  );

  await recordAuditLog({
    userId: user.id,
    action: 'CREATE',
    entityType: 'knowledge',
    entityId: knowledge.id,
    afterValue: sanitizeForAudit(knowledge as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: knowledge }, { status: 201 });
}
