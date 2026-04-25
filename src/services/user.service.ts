/**
 * ユーザサービス (システム管理者向け)
 *
 * 役割:
 *   システム管理者画面 (/admin/users) からのユーザ CRUD を担う。
 *   - ユーザ新規発行 (検証メール送信込み)
 *   - 一覧 (アクティブ/非アクティブ含む)
 *   - 編集 (氏名 / システムロール / 有効化)
 *   - リカバリーコード再発行
 *
 * 設計判断:
 *   - 新規発行時: パスワードはユーザ自身が後から /setup-password で設定する。
 *     ここではランダムトークン (email_verification_tokens) を発行し、
 *     検証メール (sendVerificationEmail) で送付する。即座にパスワードを発行しない理由は
 *     管理者がパスワードを知らない状態を保つため (内部不正防止)。
 *   - メール送信失敗 (EmailSendError) はユーザレコードを残してエラーを投げる。
 *     呼び出し元 API ルートで EMAIL_SEND_FAILED として 502 応答に変換する。
 *   - 重複メール検出: Prisma の P2002 (UNIQUE 制約違反) を捕捉し
 *     'DUPLICATE_EMAIL' Error を投げる (API 側で 409 に変換)。
 *   - 論理削除 (deletedAt) を採用。監査ログ整合性のため物理削除しない。
 *
 * 認可:
 *   呼び出し元 API ルート (/api/admin/users/...) で requireAdmin() を実施済みの前提。
 *
 * 関連ドキュメント:
 *   - DESIGN.md §5 (テーブル定義: users)
 *   - DESIGN.md §9 (セキュリティ設計 / アカウントロック / メール検証)
 *   - SPECIFICATION.md (ユーザ管理画面 / 新規発行フロー)
 */

import { prisma } from '@/lib/db';
import { hash } from 'bcryptjs';
import { randomBytes } from 'crypto';
import type { CreateUserInput } from '@/lib/validators/auth';
import {
  sendVerificationEmail,
  EmailSendError,
} from './email-verification.service';
import { BCRYPT_COST, INACTIVE_USER_LOCK_DAYS } from '@/config';
import { recordAuditLog, sanitizeForAudit } from './audit.service';

export type UserDTO = {
  id: string;
  name: string;
  email: string;
  systemRole: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  // PR #85: ログイン失敗ロック状態 (admin 画面表示用)
  // ロック機能は src/lib/auth.ts + src/config/security.ts で既に常時稼働しているが、
  // 情報を UserDTO に露出していなかったため admin 画面で確認できなかった。
  failedLoginCount: number;
  lockedUntil: string | null;
  permanentLock: boolean;
  // PR #116: MFA verify 専用のロック状態 (パスワードロックとは別系統)
  mfaFailedCount: number;
  mfaLockedUntil: string | null;
};

function toUserDTO(user: {
  id: string;
  name: string;
  email: string;
  systemRole: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  failedLoginCount: number;
  lockedUntil: Date | null;
  permanentLock: boolean;
  mfaFailedCount: number;
  mfaLockedUntil: Date | null;
}): UserDTO {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    systemRole: user.systemRole,
    isActive: user.isActive,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    failedLoginCount: user.failedLoginCount,
    lockedUntil: user.lockedUntil?.toISOString() ?? null,
    permanentLock: user.permanentLock,
    mfaFailedCount: user.mfaFailedCount,
    mfaLockedUntil: user.mfaLockedUntil?.toISOString() ?? null,
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

/**
 * ユーザ削除 (PR #89) — 論理削除 + ProjectMember カスケード物理削除。
 *
 * 設計判断:
 *   - User 本体は論理削除 (deletedAt セット)
 *     理由: Task.assigneeId / RiskIssue.reporterId / Knowledge.createdBy 等
 *     多数の scalar カラムで user.id を参照しているため、物理削除すると
 *     監査ログや過去タスクの「誰がやった」情報が参照先エラーになる。
 *     論理削除なら row は残り、UI 表示時は「削除済みユーザ」等でハンドリングできる。
 *   - ProjectMember は**物理削除**
 *     理由: ProjectMember は「現在の所属」を表すテーブル。削除済みユーザが
 *     メンバー一覧に残ると「幽霊メンバー」になり、一括更新や権限判定でノイズ。
 *   - **Memo は物理削除 (2026-04-24 追加)**
 *     理由: メモは完全に個人資産で、作成者が退職したら残す意味がない。
 *     RiskIssue / Retrospective / Knowledge が「組織の資産」として残すのと対照的に、
 *     Memo はプロジェクト紐付けも持たない私的メモなので、ユーザ削除と同時に
 *     カスケード物理削除する。
 *   - Session / recoveryCode / emailVerificationToken / passwordResetToken も物理削除
 *     理由: 再ログイン機会を完全に遮断するため。
 *   - 自分自身の削除は禁止 (最後の admin が自分を消すと詰むケースもあるが、
 *     単純化のため 「自分禁止」 に統一)
 *
 * @throws {Error} 'CANNOT_DELETE_SELF' — 自分自身を削除しようとした
 * @throws {Error} 'NOT_FOUND'          — 対象ユーザが存在しない or 既に削除済み
 */
export async function deleteUser(
  userId: string,
  deleterId: string,
): Promise<{ deletedUserId: string; removedMemberships: number }> {
  if (userId === deleterId) {
    throw new Error('CANNOT_DELETE_SELF');
  }

  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
  });
  if (!user) throw new Error('NOT_FOUND');

  // ProjectMember / Session / RecoveryCode 等を物理削除 + User 本体に deletedAt セット
  const [removedMembers] = await prisma.$transaction([
    prisma.projectMember.deleteMany({ where: { userId } }),
    prisma.session.deleteMany({ where: { userId } }),
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.emailVerificationToken.deleteMany({ where: { userId } }),
    prisma.passwordResetToken.deleteMany({ where: { userId } }),
    prisma.passwordHistory.deleteMany({ where: { userId } }),
    // 2026-04-24: Memo は個人資産なのでユーザ削除と同時にカスケード物理削除
    prisma.memo.deleteMany({ where: { userId } }),
    prisma.user.update({
      where: { id: userId },
      data: {
        deletedAt: new Date(),
        isActive: false,
        // セキュリティ上の念押し: 削除後の再利用/誤ログインを防ぐため MFA も外す
        mfaEnabled: false,
        mfaSecretEncrypted: null,
      },
    }),
    prisma.roleChangeLog.create({
      data: {
        changedBy: deleterId,
        targetUserId: userId,
        changeType: 'system_role',
        beforeRole: user.systemRole,
        afterRole: 'deleted',
        reason: 'ユーザ削除',
      },
    }),
  ]);

  return {
    deletedUserId: userId,
    removedMemberships: removedMembers.count,
  };
}

