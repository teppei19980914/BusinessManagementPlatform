import { describe, it, expect } from 'vitest';
import { buildBatchFromCsv, type CsvEntitySource } from './csv-to-batch';
import { getImportFieldMaxLength } from './import-field-catalog';

/** 指定エンティティ・1 行のソースを作る簡易ヘルパ。 */
function src(entity: CsvEntitySource['entity'], row: Record<string, string>): CsvEntitySource {
  const columnMap: Record<string, string> = {};
  for (const k of Object.keys(row)) columnMap[k] = k;
  return { entity, rows: [row], columnMap };
}

describe('DB カラム長検証 (サイレント切り捨て禁止)', () => {
  it('顧客名が 100 文字超でエラー', () => {
    const long = 'あ'.repeat(101);
    const batch = buildBatchFromCsv([src('customer', { name: long })]);
    const err = batch.valueErrors.find((e) => e.entity === 'customer' && e.field === 'name');
    expect(err).toBeTruthy();
    expect(err!.reason).toContain('最大 100 文字');
    expect(err!.reason).toContain('101 文字');
  });

  it('ちょうど 100 文字は許容 (境界)', () => {
    const exact = 'a'.repeat(100);
    const batch = buildBatchFromCsv([src('customer', { name: exact })]);
    expect(batch.valueErrors.filter((e) => e.field === 'name')).toEqual([]);
  });

  it('ナレッジのタイトルは 150 文字上限', () => {
    expect(getImportFieldMaxLength('knowledge', 'title')).toBe(150);
    const batch = buildBatchFromCsv([src('knowledge', { title: 'k'.repeat(151) })]);
    expect(batch.valueErrors.some((e) => e.entity === 'knowledge' && e.field === 'title')).toBe(true);
  });

  it('リスク件名は 100 文字上限', () => {
    const batch = buildBatchFromCsv([src('risk', { title: 'r'.repeat(101) })]);
    expect(batch.valueErrors.some((e) => e.entity === 'risk' && e.field === 'title')).toBe(true);
  });

  it('contactEmail は 255 まで許容、超過でエラー', () => {
    const ok = buildBatchFromCsv([src('customer', { name: 'A', contactEmail: 'x'.repeat(255) })]);
    expect(ok.valueErrors.filter((e) => e.field === 'contactEmail')).toEqual([]);
    const ng = buildBatchFromCsv([src('customer', { name: 'A', contactEmail: 'x'.repeat(256) })]);
    expect(ng.valueErrors.some((e) => e.field === 'contactEmail')).toBe(true);
  });

  it('Text 列 (備考/本文) は無制限 (上限なし)', () => {
    expect(getImportFieldMaxLength('customer', 'notes')).toBeUndefined();
    const batch = buildBatchFromCsv([src('customer', { name: 'A', notes: 'n'.repeat(5000) })]);
    expect(batch.valueErrors).toEqual([]);
  });

  it('WBS 名称は 100 文字上限', () => {
    const batch = buildBatchFromCsv([src('wbs', { projectName: 'PJ', level: '1', name: 'w'.repeat(101) })]);
    expect(batch.valueErrors.some((e) => e.entity === 'wbs' && e.field === 'name')).toBe(true);
  });
});
