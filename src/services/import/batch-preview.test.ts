import { describe, it, expect } from 'vitest';
import {
  buildImportPreview,
  checkLinkWarnings,
  normalizeName,
  type ExistingDataIndex,
} from './batch-preview';
import { emptyBatch, type NormalizedBatch } from './normalized-batch';
import type { WbsRow } from './wbs-hierarchy';

function existingIndex(opts: {
  customers?: [string, string][];
  projects?: [string, string][];
}): ExistingDataIndex {
  return {
    customers: new Map((opts.customers ?? []).map(([n, id]) => [normalizeName(n), id])),
    projects: new Map((opts.projects ?? []).map(([n, id]) => [normalizeName(n), id])),
  };
}

function wbsRow(name: string, sourceId: string): WbsRow {
  return {
    level: 1,
    type: 'activity',
    name,
    plannedStartDate: null,
    plannedEndDate: null,
    plannedEffort: null,
    sourceId,
  };
}

function baseBatch(): NormalizedBatch {
  const b = emptyBatch('csv');
  b.customers.push({ sourceKey: 'cust1', name: '株式会社サンプル' });
  b.projects.push({
    sourceKey: 'proj1',
    customerRef: 'cust1',
    name: '移行案件',
    purpose: '目的テキスト',
    background: '背景テキスト',
    scope: 'スコープテキスト',
    devMethod: 'スクラッチ開発',
    contractType: '準委任',
    status: '実行中',
    plannedStartDate: '2026-06-01',
    plannedEndDate: '2026-06-30',
    wbs: [],
    risks: [],
    knowledge: [],
    retros: [],
  });
  return b;
}

