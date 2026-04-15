import { prisma } from '@/lib/db';
import { hash } from 'bcryptjs';
import { randomBytes } from 'crypto';
import type { CreateUserInput } from '@/lib/validators/auth';

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
): Promise<{ user: UserDTO; recoveryCodes: string[] }> {
  // メールアドレス重複チェック
  const existing = await prisma.user.findFirst({
    where: { email: input.email, deletedAt: null },
  });
  if (existing) {
    throw new Error('DUPLICATE_EMAIL');
  }

  const passwordHash = await hash(input.password, BCRYPT_COST);

  // リカバリーコード生成
  const recoveryCodes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    recoveryCodes.push(generateRecoveryCode());
  }

  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email,
      passwordHash,
      systemRole: input.systemRole,
      isActive: true,
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
