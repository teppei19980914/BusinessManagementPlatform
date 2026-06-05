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
import type { Prisma } from '@/generated/prisma/client';
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
  // T-21 (2026-04-28): 一時ロック累積カウンタ。PERMANENT_LOCK_THRESHOLD 到達で permanentLock=true。
  temporaryLockCount: number;
  // PR #116: MFA verify 専用のロック状態 (パスワードロックとは別系統)
  mfaFailedCount: number;
  mfaLockedUntil: string | null;
  // 2026-06-03: 前回ログイン日時 (admin 一覧/編集で表示)。null = 一度もログインしていない。
  lastLoginAt: string | null;
  // 2026-06-03: MFA (二段階認証) が有効か (admin 編集画面で表示)。
  mfaEnabled: boolean;
  // 2026-06-03: 招待受諾日時。null = 招待中 (パスワード未設定)。値あり = 受諾済。
  invitationAcceptedAt: string | null;
  // 2026-06-03: アカウント状態 (招待中 / 有効 / 無効)。invitationAcceptedAt と isActive から導出。
  //   ロック (failedLoginCount / permanentLock / mfaLockedUntil) はこれとは別軸で、有効なまま一時ロックも起こる。
  accountStatus: AccountStatus;
  // 2026-06-03: 作成者/更新者 (admin 一覧の監査列)。createdBy/updatedBy は操作者 UUID、
  //   *Name は listUsers が自テナント User をバルク解決した氏名 (単体 DTO 経路では null)。
  createdBy: string | null;
  updatedBy: string | null;
  createdByName: string | null;
  updatedByName: string | null;
};

/** 2026-06-03: アカウント状態。ロック (別軸) とは独立。 */
export type AccountStatus = 'invited' | 'active' | 'inactive';

/**
 * 2026-06-03: アカウント状態を「招待受諾済みか」と「有効フラグ」から導出する単一ソース。
 *   - invitationAcceptedAt == null            -> 'invited' (招待中: パスワード未設定)
 *   - invitationAcceptedAt != null && isActive -> 'active'  (有効: ログイン可能)
 *   - invitationAcceptedAt != null && !isActive -> 'inactive' (無効: 管理者が席を停止)
 * 論理削除 (deletedAt) されたユーザは一覧クエリ側で除外されるため本関数の対象外。
 * ロック状態 (連続失敗の自動保護) はこの 3 状態とは別軸で、有効なユーザにも掛かる。
 */
export function deriveAccountStatus(user: {
  isActive: boolean;
  invitationAcceptedAt: Date | null;
}): AccountStatus {
  if (user.invitationAcceptedAt == null) return 'invited';
  return user.isActive ? 'active' : 'inactive';
}

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
  temporaryLockCount: number;
  mfaFailedCount: number;
  mfaLockedUntil: Date | null;
  lastLoginAt: Date | null;
  mfaEnabled: boolean;
  invitationAcceptedAt: Date | null;
  createdBy: string | null;
  updatedBy: string | null;
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
    temporaryLockCount: user.temporaryLockCount,
    mfaFailedCount: user.mfaFailedCount,
    mfaLockedUntil: user.mfaLockedUntil?.toISOString() ?? null,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    mfaEnabled: user.mfaEnabled,
    invitationAcceptedAt: user.invitationAcceptedAt?.toISOString() ?? null,
    accountStatus: deriveAccountStatus(user),
    createdBy: user.createdBy,
    updatedBy: user.updatedBy,
    // 氏名は listUsers がバルク解決して上書きする (単体 DTO 経路では null)。
    createdByName: null,
    updatedByName: null,
  };
}

/**
 * 2026-05-09 feedback: severity-1 テナント越境対策。viewer の所属テナント内のユーザのみ返却。
 *   旧仕様: 全テナントの全ユーザ (氏名 / メール / MFA 状態 / ロック状態) が他テナント admin に漏洩していた。
 *   PII 漏洩 + 他テナント user のアカウント乗っ取り経路 (recovery-codes 再発行等) の起点になっていた重大バグ。
 */
