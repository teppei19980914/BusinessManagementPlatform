/**
 * API Route Handler 用の共通ヘルパー
 * 認証チェック、権限チェック、エラーレスポンス生成を統一する。
 */

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { checkPermission, checkMembership } from '@/lib/permissions';
import { isAdminOrAbove } from '@/lib/permissions/role';
import type { Action, PermissionContext } from '@/lib/permissions';
import type { SystemRole, ProjectRole, ProjectStatus } from '@/types';
// PR-5 (2026-05-15): ストレージ容量 Pre-check (cached) — write API の入口で
//   Beginner 無料枠超過を早期に弾く。
// 2026-05-31: 累積 50GB ハードキャップ撤去 (ADR-0030) に伴い、1 操作あたりペイロード上限
//   (DB_WRITE_PAYLOAD_MAX_BYTES = 5MB) を瞬間負荷ガードとして追加。
import { precheckStorageLimit } from '@/services/storage-guard.service';
import { DB_WRITE_PAYLOAD_MAX_BYTES } from '@/config/db-capacity-pricing';

export type AuthenticatedUser = {
  id: string;
  /**
   * PR #3-b (T-03): ユーザの所属テナント ID。
   *   後続の API → service 呼び出しでテナント認可境界 (requireSameTenant) や
   *   LLM 呼び出し計測 (withMeteredLLM) に渡される。
   *   v1 では default-tenant 単一運用のため全ユーザ同値だが、v1.x マルチテナント
   *   UI 提供時に複数テナントに広がる前提で配置済み。
   */
  tenantId: string;
  name: string;
  email: string;
  systemRole: SystemRole;
};

/**
 * 認証済みユーザを取得する。未認証の場合は 401 レスポンスを返す。
 *
 * 2026-05-13 (security/jwt-invalidation, L-1): JWT 失効検証を追加。
 *   JWT 内 tokenVersion vs DB の最新 user.tokenVersion を比較し、不一致なら 401。
 *   admin がパスワード変更 / ロック解除 / ユーザ削除 / ロール変更で increment した瞬間に、
 *   当該ユーザの既存 JWT は全て即時失効する (= 強制ログアウト)。
 *
 *   性能影響: API route ごとに `prisma.user.findUnique` が 1 回追加 (~5ms / Supabase Pooler 経由)。
 *   全 API route で許容できる範囲。
 *
 *   middleware (Edge runtime) は DB アクセス不可のため検証できず、JWT 内の値のみで動作する
 *   (= middleware で守るプラン期限・Storage Grace 判定は変わらず)。本ガードは API route 入口で
 *   write 系操作を確実に弾く設計。
 */
export async function getAuthenticatedUser(): Promise<AuthenticatedUser | NextResponse> {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }

  // L-1: tokenVersion 検証 (JWT 失効ガード)
  const jwtTokenVersion = session.user.tokenVersion ?? 0;
  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { tokenVersion: true, isActive: true, deletedAt: true },
  });
  if (
    !dbUser
    || dbUser.deletedAt !== null
    || !dbUser.isActive
    || dbUser.tokenVersion !== jwtTokenVersion
  ) {
    // 削除 / 無効化 / tokenVersion 不一致 = 既存 JWT は失効
    return NextResponse.json(
      { error: { code: 'SESSION_INVALIDATED', message: '再度ログインしてください' } },
      { status: 401 },
    );
  }

  return {
    id: session.user.id,
    tenantId: session.user.tenantId,
    name: session.user.name,
    email: session.user.email,
    systemRole: session.user.systemRole as SystemRole,
  };
}

/**
 * プロジェクトスコープの権限チェックを行う。
 * メンバーシップ検証 + ロール x 状態チェック を統合。
 */
export async function checkProjectPermission(
  user: AuthenticatedUser,
  projectId: string,
  action: Action,
  resourceOwnerId?: string,
): Promise<NextResponse | null> {
  // 2026-05-09 feedback: severity-1 テナント越境対策。user.tenantId を渡し、
  //   admin が他テナントの projectId を直叩きしても 404 で弾かれるようにする。
  const membership = await checkMembership(projectId, user.id, user.systemRole, user.tenantId);

  if (!membership.isMember) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }

  const context: PermissionContext = {
    userId: user.id,
    systemRole: user.systemRole,
    projectId,
    projectRole: membership.projectRole as ProjectRole | null,
    projectStatus: membership.projectStatus as ProjectStatus | undefined,
    resourceOwnerId,
  };

  const result = checkPermission(action, context);

  if (!result.allowed) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: result.reason } },
      { status: 403 },
    );
  }

  return null; // 許可
}

