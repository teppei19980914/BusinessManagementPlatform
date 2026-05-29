/**
 * gantt-client.tsx の source-pattern 回帰テスト。
 *
 * 担保対象 (feat/gantt-initial-scroll-and-locale 2026-05-29):
 *   - Props で today / tenantTimeZone / tenantLocale を受け取る (client で new Date を呼ばない)
 *   - useMemo today (旧来の UTC ベース) は撤去されている
 *   - minDate 計算で today を必ず含める (今日が表示レンジ外に出ない保証)
 *   - useEffect で初期 scrollLeft を today 列に揃える (mount 時の今日左端表示)
 *   - 月ヘッダは Intl.DateTimeFormat (tenantLocale + tenantTimeZone) で生成
 *   - i18n key 'monthHeader' は使用していない (messages からも削除済)
 *   - dayHeaders 生成は addDaysISO / dayOfWeekISO で TZ 非依存
 *
 * 設計根拠: docs/specification/SPECIFICATION.md (ガントチャート画面)
 * 関連: src/lib/tenant-time.ts (getTenantTodayString)、src/lib/format.ts (formatDateOnly)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT_FILE = join(__dirname, 'gantt-client.tsx');
const source = readFileSync(CLIENT_FILE, 'utf8');

describe('GanttClient Props で tenant TZ/locale/today を受け取る (server-driven)', () => {
  it('Props 型に today / tenantTimeZone / tenantLocale が宣言されている', () => {
    expect(source).toMatch(/today:\s*string/);
    expect(source).toMatch(/tenantTimeZone:\s*string/);
    expect(source).toMatch(/tenantLocale:\s*string/);
  });

  it('コンポーネント関数の destructure で today / tenantTimeZone / tenantLocale を取り出している', () => {
    expect(source).toMatch(/export function GanttClient\(\{[\s\S]{0,300}today,[\s\S]{0,200}tenantTimeZone,[\s\S]{0,200}tenantLocale,/);
  });

  it('client 側で new Date().toISOString().split(\'T\')[0] を呼んでいない (TZ ズレ撲滅)', () => {
    expect(source).not.toMatch(/new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/);
  });

  it('useMemo で today を再計算するパターンは削除されている', () => {
    expect(source).not.toMatch(/const\s+today\s*=\s*useMemo\(/);
  });
});

describe('minDate 計算で today を必ず表示レンジに含める', () => {
  it('allDates 配列の初期値に today を含めている (タスクが今日より過去/未来のみのケースで today を取り逃さない)', () => {
    expect(source).toMatch(/const allDates:\s*string\[\]\s*=\s*\[today\]/);
  });
});

describe('初期スクロール (今日を左端に揃える)', () => {
  it('useEffect と useRef がインポートされている', () => {
    expect(source).toMatch(/import\s*\{[\s\S]*?useEffect[\s\S]*?\}\s*from\s*['"]react['"]/);
    expect(source).toMatch(/import\s*\{[\s\S]*?useRef[\s\S]*?\}\s*from\s*['"]react['"]/);
  });

  it('scrollContainerRef を useRef で保持している', () => {
    expect(source).toMatch(/const\s+scrollContainerRef\s*=\s*useRef</);
  });

  it('useEffect で scrollLeft を dayOffset(minDate, today) * DAY_WIDTH に設定している', () => {
    expect(source).toMatch(/useEffect\([\s\S]{0,500}scrollLeft\s*=\s*todayOffset\s*\*\s*DAY_WIDTH/);
  });

  it('scroll container の div に ref={scrollContainerRef} が渡されている', () => {
    expect(source).toMatch(/ref=\{scrollContainerRef\}[\s\S]{0,200}className=["'][^"']*overflow-auto/);
  });

  it('useEffect の依存配列は [projectId, today] (filter 変更で再スクロールしない)', () => {
    expect(source).toMatch(/\}, \[projectId, today\]\);/);
  });
});

describe('月ヘッダの locale 化 (Intl.DateTimeFormat 直接生成)', () => {
  it('monthHeaderFormatter を Intl.DateTimeFormat(tenantLocale, { timeZone: tenantTimeZone, year: "numeric", month: "long" }) で構築', () => {
    expect(source).toMatch(/new Intl\.DateTimeFormat\(tenantLocale,[\s\S]{0,200}timeZone:\s*tenantTimeZone[\s\S]{0,200}month:\s*['"]long['"]/);
  });

  it('月ヘッダ生成で monthHeaderFormatter.format(...) を使う', () => {
    expect(source).toMatch(/monthHeaderFormatter\.format\(/);
  });

  it("旧 i18n key 't('monthHeader', ...)' は撤去されている", () => {
    expect(source).not.toMatch(/t\(['"]monthHeader['"]/);
  });
});

describe('dayHeaders 生成は TZ 非依存ヘルパで構築', () => {
  it('addDaysISO で 日付文字列を増分し、dayOfWeekISO で曜日を取得', () => {
    expect(source).toMatch(/addDaysISO\(minDate,\s*i\)/);
    expect(source).toMatch(/dayOfWeekISO\(/);
  });

  it('旧 formatDate(d) (= d.toISOString().split("T")[0]) は撤去されている', () => {
    // ヘルパ関数定義自体も削除済
    expect(source).not.toMatch(/function\s+formatDate\(date:\s*Date\)/);
  });
});

describe('i18n messages からの monthHeader キー削除との整合', () => {
  it('messages/{ja,en-US}.json から monthHeader を削除 (回帰チェック)', () => {
    const ja = readFileSync(join(__dirname, '../../../../../i18n/messages/ja.json'), 'utf8');
    const en = readFileSync(join(__dirname, '../../../../../i18n/messages/en-US.json'), 'utf8');
    expect(ja).not.toMatch(/"monthHeader"\s*:/);
    expect(en).not.toMatch(/"monthHeader"\s*:/);
  });
});