export async function listUsers(viewerTenantId: string): Promise<UserDTO[]> {
  const users = await prisma.user.findMany({
    where: { deletedAt: null, tenantId: viewerTenantId },
    orderBy: { createdAt: 'desc' },
  });
  // 2026-06-03: 作成者/更新者の氏名を自テナント内でバルク解決 (N+1 回避、customer.service と同方式)。
  //   tenantId フィルタで越境した operator (例: super_admin) は null フォールバックし氏名漏えいしない。
  const operatorIds = Array.from(
    new Set(users.flatMap((u) => [u.createdBy, u.updatedBy]).filter((v): v is string => v != null)),
  );
  const operators = operatorIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: operatorIds }, tenantId: viewerTenantId },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(operators.map((o) => [o.id, o.name]));
  return users.map((u) => ({
    ...toUserDTO(u),
    createdByName: u.createdBy ? nameById.get(u.createdBy) ?? null : null,
    updatedByName: u.updatedBy ? nameById.get(u.updatedBy) ?? null : null,
  }));
}

/**
 * P-2 (2026-05-08): Beginner プラン席数上限のガード。
 *
 * Beginner プラン契約テナントが `beginnerMaxSeats` (DB 値、既定 5) を超えて
 * ユーザ招待しようとした場合に SEAT_LIMIT_EXCEEDED を投げる。
 *
 * 2026-06-03 (案A): 席数は「有効 (isActive:true) + 招待中 (invitationAcceptedAt:null)」を
 *   予約として数える。招待を出した時点で 1 席確保し、受諾時に席が無い破綻を防ぐ。
 *   無効 (受諾済かつ isActive:false) は席を解放するためカウント対象外。論理削除も対象外。
 *   ※ 課金スナップショット用の activeUserCount (isActive:true のみ) とは別概念
 *      (tenant-self.service.ts: activeUserCount は据え置き / seatUsageCount を別途追加)。
 *
 * Beginner 以外 (Expert / Pro) は無制限のため何もしない。
 *
 * @throws Error('SEAT_LIMIT_EXCEEDED') — Beginner で席数超過の場合
 */
export async function assertSeatAvailableForTenant(tenantId: string): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true, beginnerMaxSeats: true },
  });
  if (!tenant) return; // テナント不在は他経路で 404 になる前提
  if (tenant.plan !== 'beginner') return; // Beginner 以外は無制限

  // 案A: 有効 + 招待中 を席使用としてカウント (deletedAt:null 前提)
  const seatUsageCount = await prisma.user.count({
    where: {
      tenantId,
      deletedAt: null,
      OR: [{ isActive: true }, { invitationAcceptedAt: null }],
    },
  });

  if (seatUsageCount + 1 > tenant.beginnerMaxSeats) {
    throw new Error('SEAT_LIMIT_EXCEEDED');
  }
}

