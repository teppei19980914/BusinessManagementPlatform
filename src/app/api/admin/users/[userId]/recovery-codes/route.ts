/**
 * POST /api/admin/users/[userId]/recovery-codes - リカバリーコード再発行
 *
 * 役割:
 *   ユーザがリカバリーコードを紛失した際、システム管理者が新しいコード一式を
 *   生成して旧コードを全失効する。生成されたコードは応答で 1 回だけ平文返却し、
 *   DB には bcrypt ハッシュのみ保存する。
 *
 * 認可: requireAdmin (システム管理者のみ)
 * 監査:
 *   - audit_logs (action=UPDATE, entityType=user)
 *   - auth_event_logs (eventType=recovery_codes_regenerated)
 *
 * 注意:
 *   応答ボディに含まれる recoveryCodes は二度と再表示されないため、
 *   呼び出し元 UI で必ずユーザに表示・控えてもらう必要がある。
 *
 * 関連:
 *   - DESIGN.md §9.7 (リカバリーコード方式)
 *   - src/config/security.ts (RECOVERY_CODE_COUNT / RECOVERY_CODE_CHARSET)
 */

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
