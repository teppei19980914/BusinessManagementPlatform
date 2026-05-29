import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    // ADR-0016 (2026-05-20): sendVerificationEmail が tenant.slug を解決するため mock 追加
    tenant: {
      findUnique: vi.fn(),
    },
    emailVerificationToken: {
      updateMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    user: {
      update: vi.fn(),
      // PR #91: setupPassword が admin 判定のために findUnique を使用
      findUnique: vi.fn(),
      // Phase 1 (2026-05-23 / feat/signup-email-resend-ux):
      //   resendVerificationEmail が pending verification user を tenant-scoped に検索
      findFirst: vi.fn(),
    },
    recoveryCode: {
      createMany: vi.fn(),
    },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

const mockSend = vi.fn();
vi.mock('@/lib/mail', () => ({
  getMailProvider: () => ({ send: mockSend }),
}));

// setupPassword 内の動的 import 対策: bcryptjs を軽量モック化し、
// テスト実行時間が BCRYPT_COST に引きずられないようにする
vi.mock('bcryptjs', () => ({
  hash: vi.fn((v: string) => Promise.resolve(`hashed_${v}`)),
}));

// PR #91: admin 分岐で generateMfaSecret / qrcode を呼ぶのでモック化
vi.mock('./mfa.service', () => ({
  generateMfaSecret: vi.fn().mockResolvedValue({
    secret: 'MOCKSECRET',
    otpauthUri: 'otpauth://totp/test?secret=MOCKSECRET&issuer=tasukiba',
  } as never),
  verifyInitialTotpSecret: vi.fn(),
}));

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,MOCK_QR'),
  },
}));

import {
  sendVerificationEmail,
  verifyEmail,
  validateToken,
  setupPassword,
  setupInitialMfa,
  resendVerificationEmail,
  EmailSendError,
} from './email-verification.service';
import { prisma } from '@/lib/db';
import { verifyInitialTotpSecret } from './mfa.service';

