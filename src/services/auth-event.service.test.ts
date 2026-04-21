import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    authEventLog: { create: vi.fn() },
  },
}));

import { recordAuthEvent } from './auth-event.service';
import { prisma } from '@/lib/db';

describe('recordAuthEvent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('最小構成 (eventType のみ) で記録できる', async () => {
    vi.mocked(prisma.authEventLog.create).mockResolvedValue({} as never);

    await recordAuthEvent({ eventType: 'login_success' });

    expect(prisma.authEventLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'login_success' }),
    });
  });

  it('userId / email / ipAddress / userAgent / detail を全部記録', async () => {
    vi.mocked(prisma.authEventLog.create).mockResolvedValue({} as never);

    await recordAuthEvent({
      eventType: 'login_failure',
      userId: 'u1',
      email: 'a@b.co',
      ipAddress: '10.0.0.1',
      userAgent: 'vitest',
      detail: { reason: 'invalid_password' },
    });

    expect(prisma.authEventLog.create).toHaveBeenCalledWith({
      data: {
        eventType: 'login_failure',
        userId: 'u1',
        email: 'a@b.co',
        ipAddress: '10.0.0.1',
        userAgent: 'vitest',
        detail: { reason: 'invalid_password' },
      },
    });
  });

  it('各 eventType を受け付ける (型テスト)', async () => {
    vi.mocked(prisma.authEventLog.create).mockResolvedValue({} as never);
    const types = [
      'login_success',
      'login_failure',
      'logout',
      'lock',
      'password_change',
      'account_created',
      'account_deactivated',
      'account_reactivated',
    ] as const;
    for (const t of types) {
      await recordAuthEvent({ eventType: t });
    }
    expect(prisma.authEventLog.create).toHaveBeenCalledTimes(types.length);
  });
});
