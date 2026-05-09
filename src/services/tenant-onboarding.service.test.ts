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
      // P-B (2026-05-08): 解約済テナントの billingContactEmail で Beginner 再登録拒否
      findMany: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    user: {
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
};

const BASE_URL = 'https://example.com';

beforeEach(() => {
  vi.clearAllMocks();
  // デフォルトでは slug 重複なし、メール重複なし、解約済テナントなし (P-B)
  vi.mocked(prisma.tenant.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.tenant.findMany).mockResolvedValue([]);
  vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.tenant.create).mockResolvedValue({ id: 'tenant-uuid' } as never);
  vi.mocked(prisma.user.create).mockResolvedValue({ id: 'user-uuid' } as never);
  vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);
  vi.mocked(sendVerificationEmail).mockResolvedValue();
});

describe('TenantOnboardingInputSchema', () => {
  it('正常な入力は parse 成功', () => {
    const r = TenantOnboardingInputSchema.safeParse(VALID_INPUT);
    expect(r.success).toBe(true);
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

  // 2026-05-09 (#4): クレジットカード決済は現状未対応のため API でも reject。
  //   将来対応時はこのテストの期待値を反転させる。
  it('paymentMethod は credit_card を reject (#4 future support)', () => {
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

  // 2026-05-09 (PR C / #5): 法人プランは会社名必須
  it('法人プランで会社名空は reject (#5)', () => {
    const bad = { ...VALID_INPUT, billingCompanyName: '' };
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
    expect(sendVerificationEmail).toHaveBeenCalledWith('user-uuid', 'admin@customer-a.example', BASE_URL);
  });

  it('slug 重複なら SLUG_CONFLICT (Tenant.create を呼ばない)', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({ id: 'existing' } as never);

    const result = await createTenantBySuperAdmin(VALID_INPUT, BASE_URL);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('SLUG_CONFLICT');
    expect(prisma.tenant.create).not.toHaveBeenCalled();
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('初期 admin メール重複なら EMAIL_CONFLICT', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({ id: 'existing-user' } as never);

    const result = await createTenantBySuperAdmin(VALID_INPUT, BASE_URL);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('EMAIL_CONFLICT');
    expect(prisma.tenant.create).not.toHaveBeenCalled();
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

describe('P-B (2026-05-08): Beginner プラン再登録防止 + beginnerEverUpgraded セット', () => {
  it('解約済テナントの billingContactEmail で Beginner 再登録すると BEGINNER_NOT_AVAILABLE_FOR_RETURNING', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      { id: 'past-deleted-tenant' },
    ] as never);

    const result = await createTenantBySignup(VALID_INPUT, BASE_URL);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('BEGINNER_NOT_AVAILABLE_FOR_RETURNING');
    expect(prisma.tenant.create).not.toHaveBeenCalled();
  });

  // 2026-05-09 (#18): 解約済 user の email でも Beginner 再登録を拒否 (defense-in-depth)
  it('解約済 user の email で Beginner 再登録すると BEGINNER_NOT_AVAILABLE_FOR_RETURNING (#18)', async () => {
    // tenant.findMany は空 (= 過去テナントなし) だが、user.findFirst が hit するパス
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([] as never);
    // 通常 mock: user.findFirst (line ~98 の重複チェック) は active user なし → null
    // → 2 回目: user.findFirst (#18 abuse check) で過去 soft-deleted user が見つかる
    vi.mocked(prisma.user.findFirst)
      .mockResolvedValueOnce(null) // 1 回目: メール重複チェック (deletedAt=null フィルタ)
      .mockResolvedValueOnce({ id: 'soft-deleted-user' } as never); // 2 回目: abuse check

    const result = await createTenantBySignup(VALID_INPUT, BASE_URL);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('BEGINNER_NOT_AVAILABLE_FOR_RETURNING');
    expect(prisma.tenant.create).not.toHaveBeenCalled();
  });

  it('plan=expert/pro なら解約再登録チェックは実施されず作成可能 + beginnerEverUpgraded=true で初期化', async () => {
    // 注: findMany を mockResolvedValueOnce で「解約済あり」にしても、plan=expert なので
    // そもそも findMany が呼ばれない (= プランで早期に bypass する)。明示的に未呼出を verify。

    const result = await createTenantBySuperAdmin(
      { ...VALID_INPUT, plan: 'expert' },
      BASE_URL,
    );

    expect(result.ok).toBe(true);
    expect(prisma.tenant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          plan: 'expert',
          // 上位プランで作成 → beginnerEverUpgraded=true で初期化 (= 後で Beginner ダウングレード不可)
          beginnerEverUpgraded: true,
        }),
      }),
    );
    // findMany は呼ばれない (= Beginner 再登録チェックを skip)
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
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
