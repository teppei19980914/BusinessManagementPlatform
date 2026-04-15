import { prisma } from '@/lib/db';
import { hash } from 'bcryptjs';
import { randomBytes } from 'crypto';
import type { CreateUserInput } from '@/lib/validators/auth';
import {
  sendVerificationEmail,
  EmailSendError,
} from './email-verification.service';

const BCRYPT_COST = 12;
const RECOVERY_CODE_COUNT = 10;

export type UserDTO = {
  id: string;
  name: string;
  email: string;
  systemRole: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

function toUserDTO(user: {
  id: string;
  name: string;
  email: string;
  systemRole: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}): UserDTO {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    systemRole: user.systemRole,
    isActive: user.isActive,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

function generateRecoveryCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join('')
    .replace(/(.{4})(.{4})/, '$1-$2');
}

export async function listUsers(): Promise<UserDTO[]> {
  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  return users.map(toUserDTO);
}

export async function createUser(
  input: CreateUserInput,
  creatorId: string,
  options?: { baseUrl?: string },
): Promise<{ user: UserDTO; recoveryCodes: string[] }> {
  // メールアドレス重複チェック（有効なユーザ）
  const existingActive = await prisma.user.findFirst({
    where: { email: input.email, deletedAt: null },
  });
  if (existingActive) {
    throw new Error('DUPLICATE_EMAIL');
  }

  // 未有効化（deletedAt 付き）の既存ユーザがあれば削除して再登録を許可
  const existingInactive = await prisma.user.findFirst({
    where: { email: input.email, deletedAt: { not: null }, isActive: false },
  });
  if (existingInactive) {
    await prisma.$transaction([
      prisma.emailVerificationToken.deleteMany({
        where: { userId: existingInactive.id },
      }),
      prisma.recoveryCode.deleteMany({
        where: { userId: existingInactive.id },
      }),
      prisma.roleChangeLog.deleteMany({
        where: { targetUserId: existingInactive.id },
      }),
      prisma.user.delete({ where: { id: existingInactive.id } }),
    ]);
  }

  const passwordHash = await hash(input.password, BCRYPT_COST);

  // リカバリーコード生成
  const recoveryCodes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    recoveryCodes.push(generateRecoveryCode());
  }

  const requiresEmailVerification = process.env.MAIL_PROVIDER !== 'console';

  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email,
      passwordHash,
      systemRole: input.systemRole,
      isActive: !requiresEmailVerification,
      deletedAt: requiresEmailVerification ? new Date() : null,
      forcePasswordChange: true,
      recoveryCodes: {
        create: await Promise.all(
          recoveryCodes.map(async (code) => ({
            codeHash: await hash(code, BCRYPT_COST),
          })),
        ),
      },
    },
  });

  // 権限変更ログ
  await prisma.roleChangeLog.create({
    data: {
      changedBy: creatorId,
      targetUserId: user.id,
      changeType: 'system_role',
      beforeRole: null,
      afterRole: input.systemRole,
      reason: 'ユーザ新規登録',
    },
  });

  // メール検証（MAIL_PROVIDER が console 以外の場合）
  if (requiresEmailVerification && options?.baseUrl) {
    try {
      await sendVerificationEmail(user.id, user.email, options.baseUrl);
    } catch (e) {
      // メール送信失敗時はユーザ・関連レコードをロールバック
      await prisma.$transaction([
        prisma.emailVerificationToken.deleteMany({
          where: { userId: user.id },
        }),
        prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
        prisma.roleChangeLog.deleteMany({
          where: { targetUserId: user.id },
        }),
        prisma.user.delete({ where: { id: user.id } }),
      ]);
      if (e instanceof EmailSendError) {
        throw new Error('EMAIL_SEND_FAILED');
      }
      throw e;
    }
  }

  return { user: toUserDTO(user), recoveryCodes };
}

export async function updateUserStatus(
  userId: string,
  isActive: boolean,
  updaterId: string,
): Promise<UserDTO> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { isActive },
  });

  await prisma.roleChangeLog.create({
    data: {
      changedBy: updaterId,
      targetUserId: userId,
      changeType: 'system_role',
      beforeRole: isActive ? 'inactive' : 'active',
      afterRole: isActive ? 'active' : 'inactive',
      reason: isActive ? 'アカウント有効化' : 'アカウント無効化',
    },
  });

  return toUserDTO(user);
}

export async function updateUserRole(
  userId: string,
  newRole: string,
  updaterId: string,
): Promise<UserDTO> {
  // 自分自身のロール変更は不可
  if (userId === updaterId) {
    throw new Error('CANNOT_CHANGE_OWN_ROLE');
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('NOT_FOUND');

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { systemRole: newRole },
  });

  await prisma.roleChangeLog.create({
    data: {
      changedBy: updaterId,
      targetUserId: userId,
      changeType: 'system_role',
      beforeRole: user.systemRole,
      afterRole: newRole,
      reason: 'システムロール変更',
    },
  });

  return toUserDTO(updated);
}
