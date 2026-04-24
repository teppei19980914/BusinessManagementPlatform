/**
 * GET  /api/knowledge - 全ナレッジ横断一覧 (visibility=public + 自分の draft)
 * POST /api/knowledge - ナレッジ新規作成
 *
 * 役割:
 *   プロジェクト横断のナレッジ画面 (/knowledge) のデータソース。
 *   検索キーワード / knowledgeType / techTags / processTags でフィルタ可能。
 *
 * 認可:
 *   ログイン済みユーザなら閲覧可。listKnowledge サービス内で
 *   visibility='public' の全件 + 自分が作成した draft のみ返す。
 *
 * 監査: POST 時に audit_logs (action=CREATE, entityType=knowledge) を記録。
 *
 * 関連:
 *   - DESIGN.md §5 (テーブル定義: knowledges)
 *   - DESIGN.md §16 (全文検索 / pg_trgm)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { createKnowledgeSchema } from '@/lib/validators/knowledge';
import { listKnowledge, createKnowledge } from '@/services/knowledge.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { searchParams } = req.nextUrl;
  const result = await listKnowledge(
    {
      keyword: searchParams.get('keyword') || undefined,
      knowledgeType: searchParams.get('knowledgeType') || undefined,
      visibility: searchParams.get('visibility') || undefined,
      page: Number(searchParams.get('page')) || 1,
      limit: Number(searchParams.get('limit')) || 20,
    },
    user.id,
    user.systemRole,
  );

  return NextResponse.json({
    data: result.data,
    meta: {
      total: result.total,
      page: Number(searchParams.get('page')) || 1,
      limit: Number(searchParams.get('limit')) || 20,
    },
  });
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  // 2026-04-24 セキュリティ監査 (M-2): 本エンドポイントは「全社横断ナレッジ」作成経路だが、
  // projectIds で紐付くプロジェクトが指定された場合、そのプロジェクトに非メンバーが
  // 勝手にナレッジを注入できる経路になっていた。プロジェクト紐付きならば全 projectIds に
  // ついて実際の ProjectMember であることを要求する (PR #113 で確立した
  // 「作成は ProjectMember のみ」方針の横展開)。

  const body = await req.json();
  const parsed = createKnowledgeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const projectIds = parsed.data.projectIds ?? [];
  if (projectIds.length > 0) {
    const memberships = await prisma.projectMember.findMany({
      where: { userId: user.id, projectId: { in: projectIds } },
      select: { projectId: true },
    });
    const memberSet = new Set(memberships.map((m) => m.projectId));
    const nonMemberIds = projectIds.filter((pid) => !memberSet.has(pid));
    if (nonMemberIds.length > 0) {
      return NextResponse.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: 'メンバーでないプロジェクトにナレッジを紐付けることはできません',
          },
        },
        { status: 403 },
      );
    }
  }

  const knowledge = await createKnowledge(parsed.data, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'CREATE',
    entityType: 'knowledge',
    entityId: knowledge.id,
    afterValue: sanitizeForAudit(knowledge as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: knowledge }, { status: 201 });
}