/**
 * プロジェクトが「クローズ済み (status='closed' = 完全な読み取り専用)」のとき write を弾く共通ガード。
 *
 * 背景 (2026-06-12):
 *   `checkPermission` の `STATE_RESTRICTIONS.closed` は write アクションをクローズPJで拒否するが、
 *   一部の write route は **ロール判定を service 層に委ねる目的で read アクション**
 *   (`risk:read` / `project:read`) を `checkProjectPermission` に渡しており、
 *   クローズ制約が効かない穴があった:
 *     - `risks/[riskId]` DELETE  … `risk:read` で認可 (creator/admin 判定は service 層)
 *     - `retrospectives/[retroId]` PATCH / DELETE … `project:read` で認可
 *   これらは action を write に変えると member の自己編集/削除を route 層で誤って弾くため、
 *   本ヘルパで **ロール判定を変えずクローズのみを一律ブロック** する。
 *
 * @returns クローズ済みなら 403 (PROJECT_CLOSED)、open / 未存在は null
 *   (存在チェックは呼出側の既存ロジックに委ねるため、ここでは「closed の時だけ」弾く)。
 */
export async function requireProjectNotClosed(
  projectId: string,
  tenantId: string,
): Promise<NextResponse | null> {
  // tenantId 併記で越境クエリを遮断 (他テナントの projectId を直叩きしても status を読めない)
  const project = await prisma.project.findFirst({
    where: { id: projectId, tenantId },
    select: { status: true },
  });
  if (project?.status === 'closed') {
    return NextResponse.json(
      {
        error: {
          code: 'PROJECT_CLOSED',
          message: 'このプロジェクトはクローズ済み (読み取り専用) のため変更できません',
        },
      },
      { status: 403 },
    );
  }
  return null;
}

/**
 * システム管理者チェック (admin または super_admin を許可)。
 *
 * 2026-05-13 (security/auth-secret-hardening, B-3): super_admin が
 * `/api/admin/**` 18 ファイルでアクセス不可だった運用バグを修正。
 * `lib/permissions/role.ts:isAdminOrAbove` を採用し、admin と super_admin を
 * 等しく許可する。テナント越境制御は呼出側の `requireSameTenantUser` が担う
 * (super_admin は MANAGEMENT_TENANT 所属で明示的に bypass される設計)。
 */
export function requireAdmin(user: AuthenticatedUser): NextResponse | null {
  if (!isAdminOrAbove(user)) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'この操作を実行する権限がありません' } },
      { status: 403 },
    );
  }
  return null;
}

/**
 * 2026-05-09 feedback: severity-1 テナント越境対策。
 *
 * `/api/admin/users/[userId]/**` 系ルートで、対象 user の tenantId が呼出者と
 * 一致することを検証する。不一致なら 404 (情報漏洩防止のため FORBIDDEN ではなく NOT_FOUND)。
 *
 * 旧仕様: `requireAdmin` 通過後に直接 userId 操作 (PATCH/DELETE/recovery-codes 再発行/unlock)
 * が可能で、テナント A の admin が テナント B の user を任意に操作できる重大バグだった。
 *
 * super_admin は MANAGEMENT_TENANT 所属で全テナント横断管理が必要なので bypass する。
 */
export async function requireSameTenantUser(
  user: AuthenticatedUser,
  targetUserId: string,
): Promise<NextResponse | null> {
  if (user.systemRole === 'super_admin') return null; // super_admin は越境管理可

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { tenantId: true },
  });

  if (!target || target.tenantId !== user.tenantId) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }
  return null;
}

/**
 * 対象プロジェクトの ProjectMember row が **実際に** 存在することを検証する。
 *
 * `checkProjectPermission` は admin システムロールを「全プロジェクトの pm_tl 相当」として
 * 短絡するが、本ヘルパーはその短絡を行わない。admin でも member row が無ければ 403 を返す。
 *
 * 2026-04-24 追加: 各「○○一覧」(リスク/課題/振り返り/ナレッジ) での作成操作を
 * ProjectMember に限定する要件のために用意。admin が非メンバープロジェクトで
 * 勝手に作成資源を増やすのを防ぐ (admin の責務は参照 + 管理削除のみ)。
 */
