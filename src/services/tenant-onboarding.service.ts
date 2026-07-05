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
import { nextNumericSlug } from '@/lib/slug';

// ================================================================
// 公開型
// ================================================================

/** 共通の入力バリデーション (super_admin / signup 共通) */
export const TenantOnboardingInputSchema = z
  .object({
    /** 表示用テナント名 (画面ヘッダ等。請求書の正式社名は billingCompanyName を使う) */
    name: z.string().trim().min(1).max(100),
    /**
     * URL ルーティング用 slug (英数 + ハイフン、3-60 文字)。
     * feat/signup-friction-reduction (2026-06-12): 公開サインアップでは未指定 (optional)。
     *   サーバが数字連番を自動採番する (createTenantBySignup → autoAssignSlug)。
     *   super_admin 手動払い出しでは引き続き必須 (createTenantInternal が presence を強制)。
     */
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$/, {
        message: 'slug は英小文字・数字・ハイフンのみ、3〜60 文字で入力してください',
      })
      .optional(),
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
    // feat/billing-conditional-by-plan (2026-06-05): プラン別に住所の必須/任意を出し分ける。
    //   - field レベルでは全て optional にし (= 値があれば形式検証はする)、
    //   - Expert/Pro のときだけ superRefine で「未入力なら必須エラー」を出す。
    //   - Beginner は課金が発生しないため住所は任意 (UI でも非表示)。後から設定画面で入力可。
    //   regex は「値があるとき」のみ検証されるよう optional の前段に置く。
    billingPostalCode: z
      .string()
      .trim()
      .regex(/^\d{3}-?\d{4}$/, {
        message: '郵便番号は 7 桁 (例 100-0001) で入力してください',
      })
      .optional(),
    billingPrefecture: z.string().trim().max(20).optional(),
    billingCity: z.string().trim().max(100).optional(),
    billingStreetAddress: z.string().trim().max(200).optional(),
    billingBuildingName: z.string().trim().max(200).optional(),

    /** 任意 */
    billingPhoneNumber: z.string().trim().max(20).optional(),
    // 2026-05-09 (#4) / 2026-05-30 更新: 新規 sign-up API は paymentMethod を 'invoice' 固定で受付。
    //   credit_card 払いは 2026-05-30 に有効化済だが (TC-L4 PASS、PR #469)、サインアップ初期は
    //   90 日無料試用の体験を優先するため card 登録は強制せず、登録後 /settings/tenant 経由で
    //   credit_card へ切替する UX 設計。本 enum を ['invoice', 'credit_card'] に拡張する場合は
    //   サインアップフォーム + Checkout 経路 + Subscription 5 Item 紐付けの設計見直しが必要。
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
  // feat/billing-conditional-by-plan (2026-06-05): プラン別の請求先必須判定 (defense-in-depth)。
  //   - Expert/Pro: 住所 4 項目 (郵便番号/都道府県/市区町村/番地) + 法人なら会社名を必須化。
  //     => 課金が発生する有料プランは請求書送付のため請求先を厳格に揃える。
  //   - Beginner: 住所・会社名とも任意 (= 課金が発生しないため。UI でも請求先セクションを非表示にし、
  //     billingContactName/Email は初期管理者の値を流用する。後から /settings/tenant で入力可)。
  //   旧 .refine (法人のみ会社名必須) はこの superRefine に統合した。
  .superRefine((d, ctx) => {
    if (d.plan === 'beginner') return; // Beginner は請求先任意 (課金なし)

    const addressFields: Array<[keyof typeof d, string]> = [
      ['billingPostalCode', '郵便番号'],
      ['billingPrefecture', '都道府県'],
      ['billingCity', '市区町村'],
      ['billingStreetAddress', '番地・町名'],
    ];
    for (const [field, label] of addressFields) {
      const value = d[field];
      if (value == null || String(value).trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field as string],
          message: `${label}は必須です`,
        });
      }
    }

    // 法人プランは会社名 / 法人名を必須 (個人は不要)
    if (
      d.billingType === 'corporate' &&
      (d.billingCompanyName == null || d.billingCompanyName.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['billingCompanyName'],
        message: '法人プランでは会社名 / 法人名は必須です',
      });
    }
  });

export type TenantOnboardingInput = z.infer<typeof TenantOnboardingInputSchema>;

export type TenantOnboardingSuccess = {
  ok: true;
  tenantId: string;
  initialAdminUserId: string;
  /** 実際に確定した組織 ID (slug)。signup では自動採番された数字 ID。UI が成功画面/再送で使う。 */
  slug: string;
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
  // feat/signup-friction-reduction (2026-06-12): 公開サインアップは組織 ID を入力させず、
  //   サーバが数字連番を自動採番する (autoAssignSlug=true)。
  return createTenantInternal(input, baseUrl, consentMeta, { autoAssignSlug: true });
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
  /**
   * feat/signup-friction-reduction (2026-06-12): true で組織 ID (slug) をサーバが数字連番で
   * 自動採番する (入力 slug は無視)。公開サインアップ経路でのみ true。衝突時はリトライ採番する。
   * false (super_admin 経路) では input.slug が必須。
   */
  autoAssignSlug?: boolean;
};

