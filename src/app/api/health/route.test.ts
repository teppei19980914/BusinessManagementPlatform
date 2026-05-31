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
    // perf/comprehensive-perf-2026-06-01 (D-1):
    //   warmup として 6 テーブルへ追加 $queryRaw を発火するため、デフォルトでも resolve するように
    //   セットしておく。各 it 内では mockResolvedValueOnce / mockRejectedValueOnce で 1 回目 (= 主 SELECT 1)
    //   のみ振る舞いを上書きする。
    mockedQueryRaw.mockResolvedValue([]);
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

  // perf/comprehensive-perf-2026-06-01 (D-1): warmup の振る舞い検証
  it('DB ok 時は warmup として常用テーブル (tenants/users/projects/risks_issues/retrospectives/knowledges) を追加で 6 回叩く', async () => {
    mockedQueryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
    await GET();
    // SELECT 1 (主) + 6 テーブル warmup = 計 7 回
    expect(mockedQueryRaw).toHaveBeenCalledTimes(7);
  });

  it('DB error 時は warmup を実行しない (副作用なしを担保)', async () => {
    mockedQueryRaw.mockRejectedValueOnce(new Error('down'));
    await GET();
    // 主 SELECT 1 のみ。warmup は dbStatus !== 'ok' の場合スキップ。
    expect(mockedQueryRaw).toHaveBeenCalledTimes(1);
  });
});