export async function requireActualProjectMember(
  user: AuthenticatedUser,
  projectId: string,
): Promise<NextResponse | null> {
  const member = await prisma.projectMember.findFirst({
    where: { projectId, userId: user.id },
    select: { id: true },
  });
  if (!member) {
    return NextResponse.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'このプロジェクトのメンバーのみ作成できます',
        },
      },
      { status: 403 },
    );
  }
  return null;
}

/**
 * write 系 API の入口で **(1) 1 操作ペイロード上限 + (2) Beginner 無料枠** を Pre-check する共通ヘルパ。
 *
 * 役割 (2026-05-31 改定 / ADR-0030「データはたすきばの命」):
 *   1. **1 操作ペイロード上限 (DB_WRITE_PAYLOAD_MAX_BYTES = 5MB)**: 1 リクエストの DB ペイロードが
 *      5MB (UTF-8 byte) を超えたら 413 PAYLOAD_TOO_LARGE。Netlify Functions の硬上限 6MB の手前で
 *      クリーンなエラーを返すための瞬間負荷ガード。
 *   2. **Beginner 無料枠 (50MB)**: Beginner プランで `storageBytesUsed` キャッシュ + 予測サイズが
 *      50MB を超える場合に 403 BEGINNER_DB_QUOTA_EXCEEDED。
 *
 * 設計判断:
 *   - **累積 50GB ハードキャップは撤廃** (ADR-0030)。全プラン共通の write block は無くなり、
 *     Beginner 無料枠ガードのみが残る (Expert/Pro は青天井従量課金)。
 *   - peak 計測 / 課金根拠の更新は日次 cron `updateAllStorageBytesUsed` が担う (本ヘルパは入口の軽量判定のみ)。
 *
 * @param tenantId 対象テナント
 * @param estimatedBytes 追加見込みバイト数。**UTF-8 byte 基準**で渡すこと
 *   (= `Buffer.byteLength(JSON.stringify(body), 'utf8')`)。`String.length` (char 数) だと
 *   日本語で約 3 倍ずれ、5MB ガードが Netlify 6MB より後ろにずれて空振りするため不可。
 *   省略時は 0 (= 既に Beginner 無料枠超過のテナントのみ拒否)。
 * @returns 超過時は NextResponse (413/403)、OK なら null
 */
export async function requireStorageQuotaForWrite(
  tenantId: string,
  estimatedBytes: number = 0,
): Promise<NextResponse | null> {
  // (1) 1 操作ペイロード上限 (Netlify 6MB の手前で clean error)
  if (estimatedBytes > DB_WRITE_PAYLOAD_MAX_BYTES) {
    return NextResponse.json(
      {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `1 回の登録で扱えるデータ量の上限 (${Math.floor(DB_WRITE_PAYLOAD_MAX_BYTES / 1_000_000)}MB) を超えています。内容を分割して保存してください。`,
          limitBytes: DB_WRITE_PAYLOAD_MAX_BYTES,
        },
      },
      { status: 413 },
    );
  }

  // (2) Beginner 無料枠 Pre-check
  const result = await precheckStorageLimit(tenantId, estimatedBytes);
  if (!result.ok) {
    // ADR-0025 (2026-05-29): Beginner プラン超過時は専用 UX 文言 + アップグレード誘導を返す。
    //   (= mapBeginnerWriteGuardErrorToResponse と同じ body 形式。全 write route で UX 文言統一)
    return NextResponse.json(
      {
        error: {
          code: 'BEGINNER_DB_QUOTA_EXCEEDED',
          message:
            'Beginner プランの無料枠 (DB 50MB / Storage 100MB) を超えました。不要なデータを削除する、または Expert プランへアップグレードしてください。',
          quotaType: 'db' as const,
          currentBytes: result.cachedUsedBytes,
          limitBytes: result.limitBytes,
          upgradeUrl: '/settings/tenant',
        },
      },
      { status: 403 },
    );
  }
  return null;
}
