import { describe, it, expect } from 'vitest';
import { convertToWbsRows, type SourceWbsNode } from './wbs-hierarchy';

describe('wbs-hierarchy (ADR-0034 階層 → 前順序+レベル)', () => {
  it('空入力は空結果', () => {
    expect(convertToWbsRows([])).toEqual({ rows: [], warnings: [] });
  });

  it('枝=WP / 葉=ACT を構造から判定し、前順序で並べる', () => {
    // A(root) ─ B(子) ─ C(孫) , A ─ D(子・葉)
    const nodes: SourceWbsNode[] = [
      { sourceId: 'C', parentSourceId: 'B', name: '孫C', plannedEffort: 3 },
      { sourceId: 'A', parentSourceId: null, name: '親A' },
      { sourceId: 'D', parentSourceId: 'A', name: '子D' },
      { sourceId: 'B', parentSourceId: 'A', name: '子B' },
    ];
    const { rows, warnings } = convertToWbsRows(nodes);
    expect(warnings).toEqual([]);
    // 前順序: A → (Aの子は入力順 D,B) → D, B → Bの子 C
    expect(rows.map((r) => [r.name, r.level, r.type])).toEqual([
      ['親A', 1, 'work_package'],
      ['子D', 2, 'activity'],
      ['子B', 2, 'work_package'],
      ['孫C', 3, 'activity'],
    ]);
  });

  it('ルート直下の葉は ACT (親が無くても可)', () => {
    const { rows } = convertToWbsRows([{ sourceId: 'X', parentSourceId: null, name: '単独作業' }]);
    expect(rows).toEqual([
      {
        level: 1,
        type: 'activity',
        name: '単独作業',
        plannedStartDate: null,
        plannedEndDate: null,
        plannedEffort: null,
        sourceId: 'X',
      },
    ]);
  });

  it('ACT の予定日/工数は保持、WP の予定日/工数は捨てて警告', () => {
    const nodes: SourceWbsNode[] = [
      { sourceId: 'P', parentSourceId: null, name: '箱P', plannedStartDate: '2026-06-01', plannedEffort: 10 },
      { sourceId: 'L', parentSourceId: 'P', name: '葉L', plannedStartDate: '2026-06-02', plannedEffort: 5 },
    ];
    const { rows, warnings } = convertToWbsRows(nodes);
    const p = rows.find((r) => r.name === '箱P')!;
    const l = rows.find((r) => r.name === '葉L')!;
    expect(p.type).toBe('work_package');
    expect(p.plannedStartDate).toBeNull();
    expect(p.plannedEffort).toBeNull();
    expect(l.type).toBe('activity');
    expect(l.plannedStartDate).toBe('2026-06-02');
    expect(l.plannedEffort).toBe(5);
    expect(warnings.some((w) => w.includes('箱P'))).toBe(true);
  });

  it('親が見つからないノードはルート扱い + 警告', () => {
    const nodes: SourceWbsNode[] = [
      { sourceId: 'orphan', parentSourceId: 'missing', name: '孤児' },
    ];
    const { rows, warnings } = convertToWbsRows(nodes);
    expect(rows.map((r) => [r.name, r.level])).toEqual([['孤児', 1]]);
    expect(warnings.some((w) => w.includes('見つかりません'))).toBe(true);
  });

  it('循環参照を検出して打ち切り、全ノードを救済する', () => {
    // A → B → A の循環 (どちらも null 親でない)
    const nodes: SourceWbsNode[] = [
      { sourceId: 'A', parentSourceId: 'B', name: 'A' },
      { sourceId: 'B', parentSourceId: 'A', name: 'B' },
    ];
    const { rows, warnings } = convertToWbsRows(nodes);
    // 2 ノードとも結果に現れる (重複なし)
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(['A', 'B']);
    expect(warnings.some((w) => w.includes('循環'))).toBe(true);
  });

  it('重複ソースIDは最初を採用 + 警告', () => {
    const nodes: SourceWbsNode[] = [
      { sourceId: 'A', parentSourceId: null, name: 'A1' },
      { sourceId: 'A', parentSourceId: null, name: 'A2' },
    ];
    const { rows, warnings } = convertToWbsRows(nodes);
    expect(rows.map((r) => r.name)).toEqual(['A1']);
    expect(warnings.some((w) => w.includes('重複'))).toBe(true);
  });
});
