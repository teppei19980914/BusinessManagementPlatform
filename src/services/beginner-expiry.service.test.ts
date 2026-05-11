/**
 * Beginner プラン期限管理サービスの単体テスト (P-B / 2026-05-08)
 *
 * 検証項目:
 *   - getBeginnerExpiryState: 4 段階分類 (active / warning_60 / warning_75 / expired)
 *   - 境界値 (Day 59→60, 74→75, 89→90)
 *   - plan != beginner / beginnerEverUpgraded=true / 管理テナント = 'active'
 *   - getBeginnerDaysRemaining: 残り日数の計算
 *   - sendBeginnerExpiryNotices: state ごとの送信ロジック + 重複送信防止
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(),
}));

vi.mock('@/lib/mail', () => ({
  getMailProvider: vi.fn(),
}));

import {
  getBeginnerExpiryState,
  getBeginnerDaysRemaining,
  isBeginnerExpired,
  sendBeginnerExpiryNotices,
  BEGINNER_NOTICE_DAY_60,
  BEGINNER_NOTICE_DAY_75,
  BEGINNER_EXPIRY_DAYS,
} from './beginner-expiry.service';
import { prisma } from '@/lib/db';
import { getMailProvider } from '@/lib/mail';

const NOW = new Date('2026-05-08T00:00:00Z');
const day = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getBeginnerExpiryState', () => {
  describe('境界値 (createdAt 起点)', () => {
    it('Day 59 (= 60 日未満) は active', () => {
      const tenant = { plan: 'beginner', createdAt: day(59), beginnerEverUpgraded: false };
      expect(getBeginnerExpiryState(tenant, NOW)).toBe('active');
    });

    it('Day 60 ちょうどは warning_60', () => {
      const tenant = { plan: 'beginner', createdAt: day(60), beginnerEverUpgraded: false };
      expect(getBeginnerExpiryState(tenant, NOW)).toBe('warning_60');
    });

    it('Day 74 は warning_60', () => {
      const tenant = { plan: 'beginner', createdAt: day(74), beginnerEverUpgraded: false };
      expect(getBeginnerExpiryState(tenant, NOW)).toBe('warning_60');
    });

    it('Day 75 ちょうどは warning_75', () => {
      const tenant = { plan: 'beginner', createdAt: day(75), beginnerEverUpgraded: false };
      expect(getBeginnerExpiryState(tenant, NOW)).toBe('warning_75');
    });

    it('Day 89 は warning_75', () => {
      const tenant = { plan: 'beginner', createdAt: day(89), beginnerEverUpgraded: false };
      expect(getBeginnerExpiryState(tenant, NOW)).toBe('warning_75');
    });

    it('Day 90 ちょうどは expired', () => {
      const tenant = { plan: 'beginner', createdAt: day(90), beginnerEverUpgraded: false };
      expect(getBeginnerExpiryState(tenant, NOW)).toBe('expired');
    });

    it('Day 200 は expired', () => {
      const tenant = { plan: 'beginner', createdAt: day(200), beginnerEverUpgraded: false };
      expect(getBeginnerExpiryState(tenant, NOW)).toBe('expired');
    });
  });

  describe('対象外', () => {
    it('plan=expert は常に active (90 日経過していても)', () => {
      const tenant = { plan: 'expert', createdAt: day(200), beginnerEverUpgraded: true };
      expect(getBeginnerExpiryState(tenant, NOW)).toBe('active');
    });

    it('plan=pro は常に active', () => {
      const tenant = { plan: 'pro', createdAt: day(200), beginnerEverUpgraded: false };
      expect(getBeginnerExpiryState(tenant, NOW)).toBe('active');
    });

    it('beginnerEverUpgraded=true なら active (= 上位プラン経験済の Beginner は試用対象外)', () => {
      const tenant = { plan: 'beginner', createdAt: day(200), beginnerEverUpgraded: true };
      expect(getBeginnerExpiryState(tenant, NOW)).toBe('active');
    });
  });

  it('定数値の整合性', () => {
    expect(BEGINNER_NOTICE_DAY_60).toBe(60);
    expect(BEGINNER_NOTICE_DAY_75).toBe(75);
    expect(BEGINNER_EXPIRY_DAYS).toBe(90);
  });

  describe('PR-4: テナント TZ カレンダー日ベース判定', () => {
    it('JST 14:00 作成 → 90 日後 09:00 JST 時点は expired (旧仕様の絶対経過 89.98 日では active になっていた)', () => {
      // JST 2026-02-01 14:00 = UTC 2026-02-01 05:00
      const createdAt = new Date('2026-02-01T05:00:00Z');
      // JST 2026-05-02 09:00 = UTC 2026-05-02 00:00
      const checkAt = new Date('2026-05-02T00:00:00Z');
      const tenant = {
        plan: 'beginner',
        createdAt,
        beginnerEverUpgraded: false,
        timezone: 'Asia/Tokyo',
      };
      expect(getBeginnerExpiryState(tenant, checkAt)).toBe('expired');
      expect(getBeginnerDaysRemaining(tenant, checkAt)).toBe(0);
    });

    it('UTC TZ 指定: 旧仕様と同じ結果 (絶対経過時間ベースに収束)', () => {
      const tenant = {
        plan: 'beginner',
        createdAt: day(60),
        beginnerEverUpgraded: false,
        timezone: 'UTC',
      };
      expect(getBeginnerExpiryState(tenant, NOW)).toBe('warning_60');
    });

    it('timezone 未指定 → DEFAULT_TIMEZONE (Asia/Tokyo) で判定 (既存呼出の後方互換)', () => {
      const tenant = {
        plan: 'beginner',
        createdAt: day(60),
        beginnerEverUpgraded: false,
      };
      expect(getBeginnerExpiryState(tenant, NOW)).toBe('warning_60');
    });
  });
});

describe('getBeginnerDaysRemaining', () => {
  it('Day 30 → 60 日残り', () => {
    const tenant = { plan: 'beginner', createdAt: day(30), beginnerEverUpgraded: false };
    expect(getBeginnerDaysRemaining(tenant, NOW)).toBe(60);
  });

  it('Day 89 → 1 日残り', () => {
    const tenant = { plan: 'beginner', createdAt: day(89), beginnerEverUpgraded: false };
    expect(getBeginnerDaysRemaining(tenant, NOW)).toBe(1);
  });

  it('Day 90 ちょうど → 0 日残り (= 期限切れ初日)', () => {
    const tenant = { plan: 'beginner', createdAt: day(90), beginnerEverUpgraded: false };
    expect(getBeginnerDaysRemaining(tenant, NOW)).toBe(0);
  });

  it('Day 100 (= 期限超過) → -10', () => {
    const tenant = { plan: 'beginner', createdAt: day(100), beginnerEverUpgraded: false };
    expect(getBeginnerDaysRemaining(tenant, NOW)).toBe(-10);
  });

  it('plan=expert なら null', () => {
    const tenant = { plan: 'expert', createdAt: day(30), beginnerEverUpgraded: true };
    expect(getBeginnerDaysRemaining(tenant, NOW)).toBeNull();
  });
});

describe('isBeginnerExpired', () => {
  it('Day 89 は false', () => {
    expect(
      isBeginnerExpired({ plan: 'beginner', createdAt: day(89), beginnerEverUpgraded: false }, NOW),
    ).toBe(false);
  });

  it('Day 90 は true', () => {
    expect(
      isBeginnerExpired({ plan: 'beginner', createdAt: day(90), beginnerEverUpgraded: false }, NOW),
    ).toBe(true);
  });

  it('plan=expert は常に false', () => {
    expect(
      isBeginnerExpired({ plan: 'expert', createdAt: day(200), beginnerEverUpgraded: true }, NOW),
    ).toBe(false);
  });
});

describe('sendBeginnerExpiryNotices', () => {
  function setupMailMock() {
    const send = vi.fn().mockResolvedValue({ success: true });
    vi.mocked(getMailProvider).mockReturnValue({ send } as never);
    return send;
  }

  it('warning_60 状態 + Day60 未送信 → 60 日メール送信 + フラグ更新', async () => {
    const send = setupMailMock();
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      {
        id: 't1',
        name: 'T1',
        plan: 'beginner',
        createdAt: day(60),
        beginnerEverUpgraded: false,
        billingContactEmail: 'billing@t1.example',
        billingContactName: '担当者A',
        beginnerNoticeDay60SentAt: null,
        beginnerNoticeDay75SentAt: null,
        beginnerExpiredNoticeSentAt: null,
      },
    ] as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const result = await sendBeginnerExpiryNotices('https://example.com', NOW);

    expect(result.day60Sent).toBe(1);
    expect(result.day75Sent).toBe(0);
    expect(result.expiredSent).toBe(0);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'billing@t1.example',
        subject: expect.stringContaining('残り 30 日'),
      }),
    );
  });

  it('既に Day60 送信済なら再送しない', async () => {
    const send = setupMailMock();
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      {
        id: 't1',
        name: 'T1',
        plan: 'beginner',
        createdAt: day(70),
        beginnerEverUpgraded: false,
        billingContactEmail: 'billing@t1.example',
        billingContactName: 'A',
        beginnerNoticeDay60SentAt: day(10), // 10 日前に送信済
        beginnerNoticeDay75SentAt: null,
        beginnerExpiredNoticeSentAt: null,
      },
    ] as never);

    const result = await sendBeginnerExpiryNotices('https://example.com', NOW);

    expect(result.day60Sent).toBe(0); // 重複送信なし
    expect(send).not.toHaveBeenCalled();
  });

  it('warning_75 で Day60 未送信 + Day75 未送信 → 両方送信 (後追いで Day60 を飛ばさない)', async () => {
    const send = setupMailMock();
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      {
        id: 't1',
        name: 'T1',
        plan: 'beginner',
        createdAt: day(76),
        beginnerEverUpgraded: false,
        billingContactEmail: 'billing@t1.example',
        billingContactName: 'A',
        beginnerNoticeDay60SentAt: null, // Day60 もまだ送信していない
        beginnerNoticeDay75SentAt: null,
        beginnerExpiredNoticeSentAt: null,
      },
    ] as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const result = await sendBeginnerExpiryNotices('https://example.com', NOW);

    expect(result.day60Sent).toBe(1);
    expect(result.day75Sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('expired 状態 + 期限通知未送信 → 期限切れメール送信', async () => {
    const send = setupMailMock();
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      {
        id: 't1',
        name: 'T1',
        plan: 'beginner',
        createdAt: day(95),
        beginnerEverUpgraded: false,
        billingContactEmail: 'billing@t1.example',
        billingContactName: 'A',
        beginnerNoticeDay60SentAt: day(35),
        beginnerNoticeDay75SentAt: day(20),
        beginnerExpiredNoticeSentAt: null,
      },
    ] as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const result = await sendBeginnerExpiryNotices('https://example.com', NOW);

    expect(result.expiredSent).toBe(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining('期限切れ'),
      }),
    );
  });

  it('billingContactEmail 未設定なら failed カウント (recordError 経由)', async () => {
    setupMailMock();
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      {
        id: 't1',
        name: 'T1',
        plan: 'beginner',
        createdAt: day(60),
        beginnerEverUpgraded: false,
        billingContactEmail: null, // 未設定
        billingContactName: null,
        beginnerNoticeDay60SentAt: null,
        beginnerNoticeDay75SentAt: null,
        beginnerExpiredNoticeSentAt: null,
      },
    ] as never);

    const result = await sendBeginnerExpiryNotices('https://example.com', NOW);

    expect(result.day60Sent).toBe(0);
    expect(result.failed).toBe(1);
  });
});
