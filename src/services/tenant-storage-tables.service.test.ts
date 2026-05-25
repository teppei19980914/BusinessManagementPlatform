/**
 * tenant-storage-tables.service.ts の単体テスト
 *
 * 観点:
 *   - JOIN_BASED_TABLES が schema 設計と整合 (alias 衝突なし、table 名重複なし)
 *   - SQL injection 防止 (validTablePattern allowlist)
 *   - 動的計測の sql 生成が正しい構造
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => {
  return {
    prisma: {
      $queryRaw: vi.fn(),
      $queryRawUnsafe: vi.fn(),
    },
  };
});

import {
  JOIN_BASED_TABLES,
  JOIN_BASED_TABLE_NAMES,
  getDirectTenantScopedTables,
  getAllTenantScopedTables,
  calculateTenantStorageBytesDynamic,
  getDbInstanceSizeBytes,
} from './tenant-storage-tables.service';
import { prisma } from '@/lib/db';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

describe('JOIN_BASED_TABLES — 静的整合性', () => {
  it('alias がすべてユニーク (UNION SQL 内の衝突防止)', () => {
    const aliases = JOIN_BASED_TABLES.map((j) => j.alias);
    const uniq = new Set(aliases);
    expect(aliases.length).toBe(uniq.size);
  });

  it('tableName がすべてユニーク', () => {
    const names = JOIN_BASED_TABLES.map((j) => j.tableName);
    const uniq = new Set(names);
    expect(names.length).toBe(uniq.size);
  });

  it('JOIN_BASED_TABLE_NAMES がエントリの tableName と一致', () => {
    expect(JOIN_BASED_TABLE_NAMES).toEqual(JOIN_BASED_TABLES.map((j) => j.tableName));
  });

  it('期待する JOIN ベースのテーブルが網羅されている (schema 整合性 sentinel)', () => {
    // schema.prisma の JOIN ベース業務テーブル (tenant_id を持たないが親 model に紐づく)。
    // 新規 JOIN ベース model 追加時は本配列とサービスを両方更新する想定。
    const expected = [
      'tasks',
      'task_progress_logs',
      'estimates',
      'project_members',
      'knowledge_projects',
      'task_knowledges',
      'risk_issue_projects',
      'retrospective_projects',
    ];
    expect(JOIN_BASED_TABLE_NAMES.slice().sort()).toEqual(expected.slice().sort());
  });

  it('joinClause が tenantIdSource alias を含む', () => {
    for (const j of JOIN_BASED_TABLES) {
      expect(j.joinClause).toContain(j.tenantIdSource);
    }
  });
});

describe('getDirectTenantScopedTables', () => {
  beforeEach(() => {
    vi.mocked(prisma.$queryRaw).mockReset();
  });

  it('information_schema から tenant_id 持ちテーブルを返す', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { table_name: 'tenants' },
      { table_name: 'users' },
      { table_name: 'projects' },
    ]);

    const result = await getDirectTenantScopedTables();
    expect(result).toEqual(['tenants', 'users', 'projects']);
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
  });

  it('空結果でも空配列を返す', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
    const result = await getDirectTenantScopedTables();
    expect(result).toEqual([]);
  });
});

describe('getAllTenantScopedTables — direct + JOIN 統合', () => {
  beforeEach(() => {
    vi.mocked(prisma.$queryRaw).mockReset();
  });

  it('direct + JOIN_BASED を union して sort + unique', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { table_name: 'tenants' },
      { table_name: 'projects' },
      { table_name: 'users' },
    ]);

    const result = await getAllTenantScopedTables();
    // direct (tenants, projects, users) + JOIN (tasks, estimates, ...) を sort
    expect(result).toContain('tenants');
    expect(result).toContain('projects');
    expect(result).toContain('users');
    expect(result).toContain('tasks');
    expect(result).toContain('estimates');
    expect(result).toContain('knowledge_projects');
    // sort されている
    const sorted = result.slice().sort();
    expect(result).toEqual(sorted);
    // unique
    const uniq = new Set(result);
    expect(uniq.size).toBe(result.length);
  });

  it('direct と JOIN_BASED の名前重複は 1 件に集約', async () => {
    // 通常 direct に JOIN_BASED と同じ名前は来ないが、防御テスト
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { table_name: 'tasks' }, // JOIN_BASED にもある名前 (異常パターン)
    ]);

    const result = await getAllTenantScopedTables();
    // tasks が 1 件のみ
    expect(result.filter((t) => t === 'tasks').length).toBe(1);
  });
});

describe('calculateTenantStorageBytesDynamic', () => {
  beforeEach(() => {
    vi.mocked(prisma.$queryRaw).mockReset();
    vi.mocked(prisma.$queryRawUnsafe).mockReset();
  });

  it('SQL injection 防止 — 不正な table 名で throw', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { table_name: 'tenants; DROP TABLE users; --' },
    ]);

    await expect(calculateTenantStorageBytesDynamic(TENANT_ID)).rejects.toThrow(
      /unsafe table name/,
    );
  });

  it('SQL injection 防止 — 大文字混入で throw (snake_case のみ許容)', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ table_name: 'Tenants' }]);

    await expect(calculateTenantStorageBytesDynamic(TENANT_ID)).rejects.toThrow(
      /unsafe table name/,
    );
  });

  it('合計バイト数を返す', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { table_name: 'tenants' },
      { table_name: 'projects' },
    ]);
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([{ total_bytes: BigInt(123_456_789) }]);

    const result = await calculateTenantStorageBytesDynamic(TENANT_ID);
    expect(result).toBe(BigInt(123_456_789));
  });

  it('空結果で 0n を返す (defensive)', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ table_name: 'tenants' }]);
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([]);

    const result = await calculateTenantStorageBytesDynamic(TENANT_ID);
    expect(result).toBe(BigInt(0));
  });

  it('生成 SQL に JOIN_BASED と direct の両方が含まれる', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ table_name: 'tenants' }]);
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([{ total_bytes: BigInt(0) }]);

    await calculateTenantStorageBytesDynamic(TENANT_ID);
    const calledSql = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0]?.[0] as string;
    expect(calledSql).toContain('"tenants"'); // direct
    expect(calledSql).toContain('"tasks"'); // JOIN_BASED
    expect(calledSql).toContain('"knowledge_projects"'); // JOIN_BASED
    expect(calledSql).toContain('p.tenant_id'); // JOIN-based の tenant 参照
  });

  it('生成 SQL にテーブル名を二重引用符でクオート (予約語衝突防止)', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ table_name: 'users' }]);
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([{ total_bytes: BigInt(0) }]);

    await calculateTenantStorageBytesDynamic(TENANT_ID);
    const sql = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0]?.[0] as string;
    expect(sql).toContain('"users"');
  });
});

describe('getDbInstanceSizeBytes — drift 検知用', () => {
  beforeEach(() => {
    vi.mocked(prisma.$queryRaw).mockReset();
  });

  it('pg_database_size を返す', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ db_size: BigInt(987_654_321) }]);
    const result = await getDbInstanceSizeBytes();
    expect(result).toBe(BigInt(987_654_321));
  });

  it('空結果で 0n を返す', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
    const result = await getDbInstanceSizeBytes();
    expect(result).toBe(BigInt(0));
  });
});