describe('sendVerificationEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.emailVerificationToken.updateMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.emailVerificationToken.create).mockResolvedValue({} as never);
    // ADR-0016 (2026-05-20): tenant slug 解決のための共通 mock
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ slug: 'tenant-a' } as never);
  });

  it('メール送信成功時は正常に完了する', async () => {
    mockSend.mockResolvedValue({ success: true, messageId: 'msg-123' } as never);

    await expect(
      sendVerificationEmail('user-id', 'tenant-A', 'test@example.com', 'https://example.com'),
    ).resolves.toBeUndefined();

    expect(mockSend).toHaveBeenCalledOnce();
    // Phase 1 (2026-05-23 / feat/signup-email-resend-ux):
    //   ログイン時のロックアウト事故を防ぐため、招待メール本文に組織 ID (tenant.slug) を必ず含める
    const sendArgs = mockSend.mock.calls[0]?.[0];
    expect(sendArgs?.html).toContain('tenant-a'); // mock の tenant.slug = 'tenant-a'
    expect(sendArgs?.html).toContain('組織 ID');
    expect(sendArgs?.text).toContain('tenant-a');
    expect(sendArgs?.text).toContain('組織 ID');
    expect(mockSend.mock.calls[0][0].to).toBe('test@example.com');
  });

  // feat/email-login-info-and-no-reply (2026-05-29):
  //   ログイン情報網羅性向上のため、招待メール本文に受信メールアドレスも明示する。
  //   noreply@tasukiba.com からの自動送信であり、本文末尾に no-reply 文言 + LP 問合せフォーム URL を含める。
  it('本文に受信メールアドレスが含まれる (HTML / text 両方)', async () => {
    mockSend.mockResolvedValue({ success: true, messageId: 'msg-email-1' } as never);

    await sendVerificationEmail('user-id', 'tenant-A', 'login@example.com', 'https://example.com');

    const sendArgs = mockSend.mock.calls[0]?.[0];
    expect(sendArgs?.html).toContain('login@example.com');
    expect(sendArgs?.html).toContain('あなたのメールアドレス');
    expect(sendArgs?.text).toContain('login@example.com');
    expect(sendArgs?.text).toContain('あなたのメールアドレス');
  });

  it('本文末尾に no-reply 文言と LP 問合せフォーム URL が含まれる (HTML / text 両方)', async () => {
    mockSend.mockResolvedValue({ success: true, messageId: 'msg-noreply-1' } as never);

    await sendVerificationEmail('user-id', 'tenant-A', 'test@example.com', 'https://example.com');

    const sendArgs = mockSend.mock.calls[0]?.[0];
    // 自動送信 + 返信不可表記
    expect(sendArgs?.html).toContain('noreply@tasukiba.com');
    expect(sendArgs?.html).toContain('返信は受信できません');
    expect(sendArgs?.text).toContain('noreply@tasukiba.com');
    expect(sendArgs?.text).toContain('返信は受信できません');
    // LP 問合せフォーム導線 (種別「たすきばに関するお問い合わせ」)
    expect(sendArgs?.html).toContain('teppei19980914.github.io/HomePage/ja/contact/');
    expect(sendArgs?.html).toContain('たすきばに関するお問い合わせ');
    expect(sendArgs?.text).toContain('teppei19980914.github.io/HomePage/ja/contact/');
    expect(sendArgs?.text).toContain('たすきばに関するお問い合わせ');
  });

  // feat/email-login-info-and-no-reply (2026-05-29) 2 巡目検証:
  //   email を `${email}` で HTML 直接埋め込みしているため XSS 二重防御 (zod の .email() 検証に加え)。
  //   テンプレート整合性として `<`, `>`, `"` は HTML entity に escape される。
  it('受信メールアドレスに HTML 特殊文字が含まれても HTML 側で escape される (XSS 二重防御)', async () => {
    mockSend.mockResolvedValue({ success: true, messageId: 'msg-xss-1' } as never);

    // RFC 5321 quoted-string で許容され得る `"` を含む合成 email
    const maliciousEmail = 'a"<script>alert(1)</script>"@example.com';
    await sendVerificationEmail('user-id', 'tenant-A', maliciousEmail, 'https://example.com');

    const sendArgs = mockSend.mock.calls[0]?.[0];
    // HTML 側では raw タグが現れず、entity 化されている
    expect(sendArgs?.html).not.toContain('<script>alert(1)</script>');
    expect(sendArgs?.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // text 側はそのまま (plaintext のため escape 不要)
    expect(sendArgs?.text).toContain(maliciousEmail);
  });

  it('メール送信失敗時は EmailSendError をスローする', async () => {
    mockSend.mockResolvedValue({ success: false, error: 'Resend 403 error' } as never);

    await expect(
      sendVerificationEmail('user-id', 'tenant-A', 'test@example.com', 'https://example.com'),
    ).rejects.toThrow(EmailSendError);
  });

  it('既存の未使用トークンを無効化してから新しいトークンを作成する', async () => {
    mockSend.mockResolvedValue({ success: true, messageId: 'msg-456' } as never);

    await sendVerificationEmail('user-id', 'tenant-A', 'test@example.com', 'https://example.com');

    expect(prisma.emailVerificationToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-id', tenantId: 'tenant-A', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    expect(prisma.emailVerificationToken.create).toHaveBeenCalledOnce();
  });
});