/**
 * 非アクティブユーザの自動ロック (PR #89 で導入、feat/account-lock で論理削除 → ロック化に方針変更)。
 * 日次 cron で実行され、長期不在アカウントの **ログインだけを封じる** (アカウント自体は残す)。
 *
 * 条件:
 *   - isActive = true (現在有効化済) であり
 *   - deletedAt = null (まだ手動削除されていない) であり
 *   - lastLoginAt < 閾値日 (未ログインの場合 createdAt < 閾値日)
 *   - systemRole = 'admin' 以外 (admin は自動ロック対象外、業務継続性のため)
 *
 * 設計意図 (折衷):
 *   - ナレッジ参照: 過去のナレッジ/課題/振り返り等の **作成者表示** はアカウントが
 *     残っていないと「(削除済)」になる。長期不在ユーザでもアカウント情報は保持する
 *   - セキュリティ: 漏洩パスワード / 放置セッションの攻撃面を縮小するため、
 *     ログインは封じる (isActive=false)
 *   - 復帰: 必要時はシステム管理者が `/admin/users` で isActive をトグルして解除
 *
 * 呼び出し側:
 *   - `/api/admin/users/lock-inactive` POST (vercel.json の cron で日次起動)
 *   - 管理画面からの手動実行 (admin ボタン)
 *
 * 監査ログ:
 *   - action='UPDATE' / entityType='user' / entityId=<対象 user.id>
 *   - reason="30 日無アクティブ自動ロック" を含む
 *   - 物理削除を伴わないため ProjectMember は維持される (孤児データは元から発生しない)
 */
export async function lockInactiveUsers(
  systemTriggerId: string,
): Promise<{ lockedUserIds: string[] }> {
  const thresholdDate = new Date(
    Date.now() - INACTIVE_USER_LOCK_DAYS * 24 * 60 * 60 * 1000,
  );

  // 候補抽出: 長期間ログインなし (or 一度もログインしていないかつ作成から閾値経過)
  const candidates = await prisma.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      systemRole: { not: 'admin' },
      OR: [
        { lastLoginAt: { lt: thresholdDate } },
        { AND: [{ lastLoginAt: null }, { createdAt: { lt: thresholdDate } }] },
      ],
    },
    select: { id: true, name: true, email: true },
  });

  const lockedUserIds: string[] = [];

  for (const c of candidates) {
    try {
      // isActive=false に更新 (論理削除はしない)。
      // User モデルは updatedBy 列を持たない設計 (self-referential 回避)。
      // ロック実行者の追跡は audit_log の userId=systemTriggerId で行う。
      await prisma.user.update({
        where: { id: c.id },
        data: { isActive: false },
      });
      // 監査ログ: 削除 (DELETE) ではなく更新 (UPDATE) として記録
      await recordAuditLog({
        userId: systemTriggerId,
        action: 'UPDATE',
        entityType: 'user',
        entityId: c.id,
        beforeValue: sanitizeForAudit({ isActive: true }),
        afterValue: sanitizeForAudit({ isActive: false, reason: '30 日無アクティブ自動ロック' }),
      });
      lockedUserIds.push(c.id);
    } catch {
      // 個別失敗は握りつぶし、他のユーザロックを継続 (cron の信頼性優先)
    }
  }

  return { lockedUserIds };
}
