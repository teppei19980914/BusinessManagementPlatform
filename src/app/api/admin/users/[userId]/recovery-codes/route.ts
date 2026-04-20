import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { hash } from 'bcryptjs';
import { randomBytes } from 'crypto';
import { recordAuditLog } from '@/services/audit.service';
import { recordAuthEvent } from '@/services/auth-event.service';
import { BCRYPT_COST, RECOVERY_CODE_CHARSET } from '@/config';

function generateRecoveryCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes)
    .map((b) => RECOVERY_CODE_CHARSET[b % RECOVERY_CODE_CHARSET.length])
    .join('')
    .replace(/(.{4})(.{4})/, '$1-$2');
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const { userId } = await params;

  // 旧コードを全て無効化
  await prisma.recoveryCode.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });

  // 新コード10個を生成
  const recoveryCodes: string[] = [];
  for (let i = 0; i < 10; i++) {
    recoveryCodes.push(generateRecoveryCode());
  }

  await Promise.all(
    recoveryCodes.map(async (code) => {
      const codeHash = await hash(code, BCRYPT_COST);
      return prisma.recoveryCode.create({
        data: { userId, codeHash },
      });
    }),
  );

  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'recovery_codes',
    entityId: userId,
    afterValue: { action: 'reissue', count: 10 },
  });

  await recordAuthEvent({
    eventType: 'password_change',
    userId,
    detail: { action: 'recovery_code_reissued', reissuedBy: user.id },
  });

  return NextResponse.json({ data: { recoveryCodes } });
}
