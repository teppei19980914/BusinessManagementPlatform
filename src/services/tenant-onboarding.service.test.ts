/**
 * テナント新規作成サービスの単体テスト (P-G / 2026-05-08)
 *
 * 検証項目:
 *   - 入力バリデーション (zod): 必須欠落 / 形式不正 / slug 不正
 *   - 重複検証: slug 重複 / メール重複
 *   - 正常系: Tenant + admin User + roleChangeLog が作成されメール送信
 *   - メール送信失敗時: compensating delete でテナント + ユーザを取り消し
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      findUnique: vi.fn(),
      // ADR-0016 Revised (2026-05-22): 層 1 判定で tenants.created_by_user_id を引く
      findFirst: vi.fn(),
      // (legacy) ADR-0016 (2026-05-20) の 4 条件 OR 判定で billingContactEmail を引いていた経路。
      //   Revised 後は使われないが、他テストとの互換維持のため定義は残す。
      findMany: vi.fn(),
      create: vi.fn(),
      // ADR-0016 Revised (2026-05-22): transaction 内で createdByUserId をセットする tx.tenant.update
      update: vi.fn(),
      delete: vi.fn(),
    },
    user: {
      // ADR-0016 Revised (2026-05-22): 層 1/2 判定で initialAdminEmail から users を引く
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    roleChangeLog: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    emailVerificationToken: {
      deleteMany: vi.fn(),
    },
    // feat/legal-pages-lp-integration (2026-05-21): 規約・プラポリ同意ログ
    tenantConsentLog: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    // feat/signup-friction-reduction (2026-06-12): signup 経路の数字連番採番 (pickNextNumericSlug)。
    $queryRaw: vi.fn(),
    $transaction: vi.fn(async (callback: unknown) => {
      // callback 形式 (function) の場合は txClient として prisma 自身を渡す
      if (typeof callback === 'function') {
        // Type-cast for the test mock
        const fn = callback as (tx: typeof import('@/lib/db').prisma) => Promise<unknown>;
        // re-import lazily to use the mocked prisma
        const { prisma } = await import('@/lib/db');
        return fn(prisma);
      }
      // 配列形式の場合は順次 resolve
      return Promise.all(callback as unknown[]);
    }),
  },
}));

vi.mock('./email-verification.service', async () => {
  class EmailSendError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'EmailSendError';
    }
  }
  return {
    sendVerificationEmail: vi.fn(),
    EmailSendError,
  };
});

vi.mock('bcryptjs', () => ({
  hash: vi.fn(async (val: string) => `hashed_${val}`),
}));

import {
  createTenantBySuperAdmin,
  createTenantBySignup,
  TenantOnboardingInputSchema,
} from './tenant-onboarding.service';
import { prisma } from '@/lib/db';
import {
  sendVerificationEmail,
  EmailSendError,
} from './email-verification.service';

// 2026-05-09 (PR C / #5/#8/#10): billingType + 構造化住所サブフィールドを必須化
const VALID_INPUT = {
  name: 'カスタマーA',
  slug: 'customer-a',
  plan: 'beginner' as const,
  billingType: 'corporate' as const,
  billingCompanyName: 'カスタマーA 株式会社',
  billingContactName: '山田太郎',
  billingContactEmail: 'billing@customer-a.example',
  billingPostalCode: '100-0001',
  billingPrefecture: '東京都',
  billingCity: '千代田区',
  billingStreetAddress: '千代田1-1',
  billingBuildingName: '〇〇ビル 5F',
  billingPhoneNumber: '03-1234-5678',
  paymentMethod: 'invoice' as const,
  initialAdminName: 'admin Yamada',
  initialAdminEmail: 'admin@customer-a.example',
  // feat/legal-pages-lp-integration (2026-05-21): 規約・プラポリ同意は必須 (= true 強制)
  acceptedTerms: true as const,
  acceptedPrivacy: true as const,
};

const BASE_URL = 'https://example.com';

beforeEach(() => {
  vi.clearAllMocks();
  // デフォルトでは slug 重複なし、メール重複なし、解約済テナントなし (P-B)
  vi.mocked(prisma.tenant.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.tenant.findFirst).mockResolvedValue(null); // ADR-0016 Revised: 層 1 default = なし
  vi.mocked(prisma.tenant.findMany).mockResolvedValue([]);
  vi.mocked(prisma.user.findMany).mockResolvedValue([]); // ADR-0016 Revised: 層 2 default = なし
  vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.tenant.create).mockResolvedValue({ id: 'tenant-uuid' } as never);
  vi.mocked(prisma.tenant.update).mockResolvedValue({ id: 'tenant-uuid' } as never);
  vi.mocked(prisma.user.create).mockResolvedValue({ id: 'user-uuid' } as never);
  vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);
  // feat/legal-pages-lp-integration: 同意ログ createMany は count 戻りを期待
  vi.mocked(prisma.tenantConsentLog.createMany).mockResolvedValue({ count: 2 } as never);
  vi.mocked(sendVerificationEmail).mockResolvedValue();
  // feat/signup-friction-reduction (2026-06-12): 数字連番採番のデフォルト = 既存数字 slug なし
  //   (→ pickNextNumericSlug が NUMERIC_SLUG_BASE=100000 を返す)。
  vi.mocked(prisma.$queryRaw).mockResolvedValue([{ max: null }] as never);
});

describe('TenantOnboardingInputSchema', () => {
  it('正常な入力は parse 成功', () => {
    const r = TenantOnboardingInputSchema.safeParse(VALID_INPUT);
    expect(r.success).toBe(true);
  });

  // feat/billing-conditional-by-plan (2026-06-05): プラン別の請求先必須/任意を両方向で固定する。
  //   この describe が壊れたら「Beginner で住所必須化された」or「Expert で住所任意化された」デグレ。
  describe('プラン別の請求先住所の必須/任意 (両方向)', () => {
    // 住所 4 項目 + 会社名を欠いた入力 (= Beginner が省略できる状態)
    const withoutAddress = {
      ...VALID_INPUT,
      billingCompanyName: undefined,
      billingPostalCode: undefined,
      billingPrefecture: undefined,
      billingCity: undefined,
      billingStreetAddress: undefined,
      billingBuildingName: undefined,
    };

    it('Beginner: 住所・会社名が無くても parse 成功 (任意)', () => {
      const r = TenantOnboardingInputSchema.safeParse({
        ...withoutAddress,
        plan: 'beginner',
        billingType: 'individual',
      });
      expect(r.success).toBe(true);
    });

    it('Expert: 住所が無いと parse 失敗 (必須)', () => {
      const r = TenantOnboardingInputSchema.safeParse({
        ...withoutAddress,
        plan: 'expert',
        billingType: 'individual',
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        const paths = r.error.issues.map((i) => i.path.join('.'));
        expect(paths).toContain('billingPostalCode');
        expect(paths).toContain('billingPrefecture');
        expect(paths).toContain('billingCity');
        expect(paths).toContain('billingStreetAddress');
      }
    });

    it('Pro: 住所が揃っていれば parse 成功', () => {
      const r = TenantOnboardingInputSchema.safeParse({ ...VALID_INPUT, plan: 'pro' });
      expect(r.success).toBe(true);
    });

    it('Expert 法人: 会社名が無いと parse 失敗', () => {
      const r = TenantOnboardingInputSchema.safeParse({
        ...VALID_INPUT,
        plan: 'expert',
        billingType: 'corporate',
        billingCompanyName: undefined,
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues.map((i) => i.path.join('.'))).toContain('billingCompanyName');
      }
    });

    it('Expert 個人: 会社名が無くても住所が揃えば parse 成功', () => {
      const r = TenantOnboardingInputSchema.safeParse({
        ...VALID_INPUT,
        plan: 'expert',
        billingType: 'individual',
        billingCompanyName: undefined,
      });
      expect(r.success).toBe(true);
    });
  });

  it('slug 形式不正は reject', () => {
    const bad = { ...VALID_INPUT, slug: 'INVALID UPPERCASE' };
    expect(TenantOnboardingInputSchema.safeParse(bad).success).toBe(false);
  });

  it('メールアドレス不正は reject', () => {
    const bad = { ...VALID_INPUT, billingContactEmail: 'not-an-email' };
    expect(TenantOnboardingInputSchema.safeParse(bad).success).toBe(false);
  });

  it('paymentMethod は enum 限定 (任意値は reject)', () => {
    const bad = { ...VALID_INPUT, paymentMethod: 'paypal' };
    expect(TenantOnboardingInputSchema.safeParse(bad).success).toBe(false);
  });

  // 2026-05-09 (#4) / 2026-05-30 更新: credit_card 払いは launch 時点で有効化済 (TC-L4 PASS)
  //   だが、サインアップ時は 90 日無料試用の体験を優先し paymentMethod='invoice' を強制。
  //   credit_card 切替は登録後 /settings/tenant 経由で実施 (= UX 設計、tenant-onboarding.service.ts:93)。
  //   サインアップ時 credit_card 受付に拡張する場合は本テストの期待値を反転 + 関連設計見直しが必要。
  it('paymentMethod は credit_card を reject (= signup は invoice 固定、card 切替は登録後)', () => {
    const bad = { ...VALID_INPUT, paymentMethod: 'credit_card' };
    expect(TenantOnboardingInputSchema.safeParse(bad).success).toBe(false);
  });

  it('plan 省略時は beginner デフォルト', () => {
    const noPlan = { ...VALID_INPUT };
    delete (noPlan as Partial<typeof noPlan>).plan;
    const r = TenantOnboardingInputSchema.safeParse(noPlan);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.plan).toBe('beginner');
  });

  // 2026-05-09 (PR C / #5): 法人は会社名必須。
  // feat/billing-conditional-by-plan (2026-06-05): この必須は Expert/Pro のみ (Beginner は請求先任意)。
  //   そのため plan を expert にして「法人 × 会社名空 → reject」を固定する。
  it('法人 Expert プランで会社名空は reject (#5)', () => {
    const bad = { ...VALID_INPUT, plan: 'expert' as const, billingCompanyName: '' };
    expect(TenantOnboardingInputSchema.safeParse(bad).success).toBe(false);
  });

  // 2026-05-09 (PR C / #5): 個人プランは会社名 optional (空で OK)
  it('個人プランは会社名なしでも parse 成功 (#5)', () => {
    const individual = {
      ...VALID_INPUT,
      billingType: 'individual' as const,
      billingCompanyName: undefined,
    };
    const r = TenantOnboardingInputSchema.safeParse(individual);
    expect(r.success).toBe(true);
  });

  // 2026-05-09 (PR C / #8): 郵便番号フォーマット検証
  it('郵便番号が 7 桁でないと reject (#8)', () => {
    const bad = { ...VALID_INPUT, billingPostalCode: '12345' };
    expect(TenantOnboardingInputSchema.safeParse(bad).success).toBe(false);
  });

  it('郵便番号 7 桁 (ハイフンなし) も受理 (#8)', () => {
    const noHyphen = { ...VALID_INPUT, billingPostalCode: '1000001' };
    expect(TenantOnboardingInputSchema.safeParse(noHyphen).success).toBe(true);
  });

  // 2026-05-09 (PR C / #10): 建物名は任意
  it('建物名は省略可 (#10)', () => {
    const noBuilding = { ...VALID_INPUT };
    delete (noBuilding as Partial<typeof noBuilding>).billingBuildingName;
    const r = TenantOnboardingInputSchema.safeParse(noBuilding);
    expect(r.success).toBe(true);
  });

  // feat/legal-pages-lp-integration (2026-05-21): 規約・プラポリ同意は true 強制
  it('acceptedTerms=false は reject (規約同意必須)', () => {
    const bad = { ...VALID_INPUT, acceptedTerms: false };
    expect(TenantOnboardingInputSchema.safeParse(bad).success).toBe(false);
  });

  it('acceptedPrivacy=false は reject (プラポリ同意必須)', () => {
    const bad = { ...VALID_INPUT, acceptedPrivacy: false };
    expect(TenantOnboardingInputSchema.safeParse(bad).success).toBe(false);
  });

  it('acceptedTerms / acceptedPrivacy 欠落は reject', () => {
    const noTerms = { ...VALID_INPUT };
    delete (noTerms as Partial<typeof noTerms>).acceptedTerms;
    expect(TenantOnboardingInputSchema.safeParse(noTerms).success).toBe(false);

    const noPrivacy = { ...VALID_INPUT };
    delete (noPrivacy as Partial<typeof noPrivacy>).acceptedPrivacy;
    expect(TenantOnboardingInputSchema.safeParse(noPrivacy).success).toBe(false);
  });
});

describe('createTenantBySuperAdmin', () => {
  it('正常系: Tenant + 初期 admin が作成され招待メールが送られる', async () => {
    const result = await createTenantBySuperAdmin(VALID_INPUT, BASE_URL);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tenantId).toBe('tenant-uuid');
      expect(result.initialAdminUserId).toBe('user-uuid');
    }

    expect(prisma.tenant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          slug: 'customer-a',
          name: 'カスタマーA',
          plan: 'beginner',
          billingCompanyName: 'カスタマーA 株式会社',
          billingContactEmail: 'billing@customer-a.example',
          paymentMethod: 'invoice',
        }),
      }),
    );
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-uuid',
          email: 'admin@customer-a.example',
          systemRole: 'admin',
          isActive: false,
        }),
      }),
    );
    // Phase 2-10: sendVerificationEmail に tenantId 必須化
    expect(sendVerificationEmail).toHaveBeenCalledWith('user-uuid', 'tenant-uuid', 'admin@customer-a.example', BASE_URL);
  });

  it('slug 重複なら SLUG_CONFLICT (Tenant.create を呼ばない)', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({ id: 'existing' } as never);

    const result = await createTenantBySuperAdmin(VALID_INPUT, BASE_URL);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('SLUG_CONFLICT');
    expect(prisma.tenant.create).not.toHaveBeenCalled();
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  // ADR-0016 (2026-05-20): EMAIL_CONFLICT は廃止された (tenant-scoped 一意化で発生不能)。
  //   新規テナント作成時、初期 admin email は新テナント内で唯一なので、
  //   旧仕様の global email 重複検査は意味を失った。
  //   代わりに「他テナントに同 email が居ても作成できる」ことを保証する。
  it('ADR-0016: 他テナントに同 email が存在しても作成可能 (multi-tenant membership)', async () => {
    // 他テナントに同 email が存在することを示すために user.findFirst を mock しても、
    // tenant-onboarding はもはや global email 検査をしないので create 成功する。
    const result = await createTenantBySuperAdmin(VALID_INPUT, BASE_URL);

    expect(result.ok).toBe(true);
    expect(prisma.tenant.create).toHaveBeenCalled();
  });

  it('入力バリデーション失敗は VALIDATION_ERROR', async () => {
    const bad = { ...VALID_INPUT, billingContactEmail: 'not-email' };
    const result = await createTenantBySuperAdmin(bad as never, BASE_URL);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('VALIDATION_ERROR');
    expect(prisma.tenant.create).not.toHaveBeenCalled();
  });

  it('メール送信失敗時は compensating delete でテナント + ユーザを取り消し', async () => {
    vi.mocked(sendVerificationEmail).mockRejectedValueOnce(new EmailSendError('Provider down'));

    const result = await createTenantBySuperAdmin(VALID_INPUT, BASE_URL);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('EMAIL_SEND_FAILED');

    // 削除呼出 (compensating)
    expect(prisma.user.delete).toHaveBeenCalledWith({
      where: { id: 'user-uuid' },
    });
    expect(prisma.tenant.delete).toHaveBeenCalledWith({
      where: { id: 'tenant-uuid' },
    });
  });
});

describe('createTenantBySignup', () => {
  it('内部実装は createTenantBySuperAdmin と同じ (= 正常系で同じ result)', async () => {
    const result = await createTenantBySignup(VALID_INPUT, BASE_URL);

    expect(result.ok).toBe(true);
    expect(prisma.tenant.create).toHaveBeenCalled();
    expect(prisma.user.create).toHaveBeenCalled();
    expect(sendVerificationEmail).toHaveBeenCalled();
  });
});

// feat/legal-pages-lp-integration (2026-05-21):
// 規約・プラポリ同意ログを TenantConsentLog に保存する (民法 548 条の 2 / 定型約款の組入合意証跡)。
describe('TenantConsentLog 同意ログ記録', () => {
  it('正常系で terms と privacy の 2 件が createMany で記録される', async () => {
    await createTenantBySignup(VALID_INPUT, BASE_URL, {
      ipAddress: '203.0.113.42',
      userAgent: 'Mozilla/5.0 (Test)',
    });

    expect(prisma.tenantConsentLog.createMany).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.tenantConsentLog.createMany).mock.calls[0]?.[0];
    expect(call?.data).toEqual([
      expect.objectContaining({
        tenantId: 'tenant-uuid',
        userId: 'user-uuid',
        consentType: 'terms',
        version: '1.0',
        ipAddress: '203.0.113.42',
        userAgent: 'Mozilla/5.0 (Test)',
      }),
      expect.objectContaining({
        tenantId: 'tenant-uuid',
        userId: 'user-uuid',
        consentType: 'privacy',
        version: '1.0',
        ipAddress: '203.0.113.42',
        userAgent: 'Mozilla/5.0 (Test)',
      }),
    ]);
  });

  it('consentMeta を渡さない場合は ipAddress / userAgent が null になる', async () => {
    await createTenantBySignup(VALID_INPUT, BASE_URL);

    const call = vi.mocked(prisma.tenantConsentLog.createMany).mock.calls[0]?.[0];
    // data は単一 or 配列だが、本サービスは常に配列で渡すため narrow する
    const rows = Array.isArray(call?.data) ? call.data : [];
    expect(rows[0]).toMatchObject({ ipAddress: null, userAgent: null });
    expect(rows[1]).toMatchObject({ ipAddress: null, userAgent: null });
  });

  it('メール送信失敗時の compensating delete で tenantConsentLog も削除される', async () => {
    vi.mocked(sendVerificationEmail).mockRejectedValueOnce(new EmailSendError('Provider down'));

    await createTenantBySignup(VALID_INPUT, BASE_URL);

    expect(prisma.tenantConsentLog.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-uuid' },
    });
  });
});

describe('ADR-0016 Revised (2026-05-22): 3 層判定 (initialAdminEmail のみで判定)', () => {
  // 層 1: 自前テナント保有 = users.email = initialAdminEmail かつ tenants.createdByUserId に紐付き
  describe('層 1: OWNED_TENANT_EXISTS (= 公開フォーム完全不可)', () => {
    it('initialAdminEmail を持つ user が tenants.createdByUserId に紐付くと OWNED_TENANT_EXISTS', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
        { id: 'creator-user' },
      ] as never);
      vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
        id: 'owned-tenant',
      } as never);

      const result = await createTenantBySignup(VALID_INPUT, BASE_URL);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('OWNED_TENANT_EXISTS');
      expect(prisma.tenant.create).not.toHaveBeenCalled();
    });

    it('層 1 は plan=expert/pro でも block (= 公開フォームは全プラン不可)', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
        { id: 'creator-user' },
      ] as never);
      vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
        id: 'owned-tenant',
      } as never);

      const result = await createTenantBySignup(
        { ...VALID_INPUT, plan: 'expert' },
        BASE_URL,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('OWNED_TENANT_EXISTS');
    });
  });

  // 層 2: 招待 / Default 所属のみ = users.email = initialAdminEmail だが createdByUserId 未紐付
  describe('層 2: BEGINNER_REQUIRES_UPGRADE (= Beginner 不可、Expert/Pro 可)', () => {
    it('initialAdminEmail を持つ user は存在するが自前テナント未保有なら Beginner 不可', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
        { id: 'member-user' },
      ] as never);
      vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null); // 層 1 該当なし

      const result = await createTenantBySignup(VALID_INPUT, BASE_URL);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('BEGINNER_REQUIRES_UPGRADE');
      expect(prisma.tenant.create).not.toHaveBeenCalled();
    });

    it('層 2 でも plan=expert なら作成可能 + beginnerEverUpgraded=true で初期化', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
        { id: 'member-user' },
      ] as never);
      vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null);

      const result = await createTenantBySignup(
        { ...VALID_INPUT, plan: 'expert' },
        BASE_URL,
      );

      expect(result.ok).toBe(true);
      expect(prisma.tenant.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            plan: 'expert',
            beginnerEverUpgraded: true,
          }),
        }),
      );
    });
  });

  // 層 3: 完全な新規 = users.email = initialAdminEmail が一切なし
  describe('層 3: 完全な新規 (= 全プラン可)', () => {
    it('users.email = initialAdminEmail が無ければ Beginner で作成可能', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValueOnce([] as never);

      const result = await createTenantBySignup(VALID_INPUT, BASE_URL);

      expect(result.ok).toBe(true);
      expect(prisma.tenant.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            plan: 'beginner',
            beginnerEverUpgraded: false,
          }),
        }),
      );
    });

    it('billingContactEmail が他テナントの user.email と被っていても層判定に影響しない', async () => {
      // billingContactEmail = billing@customer-a.example, initialAdminEmail = admin@customer-a.example
      // initialAdminEmail のみで判定するため、billingContactEmail の重複は無視される。
      // user.findMany は initialAdminEmail のみで呼ばれ、結果 [] (= 層 3) のまま。
      vi.mocked(prisma.user.findMany).mockResolvedValueOnce([] as never);

      const result = await createTenantBySignup(VALID_INPUT, BASE_URL);

      expect(result.ok).toBe(true);
      // 確認: user.findMany は initialAdminEmail で呼ばれた
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'admin@customer-a.example' },
        }),
      );
    });
  });

  // SA-2 (2026-05-22): super_admin 経路は 3 層判定を完全スキップ
  describe('SA-2: createTenantBySuperAdmin は 3 層判定を完全スキップ', () => {
    // 注: SA-2 では eligibility check が走らないため `mockResolvedValueOnce` を
    //   仕掛けても消費されず、次の test に **leak** する罠がある。
    //   よって SA-2 テストでは判定 hot path mock の事前セットアップを **意図的に省略** し、
    //   「呼ばれないこと」のみを assertion で検証する。
    it('super_admin 経由は user.findMany / tenant.findFirst を一切呼ばずに作成成功', async () => {
      const result = await createTenantBySuperAdmin(VALID_INPUT, BASE_URL);

      expect(result.ok).toBe(true);
      // 3 層判定の hot path クエリ (user.findMany / tenant.findFirst) は呼ばれない
      expect(prisma.user.findMany).not.toHaveBeenCalled();
      expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
    });

    it('super_admin 経由は Beginner プラン指定で beginnerEverUpgraded=false で作成', async () => {
      const result = await createTenantBySuperAdmin(VALID_INPUT, BASE_URL);

      expect(result.ok).toBe(true);
      expect(prisma.tenant.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ plan: 'beginner', beginnerEverUpgraded: false }),
        }),
      );
    });
  });

  // ADR-0016 Revised: 払い出し時に Tenant.createdByUserId を初期 admin に紐付ける
  describe('createdByUserId 紐付け', () => {
    it('正常系: transaction 内で tenant.update が createdByUserId=u.id でコールされる', async () => {
      await createTenantBySignup(VALID_INPUT, BASE_URL);

      expect(prisma.tenant.update).toHaveBeenCalledWith({
        where: { id: 'tenant-uuid' },
        data: { createdByUserId: 'user-uuid' },
      });
    });
  });

  // feat/signup-friction-reduction (2026-06-12): 公開サインアップは組織 ID をサーバが数字連番で自動採番
  describe('組織 ID サーバ自動採番 (signup)', () => {
    it('signup は slug を入力させず、既存数字 slug が無ければ 100000 を採番して作成 + 返却', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ max: null }] as never);

      const result = await createTenantBySignup(VALID_INPUT, BASE_URL);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.slug).toBe('100000');
      // tenant.create には採番された数字 slug が渡る (入力 'customer-a' は無視)
      expect(prisma.tenant.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ slug: '100000' }) }),
      );
    });

    it('既存数字 slug の最大値 + 1 を採番する (連番)', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ max: BigInt(100042) }] as never);

      const result = await createTenantBySignup(VALID_INPUT, BASE_URL);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.slug).toBe('100043');
    });

    it('採番した slug が衝突 (P2002) したらリトライ採番して成功する', async () => {
      // 1 回目: max=100000 → 100001 を採番 → tenant.create が P2002 で衝突
      // 2 回目: max=100001 → 100002 を採番 → 成功
      vi.mocked(prisma.$queryRaw)
        .mockResolvedValueOnce([{ max: BigInt(100000) }] as never)
        .mockResolvedValueOnce([{ max: BigInt(100001) }] as never);
      vi.mocked(prisma.tenant.create)
        .mockRejectedValueOnce(
          Object.assign(new Error('Unique constraint'), {
            code: 'P2002',
            meta: { target: ['slug'] },
          }),
        )
        .mockResolvedValueOnce({ id: 'tenant-uuid' } as never);

      const result = await createTenantBySignup(VALID_INPUT, BASE_URL);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.slug).toBe('100002');
      expect(prisma.tenant.create).toHaveBeenCalledTimes(2);
    });
  });

  // super_admin 手動払い出しは従来どおり slug 必須 (自動採番しない)
  describe('super_admin は組織 ID (slug) 必須', () => {
    it('slug 未指定の super_admin 入力は VALIDATION_ERROR', async () => {
      const { slug: _omit, ...withoutSlug } = VALID_INPUT;
      void _omit;
      const result = await createTenantBySuperAdmin(withoutSlug, BASE_URL);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('VALIDATION_ERROR');
      // 自動採番クエリは呼ばれない
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('slug 指定の super_admin はその slug で作成し、自動採番しない', async () => {
      const result = await createTenantBySuperAdmin(VALID_INPUT, BASE_URL);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.slug).toBe('customer-a');
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.tenant.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ slug: 'customer-a' }) }),
      );
    });
  });

  it('Beginner プランで作成すると beginnerEverUpgraded=false (= 試用開始)', async () => {
    await createTenantBySuperAdmin(VALID_INPUT, BASE_URL);

    expect(prisma.tenant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          plan: 'beginner',
          beginnerEverUpgraded: false,
        }),
      }),
    );
  });
});