describe('verifyEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('有効なトークンでアカウントを有効化する', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 'token-id',
      userId: 'user-id',
      tokenHash: 'hash',
      expiresAt: new Date(Date.now() + 3600000),
      usedAt: null,
      createdAt: new Date(),
    } as never);

    const result = await verifyEmail('valid-token');

    expect(result.success).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('存在しないトークンでエラーを返す', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue(null);

    const result = await verifyEmail('invalid-token');

    expect(result.success).toBe(false);
    expect(result.error).toBe('無効なリンクです');
  });

  it('使用済みトークンでエラーを返す', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 'token-id',
      userId: 'user-id',
      tokenHash: 'hash',
      expiresAt: new Date(Date.now() + 3600000),
      usedAt: new Date(),
      createdAt: new Date(),
    } as never);

    const result = await verifyEmail('used-token');

    expect(result.success).toBe(false);
    expect(result.error).toBe('既に使用されたリンクです');
  });

  it('有効期限切れトークンでエラーを返す', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 'token-id',
      userId: 'user-id',
      tokenHash: 'hash',
      expiresAt: new Date(Date.now() - 1000),
      usedAt: null,
      createdAt: new Date(),
    } as never);

    const result = await verifyEmail('expired-token');

    expect(result.success).toBe(false);
    expect(result.error).toBe('有効期限切れです。管理者に再送を依頼してください');
  });
});

describe('EmailSendError', () => {
  it('Error を継承し name が EmailSendError である', () => {
    const err = new EmailSendError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EmailSendError');
    expect(err.message).toBe('test');
  });
});

describe('validateToken', () => {
  beforeEach(() => vi.clearAllMocks());

  it('トークン不在なら 無効なリンク', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue(null);
    const r = await validateToken('x');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('無効');
  });

  it('使用済みなら 既に使用', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'u',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: new Date(),
      createdAt: new Date(),
    } as never);
    const r = await validateToken('x');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('使用');
  });

  it('期限切れなら 有効期限切れ', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'u',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() - 60000),
      usedAt: null,
      createdAt: new Date(),
    } as never);
    const r = await validateToken('x');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('有効期限');
  });

  it('有効なら valid: true', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'u',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: null,
      createdAt: new Date(),
    } as never);
    expect((await validateToken('x')).valid).toBe(true);
  });
});

describe('setupPassword', () => {
  beforeEach(() => vi.clearAllMocks());

  it('トークン不在で エラー', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue(null);
    const r = await setupPassword('x', 'hash');
    expect(r.success).toBe(false);
  });

  it('期限切れで エラー', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'u',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() - 60000),
      usedAt: null,
      createdAt: new Date(),
    } as never);
    const r = await setupPassword('x', 'hash');
    expect(r.success).toBe(false);
  });

  it('一般ユーザ成功時: recoveryCodes + 即時有効化 (requiresMfa=false)', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'u-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: null,
      createdAt: new Date(),
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'u-1',
      systemRole: 'general',
    } as never);

    const r = await setupPassword('x', 'new-hash');

    expect(r.success).toBe(true);
    expect(r.requiresMfa).toBeFalsy();
    expect(Array.isArray(r.recoveryCodes)).toBe(true);
    expect(r.recoveryCodes?.length).toBeGreaterThan(0);
    // $transaction 内で token.usedAt 設定 + user.isActive=true + recoveryCode.createMany
    expect(prisma.$transaction).toHaveBeenCalled();
    const txCall = vi.mocked(prisma.$transaction).mock.calls[0][0] as unknown as unknown[];
    // 一般ユーザ用 transaction は 3 要素 (token update + user update + recoveryCode)
    expect(Array.isArray(txCall)).toBe(true);
    expect(txCall).toHaveLength(3);
  });

  // 2026-05-09 (#11): 強制 MFA を super_admin のみに限定。
  it('super_admin 成功時: requiresMfa=true + mfa データ返却 + token はまだ使用済にしない', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'super-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: null,
      createdAt: new Date(),
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'super-1',
      systemRole: 'super_admin',
    } as never);

    const r = await setupPassword('x', 'new-hash');

    expect(r.success).toBe(true);
    expect(r.requiresMfa).toBe(true);
    expect(r.mfa).toBeDefined();
    expect(r.mfa?.otpauthUri).toContain('otpauth://totp/');
    expect(r.mfa?.qrCodeDataUrl).toContain('data:image/png');
    expect(r.recoveryCodes?.length).toBeGreaterThan(0);

    // super_admin 用 transaction は 2 要素 (user update [isActive 設定しない] + recoveryCode)
    // token.usedAt は setupInitialMfa まで保持される
    const txCall = vi.mocked(prisma.$transaction).mock.calls[0][0] as unknown as unknown[];
    expect(txCall).toHaveLength(2);
  });

  // 2026-05-09 (#11): テナント管理者 (admin) は MFA 任意化に伴い、即時有効化フローへ。
  it('テナント管理者 (admin) 成功時: requiresMfa=false + 即時有効化 (#11)', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'tenant-admin-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: null,
      createdAt: new Date(),
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'tenant-admin-1',
      systemRole: 'admin',
    } as never);

    const r = await setupPassword('x', 'new-hash');

    expect(r.success).toBe(true);
    expect(r.requiresMfa).toBeFalsy();
    expect(r.mfa).toBeUndefined();
    expect(r.recoveryCodes?.length).toBeGreaterThan(0);
    // 一般ユーザと同じ 3 要素 transaction (token.usedAt + user 有効化 + recoveryCode)
    const txCall = vi.mocked(prisma.$transaction).mock.calls[0][0] as unknown as unknown[];
    expect(txCall).toHaveLength(3);
  });

  it('使用済みトークンで エラー', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'u-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: new Date(),
      createdAt: new Date(),
    } as never);
    const r = await setupPassword('x', 'hash');
    expect(r.success).toBe(false);
    expect(r.error).toContain('使用');
  });
});

