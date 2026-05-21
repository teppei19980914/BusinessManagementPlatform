/**
 * ユーザ個別自己情報サービス (2026-05-21 / feat/settings-tenant-identity)
 *
 * 役割:
 *   ログイン中ユーザが自分の個別設定画面 (/settings) で参照する情報を取得する。
 *   一般ユーザでも自身の所属テナントの識別子 (slug / 表示名) を確認できるようにし、
 *   次回ログイン時に「組織 ID が分からずログインできない」状態を防ぐ。
 *
 * 設計判断:
 *   - テナント識別子は slug + 表示名のみ返す。tenantSeq / UUID は管理者向けのみで
 *     一般ユーザの認知負荷を上げないため非露出 (= /settings/tenant 側で管理者にのみ提示)。
 *   - email / name / systemRole / lastLoginAt はユーザが自分のアカウント状態を把握する
 *     ための最低限。MFA 有効化日時は信頼境界 (パスワード変更時の本人特定) で有用。
 *   - 戻り値は presentation 用 DTO (Date は Date のまま、ISO string 化は呼出側 / client component に委ねる)。
 *
 * 関連:
 *   - ADR-0017 (2026-05-21): テナント識別子のユーザ可視化方針
 *   - login flow: src/app/(auth)/login/page.tsx の tenantSlug 入力
 *   - localStorage 履歴: src/lib/tenant-history.ts (PR #420)
 */

import { prisma } from '@/lib/db';

export type UserSelfAccountInfo = {
  /** User.id (= UUID)。一般ユーザに露出してもセキュリティ影響なし (DOM debug 用には便利)。 */
  id: string;
  /** User.name (氏名)。 */
  name: string;
  /** User.email (= ログイン入力に使用するメールアドレス)。 */
  email: string;
  /** User.systemRole ('super_admin' / 'admin' / 'general')。 */
  systemRole: string;
  /** User.mfaEnabled (= MFA が有効か)。super_admin は強制有効化のため常に true 想定。 */
  mfaEnabled: boolean;
  /** MFA を有効化した日時 (mfaEnabled=false なら null)。 */
  mfaEnabledAt: Date | null;
  /** 直近ログイン成功時刻 (初回ログイン中は null)。 */
  lastLoginAt: Date | null;
  /** アカウント作成日時 (テナント参加日)。 */
  createdAt: Date;
  /** 所属テナントの最小情報。slug はログイン入力に必須、name は所属認識のため。 */
  tenant: {
    /** Tenant.slug (= 組織 ID)。ログイン画面の「組織 ID」入力欄に対応。 */
    slug: string;
    /** Tenant.name (表示名)。 */
    name: string;
  };
};

/**
 * 自分のアカウント情報を取得する。/settings (ユーザ個別設定) のサーバコンポーネントから使用。
 *
 * 認可: 呼出側で session.user.id を渡す前提。本関数は userId を信頼する。
 * 越境防止: userId 単一引数なので tenant 越境リスクなし (= 自分の id でしか取得しない)。
 *
 * @returns ユーザまたは所属テナントが論理削除済の場合は null。
 */
export async function getUserSelfAccountInfo(
  userId: string,
): Promise<UserSelfAccountInfo | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      id: true,
      name: true,
      email: true,
      systemRole: true,
      mfaEnabled: true,
      mfaEnabledAt: true,
      lastLoginAt: true,
      createdAt: true,
      tenant: {
        select: {
          slug: true,
          name: true,
          deletedAt: true,
        },
      },
    },
  });

  if (!user) return null;
  // テナント解約済 (deletedAt セット) の場合は自己情報を出さない
  //   (= 解約済テナントのユーザがログイン経路を残しているケース防衛)
  if (user.tenant.deletedAt) return null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    systemRole: user.systemRole,
    mfaEnabled: user.mfaEnabled,
    mfaEnabledAt: user.mfaEnabledAt,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    tenant: {
      slug: user.tenant.slug,
      name: user.tenant.name,
    },
  };
}
