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
 *   - **paymentMethod は文字列**: enum 化は将来 (現状 'invoice' / 'bank_transfer' / 'credit_card'
 *     の 3 値想定だが UI 側のバリデーションで担保)
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
    paymentMethod: z.enum(['invoice', 'bank_transfer']).default('invoice'),

    /** 初期 admin ユーザ (検証メール送付先 = ログイン用) */
    initialAdminName: z.string().trim().min(1).max(100),
    initialAdminEmail: z.string().trim().email().max(255),
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
    | 'EMAIL_CONFLICT'
    | 'EMAIL_SEND_FAILED'
    // P-B (2026-05-08): 解約済テナントの請求先メールで Beginner プラン再登録を拒否
    | 'BEGINNER_NOT_AVAILABLE_FOR_RETURNING';
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
): Promise<TenantOnboardingResult> {
  return createTenantInternal(input, baseUrl);
}

/**
 * 公開 /signup からのセルフサインアップ経路。
 *
 * - 内部実装は super_admin 経路と同一 (= バリデーション + Tenant + 初期 admin)
 * - 上位 API ルート側で rate limit / honeypot などのスパム対策を実施する前提
 *   (本サービス層では検証しない = テストしやすさ + 関心の分離)
 */
export async function createTenantBySignup(
  input: unknown,
  baseUrl: string,
): Promise<TenantOnboardingResult> {
  return createTenantInternal(input, baseUrl);
}

// ================================================================
// 内部
// ================================================================

async function createTenantInternal(
  rawInput: unknown,
  baseUrl: string,
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

  const existingEmail = await prisma.user.findFirst({
    where: { email: input.initialAdminEmail, deletedAt: null },
    select: { id: true },
  });
  if (existingEmail != null) {
    return {
      ok: false,
      reason: 'EMAIL_CONFLICT',
      message: 'このメールアドレスは既に他のテナントで使用されています',
    };
  }

  // P-B (2026-05-08): 解約済テナントの billingContactEmail で Beginner 再登録を拒否
  //   - 「Beginner プランは本当に初めてのユーザのみ 90 日限定」方針
  //   - 同じ請求先メールで過去に解約 (= deletedAt セット) されたテナントがあれば、
  //     再登録時は Expert/Pro 必須にする
  //   - billingContactEmail も initialAdminEmail も両方チェック (= 一方を変えて回避を防ぐ)
  // 2026-05-09 (#18 強化): users 行を永続保持する方針 (purgeOldDeletedTenants で削除しない)
  //   に伴い、過去テナントの user.email でも abuse-prevention 判定する (defense-in-depth)。
  //   1 つのメアドが「テナント請求先」でも「テナント内 admin ユーザ」でもなかったとしても、
  //   過去にどこかのテナントに登録されていれば Beginner 再契約を拒否する。
  if (input.plan === 'beginner') {
    const [previousDeletedTenants, previousDeletedUsers] = await Promise.all([
      prisma.tenant.findMany({
        where: {
          deletedAt: { not: null },
          OR: [
            { billingContactEmail: input.billingContactEmail },
            { billingContactEmail: input.initialAdminEmail },
          ],
        },
        select: { id: true },
      }),
      // 2026-05-09 (#18): 解約済テナントに所属していた user の email で同 email 再登録を拒否
      prisma.user.findFirst({
        where: {
          deletedAt: { not: null },
          OR: [
            { email: input.billingContactEmail },
            { email: input.initialAdminEmail },
          ],
        },
        select: { id: true },
      }),
    ]);
    if (previousDeletedTenants.length > 0 || previousDeletedUsers != null) {
      return {
        ok: false,
        reason: 'BEGINNER_NOT_AVAILABLE_FOR_RETURNING',
        message:
          'このメールアドレスは過去に解約されたテナントで使用されており、Beginner プランでの再登録はできません。Expert または Pro プランをご検討ください。',
      };
    }
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
        isActive: false,
        deletedAt: new Date(),
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

    return { tenant: t, user: u };
  });

  // ---------- 4. 検証メール送信 (失敗時 compensating delete) ----------
  // Phase 2-10: sendVerificationEmail に tenantId 必須化
  try {
    await sendVerificationEmail(user.id, tenant.id, input.initialAdminEmail, baseUrl);
  } catch (e) {
    // テナント + ユーザを物理削除 (テナント作成直後のため整合性検査は最小限)
    // Phase 2-10: tenantId フィルタで二重防御
    await prisma.$transaction([
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
