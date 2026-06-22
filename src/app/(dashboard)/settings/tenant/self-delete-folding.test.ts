/**
 * self-delete-folding.test.ts (feat/tenant-settings-tabs / 2026-05-22)
 *
 * 検証観点:
 *   テナント解約セクション (SelfDeleteTenantSection) はユーザ確定方針 (= 概要タブ末尾の折りたたみ)
 *   に従い、必ず `<details>` でラップされていること。
 *
 * Why: 元実装は `<section>` でデフォルト展開していたため、誤クリック / 視覚的圧迫の懸念があった。
 *   `<details>` 折りたたみへの移行は UX 上の意図的設計 (= 「危険な操作」を一段隠す) であり、
 *   将来 markup を `<section>` に戻すリファクタが入った場合に検知できるようソースに対する
 *   静的 assertion を残す。React component 単体テストは TenantSettingsClient の全依存
 *   (next-intl / next/navigation / RecalculateButton 等) を mock する必要があるため重く、
 *   本契約は source string 検査で十分カバーできる。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CLIENT_SOURCE = readFileSync(
  resolve(__dirname, 'tenant-settings-client.tsx'),
  'utf-8',
);
const JA_CATALOG = readFileSync(
  resolve(__dirname, '../../../../i18n/messages/ja.json'),
  'utf-8',
);

describe('SelfDeleteTenantSection markup contract', () => {
  it('<details> でラップされている (= ユーザ確定方針: 概要内のまま折りたたみ)', () => {
    // function 本体の先頭から終端までを切り出す
    const functionStart = CLIENT_SOURCE.indexOf('function SelfDeleteTenantSection');
    expect(functionStart).toBeGreaterThan(-1);
    // 次の top-level `function` または `// ===` セクション区切りまでを対象範囲とする
    const afterFunction = CLIENT_SOURCE.slice(functionStart);
    const nextSectionMarker = afterFunction.search(/\n(function |\/\/ ={5,})/);
    const functionBody =
      nextSectionMarker > 0 ? afterFunction.slice(0, nextSectionMarker) : afterFunction;

    // 必須要件: <details> でラップ、識別用 data-testid 付与
    expect(functionBody).toMatch(/<details[\s\S]+data-testid="self-delete-tenant-section"/);
    // <summary> に解約見出しが含まれる (i18n 化後はリテラルがカタログへ移動)
    expect(functionBody).toMatch(/<summary/);
    expect(JA_CATALOG).toContain('テナント解約');
    // form / button 自体は維持されている (= 機能退行防止)
    expect(functionBody).toContain('handleSubmit');
    expect(JA_CATALOG).toContain('🗑 テナントを解約する');
  });

  it('default で open 属性が付いていない (= 初期状態は閉じている)', () => {
    const functionStart = CLIENT_SOURCE.indexOf('function SelfDeleteTenantSection');
    const afterFunction = CLIENT_SOURCE.slice(functionStart);
    const nextSectionMarker = afterFunction.search(/\n(function |\/\/ ={5,})/);
    const functionBody =
      nextSectionMarker > 0 ? afterFunction.slice(0, nextSectionMarker) : afterFunction;

    // <details ... open> のような JSX 属性が無いことを確認 (defaultOpen 等も同様)
    const detailsOpenMatch = functionBody.match(/<details[^>]*\sopen[\s=>]/);
    expect(detailsOpenMatch).toBeNull();
    const defaultOpenMatch = functionBody.match(/<details[^>]*defaultOpen/);
    expect(defaultOpenMatch).toBeNull();
  });
});
