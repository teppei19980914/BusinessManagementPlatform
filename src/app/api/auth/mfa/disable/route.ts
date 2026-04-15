import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { disableMfa } from '@/services/mfa.service';

export async function POST() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  // 管理者は MFA を無効化できない
  if (user.systemRole === 'admin') {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: '管理者は MFA を無効化できません' } },
      { status: 403 },
    );
  }

  await disableMfa(user.id);
  return NextResponse.json({ data: { success: true } });
}