export async function createUser(
  input: CreateUserInput,
  creatorId: string,
  options: { baseUrl?: string; tenantId: string },
): Promise<{ user: UserDTO }> {
  // ★severity-1 (fix/tenant-id-default-removal, 2026-05-28): tenantId 必須化。
  //   旧 signature では `options?.tenantId` を optional として許容し、未指定時は
  //   schema の DB DEFAULT (= Default テナント) に silent 混入していた (ADR-0024)。
  //   現在は options.tenantId 必須 + schema の DB DEFAULT 撤去で「未指定 = DB エラー」化済。
  //
  // P-2 (2026-05-08): Beginner プラン席数上限の API 層 enforce。
  //   背景: PR-X4 では tenant-self ダウングレード時のみ席数チェックを実装し、
  //         招待時 (= ユーザ作成時) の上限チェックが未実装。Beginner で 6 人目の招待が
  //         拒否されない構造的欠陥を補完する。
  //   仕様: 当該テナントが Beginner プランの場合、
  //         有効 + 招待中 + 1 <= beginnerMaxSeats でない限り SEAT_LIMIT_EXCEEDED を投げる (案A)。
  //   2026-06-03: 席数チェックは下の「招待中の重複掃除」の後に移動した
  //     (再招待で旧・招待中レコードを消した後の正しい席数で判定するため)。

  // 2026-05-09 feedback Phase 2-6: 越境ユーザ作成を遮断するため、メール重複チェックは
  //   tenant 内で実施 (テナント間で同じメールアドレスは別ユーザとして許容する設計)。
  const tenantScope = { tenantId: options.tenantId };
  // メールアドレス重複チェック（受諾済み = 有効/無効のユーザ）。
  //   2026-06-03: 「受諾済み」= deletedAt:null かつ invitationAcceptedAt 設定済み。
  //   無効 (isActive:false の受諾済み) も既存アカウントなので重複として弾く。
  const existingAccepted = await prisma.user.findFirst({
    where: {
      email: input.email,
      deletedAt: null,
      invitationAcceptedAt: { not: null },
      ...tenantScope,
    },
  });
  if (existingAccepted) {
    throw new Error('DUPLICATE_EMAIL');
  }

  // 招待中（未受諾）の既存ユーザがあれば掃除して再招待を許可。
  //   2026-06-03: 招待中 = invitationAcceptedAt:null。新設計では deletedAt:null だが、
  //   移行前の旧レコード (deletedAt 付きの保留招待) も同条件で掃除対象に含める。
  // Phase 2-10: tenantId フィルタで二重防御 (existingInvited.tenantId を明示的に使用)
  const existingInvited = await prisma.user.findFirst({
    where: { email: input.email, invitationAcceptedAt: null, isActive: false, ...tenantScope },
  });
  if (existingInvited) {
    await prisma.$transaction([
      prisma.emailVerificationToken.deleteMany({
        where: { userId: existingInvited.id, tenantId: existingInvited.tenantId },
      }),
      prisma.recoveryCode.deleteMany({
        where: { userId: existingInvited.id, tenantId: existingInvited.tenantId },
      }),
      prisma.roleChangeLog.deleteMany({
        where: { targetUserId: existingInvited.id, tenantId: existingInvited.tenantId },
      }),
      prisma.user.delete({ where: { id: existingInvited.id } }),
    ]);
  }

  // P-2 / 案A: 重複掃除の後に席数上限を判定する。
  await assertSeatAvailableForTenant(options.tenantId);

  // パスワードなしで仮登録（ユーザ自身がパスワード設定画面で設定する）
  const placeholderHash = await hash(randomBytes(32).toString('hex'), BCRYPT_COST);

  // ★severity-1 (fix/tenant-id-default-removal, 2026-05-28): tenantId を data に必須化。
  //   schema の DB DEFAULT 撤去 (ADR-0024) に伴い、未指定だと NOT NULL 違反で loud fail。
  const user = await prisma.user.create({
    data: {
      tenantId: options.tenantId,
      name: input.name,
      email: input.email,
      passwordHash: placeholderHash,
      systemRole: input.systemRole,
      isActive: false,
      // 2026-06-03: 招待中は invitationAcceptedAt:null で表す。旧設計は deletedAt を立てて
      //   一覧から隠していたが、本設計では deletedAt は論理削除専用に戻し、招待中も一覧に出す
      //   (招待メール再送・招待取消の導線を置けるようにするため)。
      invitationAcceptedAt: null,
      deletedAt: null,
      forcePasswordChange: false,
      // 2026-06-03: 招待した管理者を作成者/更新者として記録 (admin 一覧の監査列)
      createdBy: creatorId,
      updatedBy: creatorId,
    },
  });

  // 権限変更ログ (Phase 2-10: tenantId 必須化)
  await prisma.roleChangeLog.create({
    data: {
      tenantId: user.tenantId,
      changedBy: creatorId,
      targetUserId: user.id,
      changeType: 'system_role',
      beforeRole: null,
      afterRole: input.systemRole,
      reason: 'ユーザ新規登録',
    },
  });

  // 招待メール送信（パスワード設定リンク）
  // Phase 2-10: sendVerificationEmail に tenantId 必須化
  if (options?.baseUrl) {
    try {
      await sendVerificationEmail(user.id, user.tenantId, user.email, options.baseUrl);
    } catch (e) {
      // メール送信失敗時はユーザ・関連レコードをロールバック
      // Phase 2-10: tenantId フィルタで二重防御
      await prisma.$transaction([
        prisma.emailVerificationToken.deleteMany({
          where: { userId: user.id, tenantId: user.tenantId },
        }),
        prisma.roleChangeLog.deleteMany({
          where: { targetUserId: user.id, tenantId: user.tenantId },
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

/**
 * 2026-06-03: テナント管理者による招待メールの再送。
 *   対象は招待中 (invitationAcceptedAt:null) のユーザのみ。受諾済みには再送しない。
 *   既存 sendVerificationEmail を再利用 (旧 token を無効化し新 token を発行する)。
 *   呼び出し元 (route) で requireAdmin + requireSameTenantUser 済みの前提。
 * @throws Error('USER_NOT_FOUND') 招待中ユーザが見つからない (= 既に受諾済み / 不在)
 * @throws Error('EMAIL_SEND_FAILED') メール送信失敗
 */
export async function resendInvitationByAdmin(
  userId: string,
  adminId: string,
  tenantId: string,
  baseUrl: string,
): Promise<void> {
  const target = await prisma.user.findFirst({
    where: { id: userId, tenantId, invitationAcceptedAt: null, deletedAt: null },
    select: { id: true, email: true },
  });
  if (!target) {
    throw new Error('USER_NOT_FOUND');
  }
  try {
    await sendVerificationEmail(target.id, tenantId, target.email, baseUrl);
  } catch (e) {
    if (e instanceof EmailSendError) {
      throw new Error('EMAIL_SEND_FAILED');
    }
    throw e;
  }
  await recordAuditLog({
    tenantId,
    userId: adminId,
    action: 'UPDATE',
    entityType: 'user',
    entityId: userId,
    afterValue: { operation: 'resend_invitation' },
  });
}

/**
 * 2026-06-03: テナント管理者による招待の取消 (案A の席解放手段)。
 *   対象は招待中 (invitationAcceptedAt:null) のユーザのみ。受諾済みユーザは対象外
 *   (退職等で席を止める場合は updateUserStatus(無効) / deleteUser を使う)。
 *   未受諾の招待は業務履歴を持たないため、付随レコードごと物理削除する (席が即時解放される)。
 *   呼び出し元 (route) で requireAdmin + requireSameTenantUser 済みの前提。
 * @throws Error('USER_NOT_FOUND') 招待中ユーザが見つからない (= 既に受諾済み / 不在)
 */
export async function cancelInvitation(
  userId: string,
  adminId: string,
  tenantId: string,
): Promise<void> {
  const target = await prisma.user.findFirst({
    where: { id: userId, tenantId, invitationAcceptedAt: null, deletedAt: null },
    select: { id: true, email: true },
  });
  if (!target) {
    throw new Error('USER_NOT_FOUND');
  }
  // Phase 2-10: tenantId フィルタで二重防御。未受諾のため監査本体の履歴は無い。
  await prisma.$transaction([
    prisma.emailVerificationToken.deleteMany({ where: { userId, tenantId } }),
    prisma.recoveryCode.deleteMany({ where: { userId, tenantId } }),
    prisma.roleChangeLog.deleteMany({ where: { targetUserId: userId, tenantId } }),
    prisma.user.delete({ where: { id: userId } }),
  ]);
  await recordAuditLog({
    tenantId,
    userId: adminId,
    action: 'DELETE',
    entityType: 'user',
    entityId: userId,
    afterValue: { operation: 'cancel_invitation', email: target.email },
  });
}

export async function updateUserStatus(
  userId: string,
  isActive: boolean,
  updaterId: string,
  viewerTenantId: string,
): Promise<UserDTO> {
  // 2026-05-09 feedback Phase 2-6: 越境ユーザステータス変更を遮断するため findFirst で先に所有確認。
  //   旧仕様は他テナント user の isActive を勝手に切り替え可能だった (アカウント DoS 経路)。
  const owned = await prisma.user.findFirst({
    where: { id: userId, tenantId: viewerTenantId },
    select: { id: true },
  });
  if (!owned) throw new Error('NOT_FOUND');

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      isActive,
      // 2026-06-03: 最後に編集した管理者を更新者として記録 (admin 一覧の監査列)
      updatedBy: updaterId,
      // 2026-05-13 (security/jwt-invalidation, L-1): isActive 切替で既存 JWT を失効。
      //   無効化されたユーザは即時ログアウト、再有効化後も再ログイン強制。
      tokenVersion: { increment: 1 },
    },
  });

  // Phase 2-10: tenantId 必須化
  await prisma.roleChangeLog.create({
    data: {
      tenantId: viewerTenantId,
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
  viewerTenantId: string,
): Promise<UserDTO> {
  // 2026-05-09 feedback Phase 2-6: 冒頭で対象 user の tenant 一致を verify。
  //   ただし内部 dispatch する updateUserRole / updateUserStatus は各々で tenant 検証するため、
  //   ここでは name 単独更新分のみ検証する。
  const owned = await prisma.user.findFirst({
    where: { id: userId, tenantId: viewerTenantId },
    select: { id: true },
  });
  if (!owned) throw new Error('NOT_FOUND');

  let latest: UserDTO | null = null;

  if (input.systemRole !== undefined) {
    latest = await updateUserRole(userId, input.systemRole, updaterId, viewerTenantId);
  }
  if (input.isActive !== undefined) {
    latest = await updateUserStatus(userId, input.isActive, updaterId, viewerTenantId);
  }
  if (input.name !== undefined) {
    const user = await prisma.user.update({
      where: { id: userId },
      // 2026-06-03: 氏名更新も更新者を記録
      data: { name: input.name, updatedBy: updaterId },
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
  viewerTenantId: string,
): Promise<UserDTO> {
  // 自分自身のロール変更は不可
  if (userId === updaterId) {
    throw new Error('CANNOT_CHANGE_OWN_ROLE');
  }

  // 2026-05-09 feedback Phase 2-6: 越境ロール変更を遮断するため tenantId 必須化。
  //   旧仕様は他テナント user を super_admin に昇格可能で権限昇格攻撃の起点だった。
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId: viewerTenantId },
  });
  if (!user) throw new Error('NOT_FOUND');

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      systemRole: newRole,
      // 2026-06-03: 最後に編集した管理者を更新者として記録 (admin 一覧の監査列)
      updatedBy: updaterId,
      // 2026-05-13 (security/jwt-invalidation, L-1): ロール変更で既存 JWT を失効。
      //   権限降格直後に旧 JWT で admin 操作されるリスクを排除。
      tokenVersion: { increment: 1 },
    },
  });

  // Phase 2-10: tenantId 必須化
  await prisma.roleChangeLog.create({
    data: {
      tenantId: viewerTenantId,
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
  viewerTenantId: string,
): Promise<{ deletedUserId: string; removedMemberships: number }> {
  if (userId === deleterId) {
    throw new Error('CANNOT_DELETE_SELF');
  }

  // 2026-05-09 feedback Phase 2-6: 越境削除を遮断するため tenantId 必須化。
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId: viewerTenantId, deletedAt: null },
  });
  if (!user) throw new Error('NOT_FOUND');

  // feat/crud-permission-redesign (2026-05-20): 監査要件 (severity-2 修正)。
  //   削除前に ProjectMember 行を取得して role_change_logs に解除記録を残す。
  //   PM/TL ガード (FORBIDDEN_PMTL_ROLE) は admin による削除であり既に admin で許可済なのでスキップ。
  const memberships = await prisma.projectMember.findMany({
    where: { userId },
    select: { id: true, projectId: true, projectRole: true },
  });

  // ProjectMember / Session / RecoveryCode 等を物理削除 + User 本体に deletedAt セット
  // Phase 2-10: 各 deleteMany に tenantId フィルタを併記して二重防御
  const [removedMembers] = await prisma.$transaction([
    prisma.projectMember.deleteMany({ where: { userId } }),
    prisma.session.deleteMany({ where: { userId } }),
    prisma.recoveryCode.deleteMany({ where: { userId, tenantId: viewerTenantId } }),
    prisma.emailVerificationToken.deleteMany({ where: { userId, tenantId: viewerTenantId } }),
    prisma.passwordResetToken.deleteMany({ where: { userId, tenantId: viewerTenantId } }),
    prisma.passwordHistory.deleteMany({ where: { userId, tenantId: viewerTenantId } }),
    // 2026-04-24: Memo は個人資産なのでユーザ削除と同時にカスケード物理削除
    prisma.memo.deleteMany({ where: { userId, tenantId: viewerTenantId } }),
    prisma.user.update({
      where: { id: userId },
      data: {
        deletedAt: new Date(),
        isActive: false,
        // セキュリティ上の念押し: 削除後の再利用/誤ログインを防ぐため MFA も外す
        mfaEnabled: false,
        mfaSecretEncrypted: null,
        // 2026-05-13 (security/jwt-invalidation, L-1): 削除と同時に既存 JWT を失効。
        //   論理削除後も 9 時間有効な JWT で API を叩かれる経路を完全に閉じる。
        //   getAuthenticatedUser の deletedAt チェックでも止まるが、二重防御で念押し。
        tokenVersion: { increment: 1 },
      },
    }),
    prisma.roleChangeLog.create({
      data: {
        tenantId: viewerTenantId,
        changedBy: deleterId,
        targetUserId: userId,
        changeType: 'system_role',
        beforeRole: user.systemRole,
        afterRole: 'deleted',
        reason: 'ユーザ削除',
      },
    }),
    // feat/crud-permission-redesign (2026-05-20): 各 ProjectMember 行の解除を role_change_logs に個別記録。
    //   旧実装は project_role 解除履歴が抜けていた (system_role 削除のみ記録)。
    ...(memberships.length > 0
      ? [
          prisma.roleChangeLog.createMany({
            data: memberships.map((m) => ({
              tenantId: viewerTenantId,
              changedBy: deleterId,
              targetUserId: userId,
              changeType: 'project_role',
              projectId: m.projectId,
              beforeRole: m.projectRole,
              afterRole: 'removed',
              reason: 'ユーザ削除によるメンバー解除',
            })),
          }),
        ]
      : []),
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
 *   - `/api/admin/users/lock-inactive` POST (外部 cron (cron-job.org) で日次起動)
 *   - 管理画面からの手動実行 (admin ボタン)
 *
 * 監査ログ:
 *   - action='UPDATE' / entityType='user' / entityId=<対象 user.id>
 *   - reason="30 日無アクティブ自動ロック" を含む
 *   - 物理削除を伴わないため ProjectMember は維持される (孤児データは元から発生しない)
 */
export async function lockInactiveUsers(
  systemTriggerId: string,
  /**
   * 2026-05-12 severity-1 修正: テナントスコープ引数を追加。
   *
   *   - 指定あり (= manual パス、tenant admin から起動): 自テナント内のユーザのみロック
   *   - 指定なし (= cron パス): 全テナント横断 (外部 cron での日次実行)
   *
   * 旧仕様は引数なしで常に全テナント横断していたため、tenant A の admin が manual
   * エンドポイントを叩くと **tenant B のユーザを一斉ロックできる** severity-1 越境バグ
   * があった。`/api/admin/users/lock-inactive/route.ts` の manual 経路は本引数に
   * `user.tenantId` を渡すこと。cron 経路は意図的に省略 (全テナント横断が仕様)。
   */
  tenantScope?: string,
): Promise<{ lockedUserIds: string[] }> {
  const thresholdDate = new Date(
    Date.now() - INACTIVE_USER_LOCK_DAYS * 24 * 60 * 60 * 1000,
  );

  // 候補抽出: 長期間ログインなし (or 一度もログインしていないかつ作成から閾値経過)
  // Phase 2-10: tenantId を select に追加 (audit log の所属 tenant に使う)
  // 2026-05-12: tenantScope が指定されたら自テナント内のみに絞る (manual 経路の越境遮断)
  const candidates = await prisma.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      systemRole: { not: 'admin' },
      ...(tenantScope !== undefined ? { tenantId: tenantScope } : {}),
      OR: [
        { lastLoginAt: { lt: thresholdDate } },
        { AND: [{ lastLoginAt: null }, { createdAt: { lt: thresholdDate } }] },
      ],
    },
    select: { id: true, name: true, email: true, tenantId: true },
  });

  const lockedUserIds: string[] = [];

  for (const c of candidates) {
    try {
      // feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S2-D5): per-user の user.update +
      //   recordAuditLog を transaction 化。旧実装は逐次 await で、DB 切断時に「update 済だが
      //   audit_log 未記録」状態が残り得た (cron try/catch で握りつぶしのため検知不能)。
      //   transaction で両者を atomic に。
      // isActive=false に更新 (論理削除はしない)。
      // User モデルは updatedBy 列を持たない設計 (self-referential 回避)。
      // ロック実行者の追跡は audit_log の userId=systemTriggerId で行う。
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: c.id },
          data: { isActive: false },
        });
        // 監査ログ: 削除 (DELETE) ではなく更新 (UPDATE) として記録。
        // Phase 2-10: tenantId は **lock 対象 user の所属 tenant** を使う (cron 横断処理のため)。
        // 注: recordAuditLog 内部は prisma.auditLog.create を使うため tx ではなく独立 connection だが、
        //   $transaction の commit 失敗で audit log だけ残るケースは Prisma の interactive
        //   transaction の挙動上発生しない (handler 中の例外で rollback)。
        await tx.auditLog.create({
          data: {
            tenantId: c.tenantId,
            userId: systemTriggerId,
            action: 'UPDATE',
            entityType: 'user',
            entityId: c.id,
            // Prisma JSON column への型キャスト (recordAuditLog ヘルパと同じパターン)
            beforeValue: sanitizeForAudit({ isActive: true }) as Prisma.InputJsonValue,
            afterValue: sanitizeForAudit({ isActive: false, reason: '30 日無アクティブ自動ロック' }) as Prisma.InputJsonValue,
          },
        });
      });
      lockedUserIds.push(c.id);
    } catch {
      // 個別失敗は握りつぶし、他のユーザロックを継続 (cron の信頼性優先)。
      // transaction 化で「update 済 + audit_log 未記録」の inconsistent state は構造的に発生しない。
    }
  }

  return { lockedUserIds };
}
