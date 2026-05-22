/**
 * テナント新規作成サービス (P-G / 2026-05-08)
 *
 * 役割:
 *   新規顧客テナントを作成する単一エントリーポイント。super_admin による手動作成と
 *   /signup 公開セルフサインアップの 2 経路で共通化された core ロジックを提供する。
 *
 * 経路別ラッパ:
 *   - createTenantBySuperAdmin(): super_admin が手動でテナントを払い出す
 *   - createTenantBySignup(): 公開 /signup から外部ユーザがセルフサインアップ
 *
 * フロー:
 *   1. 入力検証 (slug 形式 / メール形式 / 必須項目)
 *   2. slug / email の重複チェック
 *   3. transaction:
 *      a. Tenant 作成 (請求先情報込み)
 *      b. 初期 admin User 作成 (passwordHash はランダム placeholder = 検証メールで設定)
 *      c. roleChangeLog 記録
 *   4. 検証メール送信 (sendVerificationEmail)
 *      - 失敗時はテナント + ユーザを transaction 外でロールバック (= compensating delete)
 *
 * 設計判断:
 *   - **createUser をコピーして専用化**: 既存 createUser は ProjectMember 等の bound context で
 *     使われるため、tenant 作成と組み合わせる新コンテキストは別関数化したほうが分離が明確
 *   - **slug 衝突は P2002 ではなく事前チェック**: 並列リクエスト下では race するが、API 層の
 *     rate limit (signup 経路) + super_admin 単一実行 (admin 経路) で実用上は十分
 *   - **paymentMethod は文字列**: enum 化は将来 (現状 'invoice' = 銀行振込（請求書送付） /
 *     'credit_card' = 自動引落 の 2 値想定だが UI 側のバリデーションで担保。
 *     旧 'bank_transfer' は 'invoice' に統合済 2026-05-15)
 *   - **tenantSeq は DB SEQUENCE で自動採番** (= PR-X1 で導入済) なので Tenant 作成時に
 *     明示指定しない
 *
 * 関連:
 *   - 計画: docs/roadmap/V1_FINAL_TASKS.md P-G
 *   - 既存: src/services/user.service.ts (createUser; tenantId 既知前提)
 *   - 招待メール: src/services/email-verification.service.ts (sendVerificationEmail)
 */

import { prisma } from '@/lib/db';
import { hash } from 'bcryptjs';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { sendVerificationEmail, EmailSendError } from './email-verification.service';
import { BCRYPT_COST } from '@/config';
import {
  CURRENT_TERMS_VERSION,
  CURRENT_PRIVACY_VERSION,
  CONSENT_TYPES,
} from '@/config/legal-versions';
import type { TenantPlan } from '@/lib/tenant';

// ================================================================
// 公開型
// ================================================================