/** 既存の純粋数字 slug の最大値 + 1 を採番する (NUMERIC_SLUG_BASE 以上を保証)。 */
async function pickNextNumericSlug(): Promise<string> {
  // 15 桁上限で bigint キャスト安全域に限定 (overflow / Number 精度落ち防止)。
  const rows = await prisma.$queryRaw<{ max: bigint | null }[]>`
    SELECT MAX(slug::bigint) AS max FROM tenants WHERE slug ~ '^[0-9]{1,15}$'
  `;
  const maxNumeric = rows[0]?.max != null ? Number(rows[0].max) : 0;
  return String(nextNumericSlug(maxNumeric));
}

/**
 * P2002 (UNIQUE 制約違反) が slug 列で発生したかを判定する。
 * @prisma/client の Prisma 名前空間を import すると test 環境で runtime client を巻き込むため、
 * 構造的に code / meta.target を判定する (PrismaClientKnownRequestError は code='P2002' を持つ)。
 */
function isSlugUniqueViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: unknown; meta?: { target?: unknown } };
  if (err.code !== 'P2002') return false;
  const target = err.meta?.target;
  if (Array.isArray(target)) return target.includes('slug');
  return typeof target === 'string' && target.includes('slug');
}

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

  // ---------- 2. slug の決定 / 重複チェック ----------
  // feat/signup-friction-reduction (2026-06-12):
  //   - autoAssignSlug (公開サインアップ): slug は入力させず、後段のトランザクションで
  //     数字連番を採番する (衝突時リトライ)。ここでは事前チェック不要。
  //   - !autoAssignSlug (super_admin 手動): input.slug 必須 + 事前重複チェック (従来どおり)。
  if (!options.autoAssignSlug) {
    if (input.slug == null || input.slug.length === 0) {
      return {
        ok: false,
        reason: 'VALIDATION_ERROR',
        message: '組織 ID を入力してください',
      };
    }
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
  //
  //   Race condition について (= 同 email で同時 signup):
  //   本ブロックの判定は transaction 外で実行されるため、判定 → tenant.create の間に race window
  //   が存在する。ただし最終的に **slug UNIQUE constraint** ([prisma/schema.prisma の Tenant.slug])
  //   が同 slug の二重作成を拒否するため、実用上は問題にならない (= UI で email → slug を auto-suggest
  //   する設計のもとでは衝突確率は極低)。rate limit 5 req/hour も race 抑止に寄与。
  //   将来「同 user に同時に複数の 自前テナントが作られる」abuse が顕在化した場合は、本判定を
  //   prisma.$transaction の serializable isolation 内に移動する。
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

  // feat/signup-friction-reduction (2026-06-12): トランザクション本体を slug 引数で受ける関数に切り出し、
  //   下の採番リトライループから呼ぶ。
  const runCreate = (slug: string) =>
    prisma.$transaction(async (tx) => {
    const t = await tx.tenant.create({
      data: {
        slug,
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
        // feat/billing-conditional-by-plan (2026-06-05): Beginner は住所が任意 (undefined) のため
        //   ?? null で明示的に NULL 保存する (Expert/Pro は superRefine で値が保証される)。
        billingPostalCode: input.billingPostalCode ?? null,
        billingPrefecture: input.billingPrefecture ?? null,
        billingCity: input.billingCity ?? null,
        billingStreetAddress: input.billingStreetAddress ?? null,
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
        // 初期 admin は「招待中」でなく「有効（要 PW 再設定）」として作成する。
        //   invitationAcceptedAt: null のままだと管理者一覧に「招待中」と表示され、
        //   削除操作が cancelInvitation 経路になる。メールからのパスワード設定フロー
        //   (sendVerificationEmail + forcePasswordChange) は引き続き必須とする。
        isActive: true,
        invitationAcceptedAt: new Date(),
        forcePasswordChange: true,
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

  // slug を確定してトランザクション実行。autoAssignSlug は数字連番の衝突 (P2002) を
  //   最大 5 回までリトライ採番する (ユーザは組織 ID を編集できないため、衝突時に手で直せる
  //   従来 UX が無いことへの対策)。super_admin 経路は input.slug 固定で 1 回のみ。
  const MAX_SLUG_ATTEMPTS = options.autoAssignSlug ? 5 : 1;
  let tenant!: { id: string };
  let user!: { id: string };
  let assignedSlug = '';
  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = options.autoAssignSlug ? await pickNextNumericSlug() : (input.slug as string);
    try {
      const r = await runCreate(slug);
      tenant = r.tenant;
      user = r.user;
      assignedSlug = slug;
      break;
    } catch (e) {
      if (isSlugUniqueViolation(e)) {
        if (options.autoAssignSlug && attempt < MAX_SLUG_ATTEMPTS) continue;
        return {
          ok: false,
          reason: 'SLUG_CONFLICT',
          message: options.autoAssignSlug
            ? '組織 ID の自動採番に失敗しました。時間をおいて再度お試しください。'
            : 'この組織 ID は既に使用されています',
        };
      }
      throw e;
    }
  }

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
    slug: assignedSlug,
  };
}
