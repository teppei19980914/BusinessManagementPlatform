import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('./auth-event.service', () => ({
  recordAuthEvent: vi.fn().mockResolvedValue(undefined),
}));

import {
  generateMfaSecret,
  enableMfa,
  disableMfa,
  verifyTotp,
  resetMfaLockOnRecoveryCodeUse,
  unlockMfaByAdmin,
  MfaLockedError,
  MFA_FAIL_LIMIT,
  MFA_LOCK_DURATION_MS,
} from './mfa.service';
import { prisma } from '@/lib/db';
import { recordAuthEvent } from './auth-event.service';

describe('TOTP (otplib) 低レベル動作', () => {
  it('シークレット生成・検証ができる', async () => {
    const otplib = await import('otplib');
    const secret = otplib.generateSecret();
    expect(secret).toBeDefined();
    const token = otplib.generateSync({ secret });
    expect(token).toHaveLength(6);
    expect(otplib.verifySync({ token, secret }).valid).toBe(true);
  });

  it('不正なコードで検証が失敗する', async () => {
    const otplib = await import('otplib');
    const secret = otplib.generateSecret();
    expect(otplib.verifySync({ token: '000000', secret }).valid).toBe(false);
  });

  it('otpauth URI が生成できる', async () => {
    const otplib = await import('otplib');
    const secret = otplib.generateSecret();
    const uri = otplib.generateURI({
      label: 'test@example.com',
      issuer: 'TestApp',
      secret,
    });
    expect(uri).toContain('otpauth://totp/');
  });

  it('epochTolerance=30 で前の period のコードも許容される (LESSONS §4.28)', async () => {
    const otplib = await import('otplib');
    const secret = otplib.generateSecret();

    // ちょうど 30 秒前 (= 必ず W-1) の時刻で生成したコード。
    // 35 秒だと now%30 ≥ 25 のとき W-2 になり ±1 window を超えて flaky だったので、
    // 30 秒固定にして毎回 W-1 window に着地させる。
    const pastEpoch = Math.floor(Date.now() / 1000) - 30;
    const pastToken = otplib.generateSync({ secret, epoch: pastEpoch });

    // 既定 (epochTolerance 未指定) では前 period のコードは拒否される可能性がある
    // が、epochTolerance=30 を設定すれば ±1 window 許容で valid になる
    const withTolerance = otplib.verifySync({
      token: pastToken,
      secret,
      epochTolerance: 30,
    });
    expect(withTolerance.valid).toBe(true);
  });

  it('epochTolerance=30 で次の period のコードも許容される (時刻先行時)', async () => {
    const otplib = await import('otplib');
    const secret = otplib.generateSecret();

    // ちょうど 30 秒後 (= 必ず W+1) の時刻で生成したコード。35 秒だと flaky になる。
    const futureEpoch = Math.floor(Date.now() / 1000) + 30;
    const futureToken = otplib.generateSync({ secret, epoch: futureEpoch });

    const withTolerance = otplib.verifySync({
      token: futureToken,
      secret,
      epochTolerance: 30,
    });
    expect(withTolerance.valid).toBe(true);
  });

  it('epochTolerance=30 でも 60 秒以上離れたコードは拒否される (過剰許容防止)', async () => {
    const otplib = await import('otplib');
    const secret = otplib.generateSecret();

    // 90 秒前の時刻で生成したコード (= 許容外)
    const tooOldEpoch = Math.floor((Date.now() - 90 * 1000) / 1000);
    const tooOldToken = otplib.generateSync({ secret, epoch: tooOldEpoch });

    const result = otplib.verifySync({
      token: tooOldToken,
      secret,
      epochTolerance: 30,
    });
    expect(result.valid).toBe(false);
  });
});