/** 共通の入力バリデーション (super_admin / signup 共通) */
export const TenantOnboardingInputSchema = z
  .object({
    /** 表示用テナント名 (画面ヘッダ等。請求書の正式社名は billingCompanyName を使う) */
    name: z.string().trim().min(1).max(100),
    /** URL ルーティング用 slug (英数 + ハイフン、3-60 文字) */
    slug: z.string().trim().regex(/^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$/, {
      message: 'slug は英小文字・数字・ハイフンのみ、3〜60 文字で入力してください',
    }),
    /** プラン (デフォルト beginner) */
    plan: z.enum(['beginner', 'expert', 'pro']).default('beginner'),

    // 2026-05-09 (PR C / #5): 請求先種別。corporate = 法人 / individual = 個人。
    //   - corporate: billingCompanyName 必須 (= 法人名)
    //   - individual: billingCompanyName は省略可 (UI 側でフィールド非表示、入力されても OK)
    billingType: z.enum(['corporate', 'individual']).default('corporate'),
    /**
     * 請求先会社名 / 法人名。billingType='corporate' のときは required (refine で強制)、
     * 'individual' のときは optional (空でも OK)。
     */
    billingCompanyName: z.string().trim().max(200).optional(),
    billingContactName: z.string().trim().min(1).max(100),
    billingContactEmail: z.string().trim().email().max(255),

    // 2026-05-09 (PR C / #8): 住所サブフィールド化。新規入力は構造化した個別フィールドで受ける。
    //   - 旧 billingAddress (単一 Text) は legacy として schema 上残置 (既存データ保護)。
    //   - 構造化フィールドはすべて required (#10 で billingBuildingName のみ optional)。
    billingPostalCode: z.string().trim().regex(/^\d{3}-?\d{4}$/, {
      message: '郵便番号は 7 桁 (例 100-0001) で入力してください',
    }),
    billingPrefecture: z.string().trim().min(1).max(20),
    billingCity: z.string().trim().min(1).max(100),
    billingStreetAddress: z.string().trim().min(1).max(200),
    billingBuildingName: z.string().trim().max(200).optional(),

    /** 任意 */
    billingPhoneNumber: z.string().trim().max(20).optional(),
    // 2026-05-09 (#4): クレジットカードは未対応のため API でも reject (UI も disabled)。
    // 2026-05-15: 'bank_transfer' を廃止し 'invoice' に統合 (UI ラベル「銀行振込」, 内部値 'invoice')。
    paymentMethod: z.enum(['invoice']).default('invoice'),

    /** 初期 admin ユーザ (検証メール送付先 = ログイン用) */
    initialAdminName: z.string().trim().min(1).max(100),
    initialAdminEmail: z.string().trim().email().max(255),

    // feat/legal-pages-lp-integration (2026-05-21):
    //   規約・プラポリへの同意取得 (民法 548 条の 2 / 定型約款の組入合意)。
    //   UI 側で 2 つの checkbox を required 強制し、true のみが許容される。
    //   server 側で false は VALIDATION_ERROR で reject、サインアップ完了を阻止する。
    /** 利用規約への同意 (= true 必須) */
    acceptedTerms: z.literal(true, {
      message: '利用規約への同意が必要です',
    }),
    /** プライバシーポリシーへの同意 (= true 必須) */
    acceptedPrivacy: z.literal(true, {
      message: 'プライバシーポリシーへの同意が必要です',
    }),
  })
  // 2026-05-09 (PR C / #5): 法人プランのみ会社名必須。
  //   個人プランで誤入力された会社名は許容 (UI 非表示なので通常は空) し、
  //   サーバ側で sanitize する (UI へ渡す表示は法人 ↔ 個人切替で動的)。
  .refine(
    (d) => d.billingType !== 'corporate' || (d.billingCompanyName != null && d.billingCompanyName.length > 0),
    {
      path: ['billingCompanyName'],
      message: '法人プランでは会社名 / 法人名は必須です',
    },
  );

export type TenantOnboardingInput = z.infer<typeof TenantOnboardingInputSchema>;

export type TenantOnboardingSuccess = {
  ok: true;
  tenantId: string;
  initialAdminUserId: string;
};

export type TenantOnboardingFailure = {
  ok: false;
  reason:
    | 'VALIDATION_ERROR'
    | 'SLUG_CONFLICT'
    // ADR-0016 (2026-05-20): 'EMAIL_CONFLICT' を削除。
    //   email は tenant-scoped 一意化されたため、新規テナント作成時の email 重複は
    //   そもそも発生しない (= 同一個人が複数テナントに所属可能になる、本 ADR の主目的)。
    | 'EMAIL_SEND_FAILED'
    // ADR-0016 Revised (2026-05-22): 3 層判定
    //   - 層 1: 自前テナント保有あり → 公開フォーム完全不可 (システム管理者問合せ必須)
    //   - 層 2: 他テナント (Default 含む) の users に email あり → Beginner 不可 (Expert/Pro 可)
    //   - 層 3: 履歴一切なし → 全プラン可
    | 'OWNED_TENANT_EXISTS'
    | 'BEGINNER_REQUIRES_UPGRADE';
  message: string;
};

export type TenantOnboardingResult = TenantOnboardingSuccess | TenantOnboardingFailure;

// ================================================================
// 公開関数
// ================================================================

/**
 * super_admin が手動でテナントを払い出す経路。
 *
 * - 入力は **未検証の unknown** を受け取り、内部で zod バリデーション
 *   (= 認証済 admin からの入力でも形式不正を検出)
 * - 検証メール送信失敗時は **テナント + ユーザを compensating delete でロールバック**
 *   (= 中途半端なテナントが残らない)
 */
