/**
 * GET /api/admin/audit-logs - 監査ログ一覧取得
 *
 * 役割:
 *   システム管理者向け監査ログ閲覧画面のデータソース。entityType による絞込と
 *   ページネーション (limit 最大 100) をサポート。
 *
 * 認可: requireAdmin (システム管理者のみ)
 *
 * 関連:
 *   - DESIGN.md §5 (テーブル定義: audit_logs)
 *   - SPECIFICATION.md (監査ログ画面)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const { searchParams } = req.nextUrl;
  const entityType = searchParams.get('entityType') || undefined;
  const page = Number(searchParams.get('page')) || 1;
  const limit = Math.min(Number(searchParams.get('limit')) || 50, 100);

  // 2026-05-10 Phase 2-10: AuditLog 直接 tenantId 列で絞込み (旧 User join 経由フィルタから移行)。
  //   User 物理削除後の宙ぶらりんログにも追従可能になり、より高速。
  const where: Record<string, unknown> = { tenantId: user.tenantId };
  if (entityType) where.entityType = entityType;

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ]);

  const data = logs.map((l) => ({
    id: l.id,
    userName: l.user.name,
    userEmail: l.user.email,
    action: l.action,
    entityType: l.entityType,
    entityId: l.entityId,
    createdAt: l.createdAt.toISOString(),
  }));

  return NextResponse.json({ data, meta: { total, page, limit } });
}