describe('generateMfaSecret', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ユーザ不在で NOT_FOUND', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    await expect(generateMfaSecret('u1')).rejects.toThrow('NOT_FOUND');
  });

  it('シークレットを生成して user.update を呼ぶ', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'u1',
      email: 'a@b.co',
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const result = await generateMfaSecret('u1');

    expect(result.secret).toBeDefined();
    expect(result.otpauthUri).toContain('otpauth://totp/');
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({
          mfaSecretEncrypted: expect.any(String),
        }),
      }),
    );
  });

  it('PR #114 L-2: mfaEnabled=true のユーザは ALREADY_ENABLED を throw', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'u1',
      email: 'a@b.co',
      mfaEnabled: true,
    } as never);

    await expect(generateMfaSecret('u1')).rejects.toThrow('ALREADY_ENABLED');
    // シークレット再生成は行わない (情報漏洩防止)
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('enableMfa', () => {
  beforeEach(() => vi.clearAllMocks());

  it('シークレット未生成でエラー', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ mfaSecretEncrypted: null } as never);
    const r = await enableMfa('u1', '123456');
    expect(r.success).toBe(false);
    expect(r.error).toContain('シークレット');
  });

  it('TOTP コードが誤りでエラー', async () => {
    // 先に generateMfaSecret を通してシークレットを DB に格納する
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'u1',
      email: 'a@b.co',
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
    let savedEncrypted = '';
    vi.mocked(prisma.user.update).mockImplementationOnce(async (args) => {
      savedEncrypted = (args.data as { mfaSecretEncrypted: string }).mfaSecretEncrypted;
      return {} as never;
    });
    await generateMfaSecret('u1');

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'u1',
      mfaSecretEncrypted: savedEncrypted,
    } as never);

    const r = await enableMfa('u1', '000000');
    expect(r.success).toBe(false);
  });

  it('TOTP が正しければ有効化成功 + 監査ログ', async () => {
    // 事前にシークレット発行
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'u1',
      email: 'a@b.co',
    } as never);
    let savedEncrypted = '';
    vi.mocked(prisma.user.update).mockImplementationOnce(async (args) => {
      savedEncrypted = (args.data as { mfaSecretEncrypted: string }).mfaSecretEncrypted;
      return {} as never;
    });
    const gen = await generateMfaSecret('u1');

    // 正しい TOTP コード生成
    const otplib = await import('otplib');
    const validCode = otplib.generateSync({ secret: gen.secret });

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      mfaSecretEncrypted: savedEncrypted,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as never);

    const r = await enableMfa('u1', validCode);
    expect(r.success).toBe(true);
    expect(recordAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ action: 'mfa_enabled' }) }),
    );
  });
});

describe('disableMfa', () => {
  beforeEach(() => vi.clearAllMocks());

  it('一般ユーザ: MFA 関連フィールドをクリアして監査ログを残す', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ systemRole: 'general' } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    await disableMfa('u1');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { mfaEnabled: false, mfaSecretEncrypted: null, mfaEnabledAt: null },
    });
    expect(recordAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ action: 'mfa_disabled' }) }),
    );
  });

  it('PR #91: admin は CANNOT_DISABLE_ADMIN_MFA を throw (サービス層防御)', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ systemRole: 'admin' } as never);

    await expect(disableMfa('admin-1')).rejects.toThrow('CANNOT_DISABLE_ADMIN_MFA');
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(recordAuthEvent).not.toHaveBeenCalled();
  });
});

describe('verifyTotp', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ユーザ不在で false', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    expect(await verifyTotp('u1', '123456')).toBe(false);
  });

  it('MFA 無効で false', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      mfaEnabled: false,
      mfaSecretEncrypted: null,
    } as never);
    expect(await verifyTotp('u1', '123456')).toBe(false);
  });

  it('正しい TOTP で true', async () => {
    // 事前に encrypt されたシークレットを用意
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'u1',
      email: 'a@b.co',
    } as never);
    let savedEncrypted = '';
    vi.mocked(prisma.user.update).mockImplementationOnce(async (args) => {
      savedEncrypted = (args.data as { mfaSecretEncrypted: string }).mfaSecretEncrypted;
      return {} as never;
    });
    const gen = await generateMfaSecret('u1');

    const otplib = await import('otplib');
    const code = otplib.generateSync({ secret: gen.secret });

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      mfaEnabled: true,
      mfaSecretEncrypted: savedEncrypted,
    } as never);

    expect(await verifyTotp('u1', code)).toBe(true);
  });

  it('誤った TOTP で false', async () => {
    // 事前に encrypt されたシークレットを用意
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'u1',
      email: 'a@b.co',
    } as never);
    let savedEncrypted = '';
    vi.mocked(prisma.user.update).mockImplementationOnce(async (args) => {
      savedEncrypted = (args.data as { mfaSecretEncrypted: string }).mfaSecretEncrypted;
      return {} as never;
    });
    await generateMfaSecret('u1');

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      mfaEnabled: true,
      mfaSecretEncrypted: savedEncrypted,
    } as never);

    expect(await verifyTotp('u1', '000000')).toBe(false);
  });
});