describe('setupInitialMfa (PR #91)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('トークン不在で エラー', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue(null);
    const r = await setupInitialMfa('x', '123456');
    expect(r.success).toBe(false);
    expect(r.error).toContain('無効');
  });

  it('使用済みトークンで エラー', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'admin-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: new Date(),
      createdAt: new Date(),
    } as never);
    const r = await setupInitialMfa('x', '123456');
    expect(r.success).toBe(false);
    expect(r.error).toContain('使用');
  });

  it('期限切れトークンで エラー', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'admin-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() - 60000),
      usedAt: null,
      createdAt: new Date(),
    } as never);
    const r = await setupInitialMfa('x', '123456');
    expect(r.success).toBe(false);
    expect(r.error).toContain('有効期限');
  });

  it('MFA シークレット未設定で エラー (setupPassword 未実施)', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'admin-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: null,
      createdAt: new Date(),
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'admin-1',
      systemRole: 'admin',
      mfaSecretEncrypted: null,
    } as never);

    const r = await setupInitialMfa('x', '123456');
    expect(r.success).toBe(false);
    expect(r.error).toContain('シークレット');
  });

  it('TOTP コード不一致で エラー', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'admin-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: null,
      createdAt: new Date(),
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'admin-1',
      systemRole: 'admin',
      mfaSecretEncrypted: 'encrypted:xxx',
    } as never);
    vi.mocked(verifyInitialTotpSecret).mockResolvedValue(false);

    const r = await setupInitialMfa('x', '000000');
    expect(r.success).toBe(false);
    expect(r.error).toContain('正しくありません');
  });

  it('成功時: token 使用済 + user.isActive=true + mfaEnabled=true を同一トランザクションで実行', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'admin-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: null,
      createdAt: new Date(),
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'admin-1',
      systemRole: 'admin',
      mfaSecretEncrypted: 'encrypted:xxx',
    } as never);
    vi.mocked(verifyInitialTotpSecret).mockResolvedValue(true);

    const r = await setupInitialMfa('x', '123456');

    expect(r.success).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalled();
    const txCall = vi.mocked(prisma.$transaction).mock.calls[0][0] as unknown as unknown[];
    expect(txCall).toHaveLength(2); // token update + user update
  });
});

// ================================================================
// Phase 1 (2026-05-23 / feat/signup-email-resend-ux):
//   招待メール再送ロジック
// ================================================================

