/**
 * gantt 関連ページの server-side props 伝搬 invariant テスト。
 *
 * 担保対象 (feat/gantt-initial-scroll-and-locale 2026-05-29):
 *   - すべての GanttClient 呼び出し元で today / tenantTimeZone / tenantLocale を渡している
 *   - すべての RetrospectivesClient 呼び出し元で today を渡している
 *   - server 側 (page.tsx) で getTenantTodayString を session.user.timezone ベースで使う
 *
 * 設計意図:
 *   GanttClient は 3 箇所で利用される (gantt/page.tsx、project-detail-client.tsx、my-tasks-client.tsx)。
 *   後続 PR でいずれかの呼び出し元が新規追加された際、props 漏れを CI で検知する。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../../..');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('gantt/page.tsx (server) - tenant TZ/locale/today 伝搬', () => {
  const source = read('app/(dashboard)/projects/[projectId]/gantt/page.tsx');

  it('getTenantTodayString を tenant-time から import', () => {
    expect(source).toMatch(/import\s*\{\s*getTenantTodayString\s*\}\s*from\s*['"]@\/lib\/tenant-time['"]/);
  });

  it('resolveTimezone / resolveLocale を config/i18n から import', () => {
    expect(source).toMatch(/resolveTimezone[\s\S]{0,50}resolveLocale[\s\S]{0,80}from\s*['"]@\/config\/i18n['"]/);
  });

  it('GanttClient に today / tenantTimeZone / tenantLocale を渡している', () => {
    expect(source).toMatch(/<GanttClient[\s\S]{0,500}today=\{today\}[\s\S]{0,300}tenantTimeZone=\{tenantTimeZone\}[\s\S]{0,200}tenantLocale=\{tenantLocale\}/);
  });
});

describe('my-tasks/page.tsx (server) - tenant TZ/locale/today 伝搬', () => {
  const source = read('app/(dashboard)/my-tasks/page.tsx');

  it('UTC today (new Date().toISOString().split("T")[0]) は撤去済', () => {
    expect(source).not.toMatch(/new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/);
  });

  it('getTenantTodayString で tenant TZ ベースに算出', () => {
    expect(source).toMatch(/getTenantTodayString\(new Date\(\),\s*tenantTimeZone\)/);
  });

  it('MyTasksClient に tenantTimeZone / tenantLocale を渡している', () => {
    expect(source).toMatch(/<MyTasksClient[\s\S]{0,500}tenantTimeZone=\{tenantTimeZone\}[\s\S]{0,200}tenantLocale=\{tenantLocale\}/);
  });
});

describe('my-tasks-client.tsx - GanttClient へ props forward', () => {
  const source = read('app/(dashboard)/my-tasks/my-tasks-client.tsx');

  it('GanttClient 呼び出しで today / tenantTimeZone / tenantLocale を渡している', () => {
    expect(source).toMatch(/<GanttClient[\s\S]{0,500}today=\{today\}[\s\S]{0,300}tenantTimeZone=\{tenantTimeZone\}[\s\S]{0,200}tenantLocale=\{tenantLocale\}/);
  });
});

describe('project-detail page.tsx (server) - tenant TZ/locale/today 伝搬', () => {
  const source = read('app/(dashboard)/projects/[projectId]/page.tsx');

  it('getTenantTodayString と resolveTimezone/resolveLocale を import', () => {
    expect(source).toMatch(/getTenantTodayString/);
    expect(source).toMatch(/resolveTimezone/);
    expect(source).toMatch(/resolveLocale/);
  });

  it('ProjectDetailClient に today / tenantTimeZone / tenantLocale を渡している', () => {
    expect(source).toMatch(/<ProjectDetailClient[\s\S]{0,2000}today=\{today\}[\s\S]{0,500}tenantTimeZone=\{tenantTimeZone\}[\s\S]{0,300}tenantLocale=\{tenantLocale\}/);
  });
});

describe('project-detail-client.tsx - 内部 lazy tab で GanttClient と RetrospectivesClient に伝搬', () => {
  const source = read('app/(dashboard)/projects/[projectId]/project-detail-client.tsx');

  it('GanttClient に today / tenantTimeZone / tenantLocale を渡している', () => {
    expect(source).toMatch(/<GanttClient[\s\S]{0,500}today=\{today\}[\s\S]{0,300}tenantTimeZone=\{tenantTimeZone\}[\s\S]{0,200}tenantLocale=\{tenantLocale\}/);
  });

  it('RetrospectivesClient に today を渡している', () => {
    expect(source).toMatch(/<RetrospectivesClient[\s\S]{0,500}today=\{today\}/);
  });
});

describe('retrospectives/page.tsx (server) - today 伝搬', () => {
  const source = read('app/(dashboard)/projects/[projectId]/retrospectives/page.tsx');

  it('getTenantTodayString を import + RetrospectivesClient に today を渡している', () => {
    expect(source).toMatch(/getTenantTodayString/);
    expect(source).toMatch(/<RetrospectivesClient[\s\S]{0,500}today=\{today\}/);
  });
});

describe('retrospectives-client.tsx - UTC today 撤去 + conductedDate ロケール表示', () => {
  const source = read('app/(dashboard)/projects/[projectId]/retrospectives/retrospectives-client.tsx');

  it('UTC today (new Date().toISOString().split) は撤去済', () => {
    expect(source).not.toMatch(/new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/);
  });

  it('form 初期値 conductedDate は props.today から取得', () => {
    expect(source).toMatch(/conductedDate:\s*today/);
  });

  it('TableCell に formatDateOnly(retro.conductedDate) で表示', () => {
    expect(source).toMatch(/formatDateOnly\(retro\.conductedDate\)/);
  });
});

describe('cross-list / detail 画面 - date-only 表示は formatDateOnly を経由', () => {
  it('customer-detail-client.tsx の plannedStartDate/EndDate が formatDateOnly 経由', () => {
    const source = read('app/(dashboard)/customers/[customerId]/customer-detail-client.tsx');
    expect(source).toMatch(/formatDateOnly\(p\.plannedStartDate\)/);
    expect(source).toMatch(/formatDateOnly\(p\.plannedEndDate\)/);
  });

  it('all-retrospectives-table.tsx の conductedDate が formatDateOnly 経由', () => {
    const source = read('app/(dashboard)/retrospectives/all-retrospectives-table.tsx');
    // 2 箇所: TableCell + label prop
    const matches = source.match(/formatDateOnly\(r\.conductedDate\)/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('project-detail-client.tsx の plannedStartDate/EndDate が formatDateOnly 経由', () => {
    const source = read('app/(dashboard)/projects/[projectId]/project-detail-client.tsx');
    expect(source).toMatch(/formatDateOnly\(project\.plannedStartDate\)/);
    expect(source).toMatch(/formatDateOnly\(project\.plannedEndDate\)/);
  });

  it('projects-client.tsx の plannedStartDate/EndDate が formatDateOnly 経由', () => {
    const source = read('app/(dashboard)/projects/projects-client.tsx');
    expect(source).toMatch(/formatDateOnly\(project\.plannedStartDate\)/);
    expect(source).toMatch(/formatDateOnly\(project\.plannedEndDate\)/);
  });
});

describe('WBS / Gantt 同期: 日付表示形式の一貫性 invariant (2 巡目フルスキャンで追加)', () => {
  it('tasks-client.tsx (WBS) の plannedRangeText / actualRangeText は formatDateOnly 経由 (生 YYYY-MM-DD 残留禁止)', () => {
    const source = read('app/(dashboard)/projects/[projectId]/tasks/tasks-client.tsx');
    // PC table と mobile card の 2 component で同 pattern → 4 回マッチを期待
    const plannedMatches = source.match(/formatDateOnly\(task\.plannedStartDate\s*\?\?\s*''\)/g);
    const actualMatches = source.match(/formatDateOnly\(task\.actualStartDate\s*\?\?\s*''\)/g);
    expect(plannedMatches?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(actualMatches?.length ?? 0).toBeGreaterThanOrEqual(2);
    // 生表示 (旧パターン) が残っていないこと
    expect(source).not.toMatch(/\$\{task\.plannedStartDate\s*\|\|\s*unsetLabel\}/);
    expect(source).not.toMatch(/\$\{task\.actualStartDate\s*\|\|\s*unsetLabel\}/);
  });

  it('my-tasks-client.tsx (担当タスク表) の plannedRangeText / actualRangeText も formatDateOnly 経由', () => {
    const source = read('app/(dashboard)/my-tasks/my-tasks-client.tsx');
    expect(source).toMatch(/formatDateOnly\(task\.plannedStartDate\s*\?\?\s*''\)/);
    expect(source).toMatch(/formatDateOnly\(task\.actualStartDate\s*\?\?\s*''\)/);
    expect(source).not.toMatch(/\$\{task\.plannedStartDate\s*\|\|\s*unsetLabel\}/);
  });

  it('gantt-client.tsx の tooltip rangeText 呼び出しが formatDateOnly を渡している (WBS と表示形式統一)', () => {
    const source = read('app/(dashboard)/projects/[projectId]/gantt/gantt-client.tsx');
    // tooltipPlanned / tooltipActual の 2 箇所で formatDateOnly を渡す
    const matches = source.match(/rangeText\([^)]*formatDateOnly\)/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
    // rangeText 関数自体が format パラメータを受け取る型に変更されている
    expect(source).toMatch(/function rangeText\([\s\S]{0,300}format:\s*\(ymd:\s*string\)\s*=>\s*string/);
  });
});