describe('PR #116: MFA ロック機構 (verifyTotp / resetMfaLockOnRecoveryCodeUse / unlockMfaByAdmin)', () => {
  // 共通のシークレット準備 (毎ケース実行前にリセット)
  let savedEncrypted = '';
  let validCode = '';

  beforeEach(async () => {
    vi.clearAllMocks();
    // 初回 generateMfaSecret で暗号化されたシークレットを得る
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'u1',
      email: 'a@b.co',
    } as never);
    vi.mocked(prisma.user.update).mockImplementationOnce(async (args) => {
      savedEncrypted = (args.data as { mfaSecretEncrypted: string }).mfaSecretEncrypted;
      return {} as never;
    });
    const gen = await generateMfaSecret('u1');
    const otplib = await import('otplib');
    validCode = otplib.generateSync({ secret: gen.secret });
    // beforeEach で消費した call history をクリアし、本体アサーション側の
    // call-count 検査 (update が X 回呼ばれる等) を安全化する
    vi.mocked(prisma.user.update).mockClear();
    vi.mocked(prisma.user.findUnique).mockClear();
    vi.mocked(recordAuthEvent).mockClear();
  });

  it('ロック中は verifyTotp が MfaLockedError を throw (TOTP 検証をスキップ)', async () => {
    const futureTime = new Date(Date.now() + 10 * 60 * 1000); // 10 分後
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      mfaEnabled: true,
      mfaSecretEncrypted: savedEncrypted,
      mfaFailedCount: 0,
      mfaLockedUntil: futureTime,
    } as never);

    await expect(verifyTotp('u1', validCode)).rejects.toThrow(MfaLockedError);
    // TOTP 検証用の update は呼ばれない (早期 throw で副作用なし)
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('過去の lockedUntil はロック解除済みとして通常検証に進む', async () => {
    const pastTime = new Date(Date.now() - 10 * 60 * 1000); // 10 分前
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      mfaEnabled: true,
      mfaSecretEncrypted: savedEncrypted,
      mfaFailedCount: 0,
      mfaLockedUntil: pastTime,
    } as never);

    const r = await verifyTotp('u1', validCode);
    expect(r).toBe(true);
  });

  it('正解 TOTP で mfaFailedCount と mfaLockedUntil を 0 / null にリセット (既存値があれば)', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      mfaEnabled: true,
      mfaSecretEncrypted: savedEncrypted,
      mfaFailedCount: 2,
      mfaLockedUntil: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const r = await verifyTotp('u1', validCode);
    expect(r).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { mfaFailedCount: 0, mfaLockedUntil: null },
      }),
    );
  });

  it('正解 TOTP でも既存カウントがゼロなら update をスキップ (書込み削減)', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      mfaEnabled: true,
      mfaSecretEncrypted: savedEncrypted,
      mfaFailedCount: 0,
      mfaLockedUntil: null,
    } as never);

    const r = await verifyTotp('u1', validCode);
    expect(r).toBe(true);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('誤 TOTP で mfaFailedCount を +1 (閾値未達)', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      mfaEnabled: true,
      mfaSecretEncrypted: savedEncrypted,
      mfaFailedCount: 0,
      mfaLockedUntil: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const r = await verifyTotp('u1', '000000');
    expect(r).toBe(false);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mfaFailedCount: 1, mfaLockedUntil: undefined }),
      }),
    );
  });

  it(`誤 TOTP 連続 ${MFA_FAIL_LIMIT} 回目で lockedUntil をセット + MfaLockedError を throw + auth_event 記録`, async () => {
    // 既に 2 回失敗済、今回 3 回目 = 閾値到達
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      mfaEnabled: true,
      mfaSecretEncrypted: savedEncrypted,
      mfaFailedCount: MFA_FAIL_LIMIT - 1,
      mfaLockedUntil: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    await expect(verifyTotp('u1', '000000')).rejects.toThrow(MfaLockedError);

    // update で lockedUntil が 30 分後に設定される
    const call = vi.mocked(prisma.user.update).mock.calls[0][0];
    const data = call.data as { mfaFailedCount: number; mfaLockedUntil: Date };
    expect(data.mfaFailedCount).toBe(0); // 閾値到達で新サイクル開始のため 0 に戻す
    expect(data.mfaLockedUntil).toBeInstanceOf(Date);
    expect(data.mfaLockedUntil.getTime()).toBeGreaterThan(Date.now() + MFA_LOCK_DURATION_MS - 1000);

    // 監査ログ
    expect(recordAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'lock',
        userId: 'u1',
        detail: expect.objectContaining({
          lockType: 'mfa_temporary',
          reason: 'mfa_failure_threshold_exceeded',
        }),
      }),
    );
  });

  it('resetMfaLockOnRecoveryCodeUse: カウンタ + lockedUntil を一括リセット', async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
    await resetMfaLockOnRecoveryCodeUse('u1');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { mfaFailedCount: 0, mfaLockedUntil: null },
    });
  });

  it('unlockMfaByAdmin: カウンタ + lockedUntil を一括リセット', async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
    await unlockMfaByAdmin('u1');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { mfaFailedCount: 0, mfaLockedUntil: null },
    });
  });
});