export async function createTenantBySuperAdmin(
  input: unknown,
  baseUrl: string,
  consentMeta?: ConsentMeta,
): Promise<TenantOnboardingResult> {
  // ADR-0016 Revised (2026-05-22): super_admin 経路は層 1/層 2 判定を全スキップ (= SA-2)。
  //   「自前テナント保有ユーザの追加払い出しはシステム管理者問合せ」の問合せ受け窓口がこの経路。
  //   1 ユーザに対して複数の自前テナント発行を admin 判断で実施可。
  return createTenantInternal(input, baseUrl, consentMeta, { skipEligibilityCheck: true });
}

/**
 * 公開 /signup からのセルフサインアップ経路。
 *
 * - 内部実装は super_admin 経路と同一 (= バリデーション + Tenant + 初期 admin)
 * - 上位 API ルート側で rate limit / honeypot などのスパム対策を実施する前提
 *   (本サービス層では検証しない = テストしやすさ + 関心の分離)
 * - feat/legal-pages-lp-integration (2026-05-21): consentMeta で同意取得時の
 *   IP / User-Agent を渡し、TenantConsentLog に証跡として保存する
 */
export async function createTenantBySignup(
  input: unknown,
  baseUrl: string,
  consentMeta?: ConsentMeta,
): Promise<TenantOnboardingResult> {
  return createTenantInternal(input, baseUrl, consentMeta);
}

/** 同意取得時のメタ情報 (証跡用、API 層が req から抽出して渡す) */
export type ConsentMeta = {
  ipAddress?: string;
  userAgent?: string;
};

/** ADR-0016 Revised (2026-05-22): 内部オプション */
type CreateTenantInternalOptions = {
  /**
   * true で 3 層 eligibility 判定 (層 1 OWNED_TENANT_EXISTS / 層 2 BEGINNER_REQUIRES_UPGRADE)
   * を完全スキップ。super_admin 手動払い出し経路 (SA-2) でのみ true に設定する。
   */
  skipEligibilityCheck?: boolean;
};

// ================================================================
// 内部
// ================================================================

