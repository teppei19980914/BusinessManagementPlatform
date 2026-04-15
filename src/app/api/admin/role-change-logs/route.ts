import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const { searchParams } = req.nextUrl;
  const page = Number(searchParams.get('page')) || 1;
  const limit = Math.min(Number(searchParams.get('limit')) || 50, 100);

  const [logs, total] = await Promise.all([
    prisma.roleChangeLog.findMany({
      include: {
        changer: { select: { name: true } },
        targetUser: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.roleChangeLog.count(),
  ]);

  const data = logs.map((l) => ({
    id: l.id,
    changerName: l.changer.name,
    targetUserName: l.targetUser.name,
    targetUserEmail: l.targetUser.email,
    changeType: l.changeType,
    beforeRole: l.beforeRole,
    afterRole: l.afterRole,
    reason: l.reason,
    createdAt: l.createdAt.toISOString(),
  }));

  return NextResponse.json({ data, meta: { total, page, limit } });
}