describe('resendVerificationEmail (Phase 1 / signup-email-resend-ux)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.emailVerificationToken.updateMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.emailVerificationToken.create).mockResolvedValue({} as never);
  });

  it('正常系: pending verification user 宛に再送し ok=sent を返す', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      id: 'tenant-uuid',
      deletedAt: null,
      slug: 'customer-a',
    } as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-uuid' } as never);
    mockSend.mockResolvedValue({ success: true, messageId: 'msg-resend-1' } as never);

    const r = await resendVerificationEmail(
      'admin@customer-a.example',
      'customer-a',
      'https://example.com',
    );

    expect(r).toEqual({ ok: true, reason: 'sent' });
    expect(mockSend).toHaveBeenCalledOnce();
    // 既存 token 無効化 + 新規 token 作成が動いていること
    expect(prisma.emailVerificationToken.updateMany).toHaveBeenCalled();
    expect(prisma.emailVerificationToken.create).toHaveBeenCalled();
  });

  it('enumeration 防止: tenant 不在でも silent_skip で 200 相当を返す (メール送信なし)', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue(null);

    const r = await resendVerificationEmail(
      'admin@customer-a.example',
      'nonexistent-tenant',
      'https://example.com',
    );

    expect(r).toEqual({ ok: true, reason: 'silent_skip' });
    expect(mockSend).not.toHaveBeenCalled();
    // user.findFirst も呼ばれない (= tenant 解決失敗段階で早期 return)
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('enumeration 防止: 削除済 tenant も silent_skip', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      id: 'tenant-uuid',
      deletedAt: new Date(),
      slug: 'deleted-tenant',
    } as never);

    const r = await resendVerificationEmail(
      'admin@customer-a.example',
      'deleted-tenant',
      'https://example.com',
    );

    expect(r).toEqual({ ok: true, reason: 'silent_skip' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('enumeration 防止: user 不在も silent_skip (= 攻撃者は email の存在を知れない)', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      id: 'tenant-uuid',
      deletedAt: null,
      slug: 'customer-a',
    } as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);

    const r = await resendVerificationEmail(
      'nonexistent@example.com',
      'customer-a',
      'https://example.com',
    );

    expect(r).toEqual({ ok: true, reason: 'silent_skip' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('enumeration 防止: 既に活性化済ユーザ (isActive=true) は user.findFirst の条件で除外され silent_skip', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      id: 'tenant-uuid',
      deletedAt: null,
      slug: 'customer-a',
    } as never);
    // findFirst の where 条件 (isActive: false) で除外されるため null が返る想定
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);

    const r = await resendVerificationEmail(
      'active-user@example.com',
      'customer-a',
      'https://example.com',
    );

    expect(r).toEqual({ ok: true, reason: 'silent_skip' });
  });

  it('メール送信失敗時は ok=false / reason=EMAIL_SEND_FAILED を返す', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      id: 'tenant-uuid',
      deletedAt: null,
      slug: 'customer-a',
    } as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-uuid' } as never);
    mockSend.mockResolvedValue({ success: false, error: 'Brevo rejected' } as never);

    const r = await resendVerificationEmail(
      'admin@customer-a.example',
      'customer-a',
      'https://example.com',
    );

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('EMAIL_SEND_FAILED');
      expect(r.message).toContain('メール送信に失敗しました');
    }
  });

  it('user.findFirst の where 条件が tenant-scoped + pending verification 限定であること', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      id: 'tenant-uuid',
      deletedAt: null,
      slug: 'customer-a',
    } as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-uuid' } as never);
    mockSend.mockResolvedValue({ success: true } as never);

    await resendVerificationEmail(
      'admin@customer-a.example',
      'customer-a',
      'https://example.com',
    );

    const call = vi.mocked(prisma.user.findFirst).mock.calls[0]?.[0] as {
      where?: {
        tenantId?: string;
        email?: string;
        isActive?: boolean;
        deletedAt?: null;
      };
    };
    expect(call?.where).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-uuid',
        email: 'admin@customer-a.example',
        isActive: false,
        deletedAt: null,
      }),
    );
  });
});
