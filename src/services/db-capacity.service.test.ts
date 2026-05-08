/**
 * DB 容量モニタサービスの単体テスト (P-5a / 2026-05-08)
 *
 * 検証項目:
 *   - getDatabaseSize: pg_database_size の戻り値を Number で返す
 *   - getTopTablesBySize: limit 範囲外を 1〜100 に正規化、bigint→number 変換
 *   - getDatabaseCapacityReport: status 分類 (ok / warn / alert)
 *   - env 上限の上書き (DB_CAPACITY_LIMIT_BYTES)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

import {
  getDatabaseCapacityReport,
  getDatabaseSize,
  getTopTablesBySize,
} from './db-capacity.service';
import { prisma } from '@/lib/db';
import {
  classifyDbCapacityStatus,
  DB_CAPACITY_DEFAULT_LIMIT_BYTES,
  DB_CAPACITY_WARN_THRESHOLD,
  DB_CAPACITY_ALERT_THRESHOLD,
  getDbCapacityLimitBytes,
} from '@/config/db-capacity';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.DB_CAPACITY_LIMIT_BYTES;
});

describe('classifyDbCapacityStatus', () => {
  it('80% 未満は ok', () => {
    expect(classifyDbCapacityStatus(100 * 1024 * 1024, 500 * 1024 * 1024)).toBe('ok'); // 20%
    expect(classifyDbCapacityStatus(399 * 1024 * 1024, 500 * 1024 * 1024)).toBe('ok'); // 79.8%
  });

  it('80%〜90% 未満は warn', () => {
    expect(classifyDbCapacityStatus(400 * 1024 * 1024, 500 * 1024 * 1024)).toBe('warn'); // 80%
    expect(classifyDbCapacityStatus(449 * 1024 * 1024, 500 * 1024 * 1024)).toBe('warn'); // 89.8%
  });

  it('90% 以上は alert', () => {
    expect(classifyDbCapacityStatus(450 * 1024 * 1024, 500 * 1024 * 1024)).toBe('alert'); // 90%
    expect(classifyDbCapacityStatus(500 * 1024 * 1024, 500 * 1024 * 1024)).toBe('alert'); // 100%
    expect(classifyDbCapacityStatus(600 * 1024 * 1024, 500 * 1024 * 1024)).toBe('alert'); // 上限超過
  });

  it('limitBytes が 0 以下なら ok (defensive)', () => {
    expect(classifyDbCapacityStatus(100, 0)).toBe('ok');
    expect(classifyDbCapacityStatus(100, -1)).toBe('ok');
  });

  it('閾値の整合性: warn=0.8, alert=0.9', () => {
    expect(DB_CAPACITY_WARN_THRESHOLD).toBe(0.8);
    expect(DB_CAPACITY_ALERT_THRESHOLD).toBe(0.9);
  });
});

describe('getDbCapacityLimitBytes', () => {
  afterEach(() => {
    delete process.env.DB_CAPACITY_LIMIT_BYTES;
  });

  it('env 未設定なら Free プラン (500MB) のデフォルトを返す', () => {
    expect(getDbCapacityLimitBytes()).toBe(500 * 1024 * 1024);
    expect(getDbCapacityLimitBytes()).toBe(DB_CAPACITY_DEFAULT_LIMIT_BYTES);
  });

  it('env で Pro プラン (8GB) を指定したら 8GB', () => {
    process.env.DB_CAPACITY_LIMIT_BYTES = String(8 * 1024 * 1024 * 1024);
    expect(getDbCapacityLimitBytes()).toBe(8 * 1024 * 1024 * 1024);
  });

  it('env が不正値ならデフォルトに fallback', () => {
    process.env.DB_CAPACITY_LIMIT_BYTES = 'not-a-number';
    expect(getDbCapacityLimitBytes()).toBe(DB_CAPACITY_DEFAULT_LIMIT_BYTES);

    process.env.DB_CAPACITY_LIMIT_BYTES = '0';
    expect(getDbCapacityLimitBytes()).toBe(DB_CAPACITY_DEFAULT_LIMIT_BYTES);

    process.env.DB_CAPACITY_LIMIT_BYTES = '-100';
    expect(getDbCapacityLimitBytes()).toBe(DB_CAPACITY_DEFAULT_LIMIT_BYTES);

    process.env.DB_CAPACITY_LIMIT_BYTES = '';
    expect(getDbCapacityLimitBytes()).toBe(DB_CAPACITY_DEFAULT_LIMIT_BYTES);
  });
});

describe('getDatabaseSize', () => {
  it('pg_database_size の bigint 戻り値を Number に変換', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { size: BigInt(123456789) },
    ] as never);

    const size = await getDatabaseSize();
    expect(size).toBe(123456789);
    expect(typeof size).toBe('number');
  });

  it('レコードなしなら 0', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([] as never);

    expect(await getDatabaseSize()).toBe(0);
  });
});

describe('getTopTablesBySize', () => {
  it('テーブル別 bigint を number に変換し、配列で返す', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { table_name: 'projects', total_bytes: BigInt(5000000) },
      { table_name: 'knowledges', total_bytes: BigInt(3000000) },
      { table_name: 'risks_issues', total_bytes: BigInt(1500000) },
    ] as never);

    const rows = await getTopTablesBySize(10);
    expect(rows).toEqual([
      { tableName: 'projects', totalBytes: 5000000 },
      { tableName: 'knowledges', totalBytes: 3000000 },
      { tableName: 'risks_issues', totalBytes: 1500000 },
    ]);
  });

  it('limit が 0 や負数なら 1 件にクランプ', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);

    await getTopTablesBySize(0);
    await getTopTablesBySize(-5);
    // クランプされて 1 になり、SQL 内の LIMIT もそれを反映する想定
    // (※ 実 SQL の検証は integration test 側で行う; ここは関数が落ちないことの確認)
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('limit が大きすぎたら 100 件にクランプ', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);

    await getTopTablesBySize(10000);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('getDatabaseCapacityReport', () => {
  it('全データソースを集約して DbCapacityReport を返す (ok ステータス)', async () => {
    vi.mocked(prisma.$queryRaw)
      // 1 回目: getDatabaseSize
      .mockResolvedValueOnce([{ size: BigInt(100 * 1024 * 1024) }] as never)
      // 2 回目: getTopTablesBySize
      .mockResolvedValueOnce([
        { table_name: 'projects', total_bytes: BigInt(50000000) },
      ] as never);

    const report = await getDatabaseCapacityReport();
    expect(report.usedBytes).toBe(100 * 1024 * 1024);
    expect(report.limitBytes).toBe(500 * 1024 * 1024);
    expect(report.utilizationRatio).toBeCloseTo(0.2);
    expect(report.status).toBe('ok');
    expect(report.topTables).toHaveLength(1);
    expect(report.measuredAt).toBeInstanceOf(Date);
  });

  it('warn ステータス: 使用率 80%〜90% 未満', async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([{ size: BigInt(420 * 1024 * 1024) }] as never)
      .mockResolvedValueOnce([] as never);

    const report = await getDatabaseCapacityReport();
    expect(report.status).toBe('warn');
    expect(report.utilizationRatio).toBeCloseTo(0.84);
  });

  it('alert ステータス: 使用率 90% 以上', async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([{ size: BigInt(480 * 1024 * 1024) }] as never)
      .mockResolvedValueOnce([] as never);

    const report = await getDatabaseCapacityReport();
    expect(report.status).toBe('alert');
    expect(report.utilizationRatio).toBeCloseTo(0.96);
  });

  it('env で上限を上書きすると ratio / status が変わる', async () => {
    process.env.DB_CAPACITY_LIMIT_BYTES = String(8 * 1024 * 1024 * 1024); // 8GB

    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([{ size: BigInt(100 * 1024 * 1024) }] as never) // 100MB
      .mockResolvedValueOnce([] as never);

    const report = await getDatabaseCapacityReport();
    expect(report.limitBytes).toBe(8 * 1024 * 1024 * 1024);
    // 100MB / 8GB ≒ 1.2% → ok
    expect(report.status).toBe('ok');
    expect(report.utilizationRatio).toBeLessThan(0.05);
  });
});
