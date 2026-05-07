/**
 * ロール判定ヘルパー (PR-X1 / 2026-05-07)
 *
 * 役割:
 *   3 階層ロール体系に基づく判定を 1 箇所に集約する。
 *   既存の `=== 'admin'` 直接比較を選択的に本ヘルパに置換していく
 *   (全テナント横断用途のチェックは `isSuperAdmin()` に置換)。
 *
 * ロール体系 (詳細: docs/roadmap/ROLE_REFACTORING_PLAN.md §2.1, §2.2):
 *   - super_admin : プラットフォーム運営者専用 (管理テナント所属)。全テナント横断アクセス
 *   - admin       : テナント管理者。自テナント内の全権限
 *   - general     : 一般ユーザ。プロジェクト/役割に応じた権限
 *
 * 設計判断:
 *   - `User` 全体ではなく `{ systemRole }` のみ受け取る (テストしやすさ + 依存最小化)
 *   - 純粋関数 (副作用なし、boolean を返す)
 *   - `requireSuperAdmin` のみ throw 系 (Express/Next.js handler でガードに使う)
 */

import type { SystemRole } from '@/types';

/** ヘルパが受け取る最小限の user 形状 (Prisma の User 型のサブセット) */
export type RoleContext = {
  systemRole: SystemRole | string;
};

/**
 * super_admin (システム管理者 / プラットフォーム運営者) かを判定する。
 *
 * 用途:
 *   - 全テナント横断の監視・管理機能 (例: /admin/super/* 配下) の認可ガード
 *   - super_admin 専用のダッシュボード表示判定
 *
 * @example
 *   if (!isSuperAdmin(user)) return new NextResponse('Forbidden', { status: 403 });
 */
export function isSuperAdmin(user: RoleContext): boolean {
  return user.systemRole === 'super_admin';
}

/**
 * テナント管理者 (admin) のみかを判定する (super_admin は含まない)。
 *
 * 用途:
 *   - 「テナント管理者専用 (運営者は対象外)」の機能で使う (例: 自テナント設定画面)
 *   - 「自テナント内の admin 権限」を厳密に判定したい場合
 *
 * @example
 *   const canChangePlan = isTenantAdmin(user);  // テナント設定画面でのプラン変更権限
 */
export function isTenantAdmin(user: RoleContext): boolean {
  return user.systemRole === 'admin';
}

/**
 * admin 以上 (admin or super_admin) かを判定する。
 *
 * 用途:
 *   - 「テナント管理者または運営者なら OK」の幅広い管理機能 (例: 既存 /admin/* 配下の多く)
 *   - 既存の `systemRole === 'admin'` チェックを置換するときの最も近い意味
 *     (admin は「テナント管理者」の意味を維持しつつ、運営者にもアクセスを許す)
 *
 * @example
 *   if (!isAdminOrAbove(user)) return forbidden();
 */
export function isAdminOrAbove(user: RoleContext): boolean {
  return user.systemRole === 'admin' || user.systemRole === 'super_admin';
}

/**
 * super_admin でなければエラーを throw する (NextResponse でハンドルする呼出側を想定)。
 *
 * Next.js の API Route handler では NextResponse を返す方が一般的なので、
 * 呼出側で `if (!isSuperAdmin(user)) return NextResponse.json(..., {status:403})` の
 * パターンを推奨。本関数は service 層から呼ばれる際の防御線として用意。
 *
 * @throws Error 'FORBIDDEN: super_admin role required'
 */
export function requireSuperAdmin(user: RoleContext): void {
  if (!isSuperAdmin(user)) {
    throw new Error('FORBIDDEN: super_admin role required');
  }
}