describe('buildImportPreview', () => {
  it('正常系: 選択値を内部値化し日付を正規化、エラーなし', () => {
    const pv = buildImportPreview(baseBatch());
    expect(pv.errors).toEqual([]);
    const p = pv.resolved.projects[0];
    expect(p.customerKey).toBe('cust1');
    expect(p.devMethod).toBe('scratch');
    expect(p.contractType).toBe('quasi_mandate');
    expect(p.status).toBe('executing');
    expect(p.plannedStartDate).toBe('2026-06-01');
    expect(p.plannedEndDate).toBe('2026-06-30');
    expect(pv.summary.customers).toBe(1);
    expect(pv.summary.projects).toBe(1);
  });

  it('顧客名が空ならエラー', () => {
    const b = baseBatch();
    b.customers[0].name = '   ';
    const pv = buildImportPreview(b);
    expect(pv.errors.some((e) => e.entity === 'customer' && e.field === 'name')).toBe(true);
  });

  it('顧客メールが不正な形式ならエラー (フォームと同じ検証)', () => {
    const b = baseBatch();
    b.customers[0].contactEmail = 'インポートテスト用';
    const pv = buildImportPreview(b);
    expect(pv.errors.some((e) => e.entity === 'customer' && e.field === 'contactEmail')).toBe(true);
  });

  it('顧客メールが正しい形式・空ならエラーなし', () => {
    const b1 = baseBatch();
    b1.customers[0].contactEmail = 'taro@example.com';
    expect(buildImportPreview(b1).errors).toEqual([]);
    const b2 = baseBatch();
    b2.customers[0].contactEmail = '';
    expect(buildImportPreview(b2).errors).toEqual([]);
  });

  it('顧客がバッチに無いプロジェクトはエラー (親なし=必須)', () => {
    const b = baseBatch();
    b.projects[0].customerRef = 'unknown';
    const pv = buildImportPreview(b);
    expect(pv.errors.some((e) => e.entity === 'project' && e.field === 'customerName')).toBe(true);
  });

  it('エラーに ファイル名・行番号・日本語列名 が付く', () => {
    const b = baseBatch();
    b.customers[0].contactEmail = 'ダメなメール';
    b.customers[0].origin = { file: '顧客-テンプレート.csv', row: 1 };
    const pv = buildImportPreview(b);
    const err = pv.errors.find((e) => e.entity === 'customer' && e.field === 'contactEmail')!;
    expect(err.file).toBe('顧客-テンプレート.csv');
    expect(err.row).toBe(1);
    expect(err.column).toBe('担当者メール');
  });

  it('開発方式が選択肢にない値ならエラー、空なら既定値 (other) でエラーなし', () => {
    const bad = baseBatch();
    bad.projects[0].devMethod = 'アジャイル開発'; // 選択肢にない
    const pvBad = buildImportPreview(bad);
    expect(pvBad.errors.some((e) => e.entity === 'project' && e.field === 'devMethod')).toBe(true);

    const empty = baseBatch();
    empty.projects[0].devMethod = '';
    const pvEmpty = buildImportPreview(empty);
    expect(pvEmpty.errors.some((e) => e.field === 'devMethod')).toBe(false);
    expect(pvEmpty.resolved.projects[0].devMethod).toBe('other');
  });

  it('契約形態が選択肢にない値ならエラー、空なら null でエラーなし', () => {
    const bad = baseBatch();
    bad.projects[0].contractType = '常駐';
    const pvBad = buildImportPreview(bad);
    expect(pvBad.errors.some((e) => e.entity === 'project' && e.field === 'contractType')).toBe(true);

    const empty = baseBatch();
    empty.projects[0].contractType = '';
    const pvEmpty = buildImportPreview(empty);
    expect(pvEmpty.errors.some((e) => e.field === 'contractType')).toBe(false);
    expect(pvEmpty.resolved.projects[0].contractType).toBeNull();
  });

  it('ステータスが選択肢にない値ならエラー、空なら既定値 (planning) でエラーなし', () => {
    const bad = baseBatch();
    bad.projects[0].status = 'インポートテスト用';
    const pvBad = buildImportPreview(bad);
    expect(pvBad.errors.some((e) => e.entity === 'project' && e.field === 'status')).toBe(true);

    const empty = baseBatch();
    empty.projects[0].status = '';
    const pvEmpty = buildImportPreview(empty);
    expect(pvEmpty.errors.some((e) => e.field === 'status')).toBe(false);
    expect(pvEmpty.resolved.projects[0].status).toBe('planning');
  });

  it('プロジェクトの必須テキスト/日付が空ならエラー', () => {
    const b = baseBatch();
    b.projects[0].purpose = '';
    b.projects[0].plannedStartDate = '';
    const pv = buildImportPreview(b);
    expect(pv.errors.some((e) => e.field === 'purpose')).toBe(true);
    expect(pv.errors.some((e) => e.field === 'plannedStartDate')).toBe(true);
  });

  it('必須日付: 月日が先頭の曖昧書式・非実在日・非日付はエラー', () => {
    // 3/1/2016 (月日先頭で曖昧) / 06/01/2026 (年が先頭でない) / 2026-02-30 (非実在) / 文字列
    for (const bad of ['3/1/2016', '06/01/2026', '2026-02-30', 'June 1']) {
      const b = baseBatch();
      b.projects[0].plannedStartDate = bad;
      const pv = buildImportPreview(b);
      expect(pv.errors.some((e) => e.field === 'plannedStartDate')).toBe(true);
    }
  });

  it('必須日付: YYYY/MM/DD (Excel 既定) や年先頭の書式は受理し YYYY-MM-DD へ正規化', () => {
    for (const ok of ['2026/06/01', '2026/6/1', '2026-6-1', '2026年6月1日']) {
      const b = baseBatch();
      b.projects[0].plannedStartDate = ok;
      const pv = buildImportPreview(b);
      expect(pv.errors.some((e) => e.field === 'plannedStartDate')).toBe(false);
      expect(pv.resolved.projects[0].plannedStartDate).toBe('2026-06-01');
    }
  });

  it('WBS の予定日: 認識できない日付はエラー / YYYY/MM/DD は正規化', () => {
    const bad = baseBatch();
    bad.projects[0].wbs = [
      { level: 1, type: 'activity', name: 'A', plannedStartDate: '06/01/2026', plannedEndDate: null, plannedEffort: null, sourceId: 'w1' },
    ];
    const pvBad = buildImportPreview(bad);
    const err = pvBad.errors.find((e) => e.entity === 'wbs' && e.field === 'plannedStartDate');
    expect(err).toBeTruthy();
    expect(err!.column).toBe('開始予定日');

    const good = baseBatch();
    good.projects[0].wbs = [
      { level: 1, type: 'activity', name: 'A', plannedStartDate: '2026/06/01', plannedEndDate: null, plannedEffort: null, sourceId: 'w1' },
    ];
    const pvGood = buildImportPreview(good);
    expect(pvGood.errors.some((e) => e.entity === 'wbs' && e.field === 'plannedStartDate')).toBe(false);
    expect(pvGood.resolved.projects[0].wbs[0].plannedStartDate).toBe('2026-06-01');
  });

  it('WBS レベルが数字でなければエラー (列名=レベル)', () => {
    const b = baseBatch();
    b.wbsLevelErrors.push({ projectName: '移行案件', origin: { file: 'WBS.csv', row: 2 }, rawLevel: 'あ' });
    const pv = buildImportPreview(b);
    const err = pv.errors.find((e) => e.entity === 'wbs' && e.field === 'level');
    expect(err).toBeTruthy();
    expect(err!.column).toBe('レベル');
    expect(err!.file).toBe('WBS.csv');
  });

  it('WBS 予定工数が不正なら wbsEffortErrors がエラー化 (列名=予定工数(人時))', () => {
    const b = baseBatch();
    b.wbsEffortErrors.push({ projectName: '移行案件', origin: { file: 'WBS.csv', row: 3 }, rawEffort: '8.55' });
    const pv = buildImportPreview(b);
    const err = pv.errors.find((e) => e.entity === 'wbs' && e.field === 'plannedEffort');
    expect(err).toBeTruthy();
    expect(err!.column).toBe('予定工数(人時)');
    expect(err!.file).toBe('WBS.csv');
    expect(err!.reason).toContain('8.55');
  });

  it('valueErrors (プルダウン選択肢外/日付不正) が errors に合流し列ラベルが付く', () => {
    const b = baseBatch();
    b.valueErrors.push({
      entity: 'risk', ref: 'R1', field: 'impact', origin: { file: 'リスク.csv', row: 2 },
      reason: '影響度「とても高い」は選択肢にありません。高／中／低 のいずれかを入力するか、空欄にしてください。',
    });
    const pv = buildImportPreview(b);
    const err = pv.errors.find((e) => e.entity === 'risk' && e.field === 'impact');
    expect(err).toBeTruthy();
    expect(err!.column).toBe('影響度');
    expect(err!.file).toBe('リスク.csv');
  });

  it('プロジェクト未紐づけ + 下書き の外部資産はエラー (取り込むと不可視データになるため)', () => {
    const b = baseBatch();
    b.externalRisks.push({ projectName: '', origin: { file: 'risk.csv', row: 2 }, data: { type: 'issue', title: 'R', visibility: '下書き' } });
    b.externalKnowledge.push({ projectName: '', origin: { file: 'k.csv', row: 2 }, data: { title: 'K', visibility: '下書き' } });
    b.externalRetros.push({ projectName: '', origin: { file: 'retro.csv', row: 2 }, data: { conductedDate: '2026-06-01', visibility: '下書き' } });
    const pv = buildImportPreview(b, existingIndex({}));
    const visErrs = pv.errors.filter((e) => e.field === 'visibility');
    expect(visErrs.map((e) => e.entity).sort()).toEqual(['knowledge', 'retrospective', 'risk']);
    expect(visErrs.every((e) => e.column === '公開範囲')).toBe(true);
    expect(visErrs[0].reason).toContain('表示されません');
  });

  it('プロジェクト未紐づけでも 公開 ならエラーにならない', () => {
    const b = baseBatch();
    b.externalRisks.push({ projectName: '', data: { type: 'issue', title: 'R', visibility: '公開' } });
    const pv = buildImportPreview(b, existingIndex({}));
    expect(pv.errors.filter((e) => e.field === 'visibility')).toEqual([]);
  });

  it('下書きでも 既存プロジェクトに紐づけば エラーにならない (個別画面で参照可能)', () => {
    const b = baseBatch();
    b.externalRisks.push({ projectName: '既存案件', data: { type: 'issue', title: 'R', visibility: '下書き' } });
    const existing = existingIndex({ projects: [['既存案件', 'proj-1']] });
    const pv = buildImportPreview(b, existing);
    expect(pv.errors.filter((e) => e.field === 'visibility')).toEqual([]);
  });

  it('WBS タスク名が空ならエラー', () => {
    const b = baseBatch();
    b.projects[0].wbs = [
      { level: 1, type: 'activity', name: '', plannedStartDate: null, plannedEndDate: null, plannedEffort: null, sourceId: 'w1' },
    ];
    const pv = buildImportPreview(b);
    expect(pv.errors.some((e) => e.entity === 'wbs' && e.field === 'name')).toBe(true);
  });

  it('B群 (リスク/ナレッジ/振り返り) は下書きで空でもエラーにならず既定値が入る', () => {
    const b = baseBatch();
    b.projects[0].risks = [{ type: 'risk', riskNature: '脅威', impact: '高', visibility: '不正値' }];
    b.projects[0].knowledge = [{ knowledgeType: '障害対応' }];
    b.projects[0].retros = [{}];
    const pv = buildImportPreview(b);
    expect(pv.errors).toEqual([]);
    const p = pv.resolved.projects[0];
    expect(p.risks[0]).toMatchObject({ type: 'risk', impact: 'high', riskNature: 'threat', visibility: 'draft' });
    expect(p.knowledge[0]).toMatchObject({ knowledgeType: 'incident', visibility: 'draft' });
    expect(p.retros[0].visibility).toBe('draft');
    expect(pv.summary.risks).toBe(1);
    expect(pv.summary.knowledge).toBe(1);
    expect(pv.summary.retrospectives).toBe(1);
  });

  it('顧客が同バッチに無くても既存テナント顧客に名前一致すればエラーなし + existingCustomerId 設定', () => {
    const b = baseBatch();
    b.customers = []; // バッチに顧客なし
    b.projects[0].customerRef = '既存の顧客';
    const existing = existingIndex({ customers: [['既存の顧客', 'cust-existing-1']] });
    const pv = buildImportPreview(b, existing);
    expect(pv.errors).toEqual([]);
    expect(pv.resolved.projects[0].customerKey).toBeNull();
    expect(pv.resolved.projects[0].existingCustomerId).toBe('cust-existing-1');
  });

  it('顧客が同バッチにも既存にも無ければエラー', () => {
    const b = baseBatch();
    b.customers = [];
    b.projects[0].customerRef = 'どこにもいない顧客';
    const pv = buildImportPreview(b, existingIndex({}));
    expect(pv.errors.some((e) => e.entity === 'project' && e.field === 'customerName')).toBe(true);
  });

  it('顧客の列値が未解決でも 既定値(customerRefDefault) が既存顧客に一致すれば解決 (規定値を考慮)', () => {
    const b = baseBatch();
    b.customers = [];
    b.projects[0].customerRef = 'a'; // 未登録
    b.projects[0].customerRefDefault = '既存顧客'; // 既定値は既存に一致
    const existing = existingIndex({ customers: [['既存顧客', 'cust-existing-9']] });
    const pv = buildImportPreview(b, existing);
    expect(pv.errors).toEqual([]);
    expect(pv.resolved.projects[0].existingCustomerId).toBe('cust-existing-9');
  });

  it('バッチ外WBS: 列値が未解決でも 既定値(projectNameDefault) が既存に一致すれば解決', () => {
    const b = baseBatch();
    b.externalWbs.push({
      projectName: 'a', // 未登録
      projectNameDefault: '既存の案件', // 既定値は既存に一致
      origin: { file: 'WBS.csv', row: 1 },
      rows: [wbsRow('タスク', 'w1')],
    });
    const existing = existingIndex({ projects: [['既存の案件', 'proj-9']] });
    const pv = buildImportPreview(b, existing);
    expect(pv.errors).toEqual([]);
    expect(pv.resolved.externalWbs[0].projectId).toBe('proj-9');
  });

  it('バッチ外WBS: projectName が既存プロジェクトに一致すれば externalWbs に解決 (エラーなし)', () => {
    const b = baseBatch();
    b.externalWbs.push({
      projectName: '既存の案件',
      origin: { file: 'WBS-テンプレート.csv', row: 1 },
      rows: [wbsRow('タスクA', 'w1'), wbsRow('タスクB', 'w2')],
    });
    const existing = existingIndex({ projects: [['既存の案件', 'proj-existing-1']] });
    const pv = buildImportPreview(b, existing);
    expect(pv.errors).toEqual([]);
    expect(pv.resolved.externalWbs).toEqual([
      { projectId: 'proj-existing-1', projectName: '既存の案件', rows: expect.any(Array) },
    ]);
    expect(pv.resolved.externalWbs[0].rows).toHaveLength(2);
    expect(pv.summary.wbs).toBe(2);
  });

  it('バッチ外WBS: projectName が既存にも取り込みCSVにも無ければエラー (列名=プロジェクト名)', () => {
    const b = baseBatch();
    b.externalWbs.push({
      projectName: '存在しない案件',
      origin: { file: 'WBS-テンプレート.csv', row: 2 },
      rows: [wbsRow('タスク', 'w1')],
    });
    const pv = buildImportPreview(b, existingIndex({}));
    const err = pv.errors.find((e) => e.entity === 'wbs' && e.field === 'projectName');
    expect(err).toBeTruthy();
    expect(err!.column).toBe('プロジェクト名');
    expect(err!.file).toBe('WBS-テンプレート.csv');
  });

  it('checkLinkWarnings: 未解決の顧客・プロジェクトを警告で返す (既定値で補える前提)', () => {
    const b = baseBatch();
    b.customers = [];
    b.projects[0].customerRef = '未登録の顧客';
    b.externalWbs.push({ projectName: '未登録の案件', rows: [] });
    const warns = checkLinkWarnings(b, existingIndex({}));
    expect(warns).toHaveLength(2);
    expect(warns.some((w) => w.includes('未登録の顧客'))).toBe(true);
    expect(warns.some((w) => w.includes('未登録の案件'))).toBe(true);
  });

  it('checkLinkWarnings: 既存に存在すれば警告を出さない', () => {
    const b = baseBatch();
    b.customers = [];
    b.projects[0].customerRef = '既存顧客';
    b.externalWbs.push({ projectName: '既存案件', rows: [] });
    const existing = existingIndex({
      customers: [['既存顧客', 'c1']],
      projects: [['既存案件', 'p1']],
    });
    expect(checkLinkWarnings(b, existing)).toEqual([]);
  });

  it('external 資産: 空 projectName は standalone(projectId=null)、既存に一致すれば紐づく', () => {
    const b = baseBatch();
    // standalone は「公開」なら横断一覧に表示されるためエラーにならない (下書きは別テストで検証)
    b.externalRisks.push({ projectName: '', data: { type: 'risk', title: 'standalone', impact: '高', visibility: '公開' } });
    b.externalRisks.push({ projectName: '既存案件', data: { type: 'issue', title: 'ひも付き' } });
    const existing = existingIndex({ projects: [['既存案件', 'proj-x']] });
    const pv = buildImportPreview(b, existing);
    expect(pv.errors).toEqual([]);
    expect(pv.resolved.externalRisks).toHaveLength(2);
    expect(pv.resolved.externalRisks[0].projectId).toBeNull();
    expect(pv.resolved.externalRisks[1].projectId).toBe('proj-x');
    expect(pv.summary.risks).toBe(2);
  });

  it('external 資産: 見つからない projectName は standalone + 警告 (公開なら B群は止めない)', () => {
    const b = baseBatch();
    b.externalKnowledge.push({ projectName: '無い案件', data: { knowledgeType: '調査', visibility: '公開' } });
    const pv = buildImportPreview(b, existingIndex({}));
    expect(pv.errors).toEqual([]);
    expect(pv.resolved.externalKnowledge[0].projectId).toBeNull();
    expect(pv.warnings.some((w) => w.includes('無い案件'))).toBe(true);
    expect(pv.summary.knowledge).toBe(1);
  });

  it('warnings は引き継がれ summary.errorCount が一致', () => {
    const b = baseBatch();
    b.warnings.push('循環参照を検出しました');
    b.customers[0].name = '';
    const pv = buildImportPreview(b);
    expect(pv.warnings).toContain('循環参照を検出しました');
    expect(pv.summary.errorCount).toBe(pv.errors.length);
  });
});
