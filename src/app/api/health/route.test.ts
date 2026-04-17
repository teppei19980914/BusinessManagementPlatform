import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

// `next/server` は vitest の node 環境で素直に読める
import { GET } from './route';
import { prisma } from '@/lib/db';

const mockedQueryRaw = vi.mocked(prisma.$queryRaw);

describe('GET /api/health', () => {
  beforeEach(() => {
    mockedQueryRaw.mockReset();
  });

  it('DB 応答 ok → HTTP 200・status=ok・db=ok', async () => {
    mockedQueryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
    expect(typeof body.responseTimeMs).toBe('number');
  });

  it('DB エラー → HTTP 503・status=degraded・db=error（副作用で落ちない）', async () => {
    mockedQueryRaw.mockRejectedValueOnce(new Error('boom'));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.db).toBe('error');
  });

  it('応答に機密情報（スタックトレース・接続文字列等）が含まれない', async () => {
    mockedQueryRaw.mockRejectedValueOnce(
      new Error('connection refused at postgresql://secret:pass@host/db'),
    );
    const res = await GET();
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('pass');
    expect(serialized).not.toContain('postgresql://');
    expect(serialized).not.toMatch(/at\s+.+:\d+:\d+/); // stack trace 形式
  });
});
