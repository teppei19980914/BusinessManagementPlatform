import { prisma } from '@/lib/db';
import { hash } from 'bcryptjs';
import { randomBytes } from 'crypto';
import type { CreateUserInput } from '@/lib/validators/auth';
import {
  sendVerificationEmail,
  EmailSendError,
} from './email-verification.service';
import { BCRYPT_COST } from '@/config';

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
): Promise<{ user: UserDTO }> {
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

  // パスワードなしで仮登録（ユーザ自身がパスワード設定画面で設定する）
  const placeholderHash = await hash(randomBytes(32).toString('hex'), BCRYPT_COST);

  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email,
      passwordHash: placeholderHash,
      systemRole: input.systemRole,
      isActive: false,
      deletedAt: new Date(),
      forcePasswordChange: false,
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

  // 招待メール送信（パスワード設定リンク）
  if (options?.baseUrl) {
    try {
      await sendVerificationEmail(user.id, user.email, options.baseUrl);
    } catch (e) {
      // メール送信失敗時はユーザ・関連レコードをロールバック
      await prisma.$transaction([
        prisma.emailVerificationToken.deleteMany({
          where: { userId: user.id },
        }),
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

  return { user: toUserDTO(user) };
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

/**
 * ユーザ管理画面の行クリック編集 (PR #59 Req 3) から呼ばれる汎用更新関数。
 * 既存の updateUserStatus / updateUserRole を内部でディスパッチして
 * 1 リクエストで複数フィールドの変更を処理する。
 * ロール変更時は本来の updateUserRole 経由で role_change_log が残る。
 */
export async function updateUser(
  userId: string,
  input: {
    name?: string;
    systemRole?: string;
    isActive?: boolean;
  },
  updaterId: string,
): Promise<UserDTO> {
  let latest: UserDTO | null = null;

  if (input.systemRole !== undefined) {
    latest = await updateUserRole(userId, input.systemRole, updaterId);
  }
  if (input.isActive !== undefined) {
    latest = await updateUserStatus(userId, input.isActive, updaterId);
  }
  if (input.name !== undefined) {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { name: input.name },
    });
    latest = toUserDTO(user);
  }
  if (!latest) {
    // 何も変更指定がなかった場合は現在値を返す
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    latest = toUserDTO(user);
  }
  return latest;
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
