import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { unlockAccount } from '@/services/password.service';
import { recordAuditLog } from '@/services/audit.service';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const { userId } = await params;

  await unlockAccount(userId, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'user',
    entityId: userId,
    afterValue: { action: 'unlock', failedLoginCount: 0, permanentLock: false },
  });

  return NextResponse.json({ data: { success: true } });
}