async function createTenantInternal(
  rawInput: unknown,
  baseUrl: string,
  consentMeta?: ConsentMeta,
  options: CreateTenantInternalOptions = {},
): Promise<TenantOnboardingResult> {
  // ---------- 1. zod バリデーション ----------
  const parsed = TenantOnboardingInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'VALIDATION_ERROR',
      message: parsed.error.issues[0]?.message ?? '入力内容に誤りがあります',
    };
  }
  const input = parsed.data;

  // ---------- 2. slug / email 重複チェック ----------
  const existingSlug = await prisma.tenant.findUnique({
    where: { slug: input.slug },
    select: { id: true },
  });
  if (existingSlug != null) {
    return {
      ok: false,
      reason: 'SLUG_CONFLICT',
      message: 'この組織 ID は既に使用されています',
    };
  }

  // ADR-0016 (2026-05-20): User.email は tenant-scoped 一意 (= @@unique([tenantId, email])) に変更。
  //   新規テナント作成時は、その新テナントの中で email は新規 (= 当然) なので、
  //   グローバル / 他テナントでの email 重複検査は不要。
  //   (= 同一個人が複数テナントに所属可能になる、本 ADR の主目的を満たす)
  //
  //   旧コードは email グローバル UNIQUE 前提の検査だったが、Schema 変更後は不要のため削除。
  //   万一同一テナント内で重複した場合、DB UNIQUE 制約 (tenantId, email) で違反 →
  //   Prisma が P2002 を throw → 呼出側 (createTenantBySuperAdmin/Signup) で catch → 4xx 化。
  //   ただし新規テナント作成では物理的に同一テナント内重複は発生しないため発火条件なし。

  // ADR-0016 Revised (2026-05-22): 3 層 eligibility 判定。
  //   判定キーは **initialAdminEmail のみ** (= テナントを払い出す user 本人の email)。
  //   billingContactEmail は付随情報扱いで対象外 (= 共有 billing email の false positive を抑止)。
  //
  //   - 層 1: 自前テナント保有 (= 過去に initialAdminUser として払い出した tenant が存在)
  //           → OWNED_TENANT_EXISTS (= 公開フォーム完全不可、admin 問合せ必須)
  //   - 層 2: 他テナント (Default / 招待先 含む) の users に email あり
  //           → plan='beginner' なら BEGINNER_REQUIRES_UPGRADE (= Expert/Pro へ誘導)
  //   - 層 3: 履歴一切なし → 全プラン可
  //
  //   旧 P-B (2026-05-08) の plan='beginner' 強制上書きおよび ADR-0016 (2026-05-20) の 4 条件 OR
  //   判定は本 Revised で収束。tenant.deletedAt は問わず (= 論理削除 / 物理削除関係なく
  //   tenants.created_by_user_id に紐付く限り「自前テナント保有」とみなす)。
  //
  //   super_admin 経路 (createTenantBySuperAdmin) は skipEligibilityCheck=true で本ブロックを完全
  //   スキップする (SA-2: 「問合せ → 例外発行」窓口、admin 判断で多テナント発行を許容)。
  if (!options.skipEligibilityCheck) {
    // 層 1 判定: initialAdminEmail で users を引き、その user.id が tenants.created_by_user_id に
    //   紐付いていれば「自前テナント保有」。OWNED_TENANT_EXISTS で公開フォーム完全不可。
    const usersWithSameEmail = await prisma.user.findMany({
      where: { email: input.initialAdminEmail },
      select: { id: true },
    });

    if (usersWithSameEmail.length > 0) {
      const userIds = usersWithSameEmail.map((u) => u.id);
      const ownedTenant = await prisma.tenant.findFirst({
        where: { createdByUserId: { in: userIds } },
        select: { id: true },
      });
      if (ownedTenant != null) {
        return {
          ok: false,
          reason: 'OWNED_TENANT_EXISTS',
          message:
            '入力された初期管理者メールは、既に「自前テナント」を保有しているユーザのものです。追加のテナント払い出しはシステム管理者へお問い合わせください。',
        };
      }
      // 層 2 判定: users に email あり (但し createdByUserId にはなっていない) → 招待 / Default 所属
      if (input.plan === 'beginner') {
        return {
          ok: false,
          reason: 'BEGINNER_REQUIRES_UPGRADE',
          message:
            'このメールアドレスは既に登録履歴があるため、Beginner プランでの新規払い出しはできません。Expert または Pro プランをご選択ください。',
        };
      }
    }
    // 層 3: usersWithSameEmail.length === 0 → 完全な新規 → 制約なし
  }

  // ---------- 3. transaction: Tenant + initial admin User + roleChangeLog ----------
  const placeholderHash = await hash(randomBytes(32).toString('hex'), BCRYPT_COST);

  const { tenant, user } = await prisma.$transaction(async (tx) => {
    const t = await tx.tenant.create({
      data: {
        slug: input.slug,
        name: input.name,
        plan: input.plan as TenantPlan,
        // P-B (2026-05-08): 初回 Beginner 試用期間ルールの実装。
        //   - plan === 'beginner' で作成: 通常の試用開始 (= beginnerEverUpgraded=false で createdAt 起点 90 日)
        //   - plan !== 'beginner' で作成 (super_admin が最初から Pro 等で発行する例外ケース):
        //     **beginnerEverUpgraded=true** で作成 → 「初回から上位プラン」として Beginner 試用対象外に。
        //     後で誤って Beginner にダウングレードしようとしても updateTenantSelf が拒否する。
        beginnerEverUpgraded: input.plan !== 'beginner',
        // 2026-05-09 (PR C / #5): 個人プランでは会社名は null で保存する (UI 非表示)。
        billingType: input.billingType,
        billingCompanyName: input.billingType === 'corporate' ? input.billingCompanyName : null,
        billingContactName: input.billingContactName,
        billingContactEmail: input.billingContactEmail,
        // 2026-05-09 (PR C / #8): 住所サブフィールド化。
        //   新規 onboarding は legacy billingAddress を null で保存し、構造化フィールドのみ使う。
        billingAddress: null,
        billingPostalCode: input.billingPostalCode,
        billingPrefecture: input.billingPrefecture,
        billingCity: input.billingCity,
        billingStreetAddress: input.billingStreetAddress,
        // 2026-05-09 (PR C / #10): building は optional。空文字は null に正規化。
        billingBuildingName: input.billingBuildingName?.trim() || null,
        billingPhoneNumber: input.billingPhoneNumber ?? null,
        paymentMethod: input.paymentMethod,
      },
      select: { id: true },
    });

    const u = await tx.user.create({
      data: {
        tenantId: t.id,
        name: input.initialAdminName,
        email: input.initialAdminEmail,
        passwordHash: placeholderHash,
        systemRole: 'admin',
        // 検証メール経由でパスワード設定するまで非アクティブ
        // (isActive: false で十分。deletedAt セットは NG = 過去 typo を 2026-05-20 削除)
        isActive: false,
        forcePasswordChange: false,
      },
      select: { id: true },
    });

    // 監査: 役割変更ログ (Phase 2-10: tenantId 必須化、新規テナント t.id を使用)
    await tx.roleChangeLog.create({
      data: {
        tenantId: t.id,
        changedBy: u.id, // 自身が初期作成 (super_admin 経路でも auditLog で別途残す)
        targetUserId: u.id,
        changeType: 'system_role',
        beforeRole: null,
        afterRole: 'admin',
        reason: '新規テナント作成 (P-G)',
      },
    });

    // ADR-0016 Revised (2026-05-22): 払い出し直後の初期 admin User.id を Tenant に紐付け。
    //   created_by_user_id は「自前テナント保有」3 層判定 (層 1) で参照される。
    //   tenant.create 時点では User がまだ存在しないため、user.create 後の update で紐付ける。
    //   transaction 内で実行することで rollback 時の整合性を担保。
    await tx.tenant.update({
      where: { id: t.id },
      data: { createdByUserId: u.id },
    });

    // feat/legal-pages-lp-integration (2026-05-21):
    //   規約・プラポリへの同意ログ (民法 548 条の 2 の組入合意証跡)。
    //   サインアップ時の同意は不可変ログとして保存する。
    //   tenantId + consentType + version の UNIQUE で重複防止 (= 同一バージョンへの
    //   多重同意は最初の 1 回のみ記録される)。
    await tx.tenantConsentLog.createMany({
      data: [
        {
          tenantId: t.id,
          userId: u.id,
          consentType: CONSENT_TYPES.TERMS,
          version: CURRENT_TERMS_VERSION,
          ipAddress: consentMeta?.ipAddress ?? null,
          userAgent: consentMeta?.userAgent ?? null,
        },
        {
          tenantId: t.id,
          userId: u.id,
          consentType: CONSENT_TYPES.PRIVACY,
          version: CURRENT_PRIVACY_VERSION,
          ipAddress: consentMeta?.ipAddress ?? null,
          userAgent: consentMeta?.userAgent ?? null,
        },
      ],
    });

    return { tenant: t, user: u };
  });

  // ---------- 4. 検証メール送信 (失敗時 compensating delete) ----------
  // Phase 2-10: sendVerificationEmail に tenantId 必須化
  try {
    await sendVerificationEmail(user.id, tenant.id, input.initialAdminEmail, baseUrl);
  } catch (e) {
    // テナント + ユーザを物理削除 (テナント作成直後のため整合性検査は最小限)
    // Phase 2-10: tenantId フィルタで二重防御
    // feat/legal-pages-lp-integration (2026-05-21): TenantConsentLog も同時削除
    //   (= サインアップ未成立なので、同意ログを残しても意味がない)
    await prisma.$transaction([
      prisma.tenantConsentLog.deleteMany({ where: { tenantId: tenant.id } }),
      prisma.emailVerificationToken.deleteMany({ where: { userId: user.id, tenantId: tenant.id } }),
      prisma.roleChangeLog.deleteMany({ where: { targetUserId: user.id, tenantId: tenant.id } }),
      prisma.user.delete({ where: { id: user.id } }),
      prisma.tenant.delete({ where: { id: tenant.id } }),
    ]);

    if (e instanceof EmailSendError) {
      return {
        ok: false,
        reason: 'EMAIL_SEND_FAILED',
        message: '招待メールの送信に失敗したためテナント作成を取り消しました',
      };
    }
    throw e;
  }

  return {
    ok: true,
    tenantId: tenant.id,
    initialAdminUserId: user.id,
  };
}
