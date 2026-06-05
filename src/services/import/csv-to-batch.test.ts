import { describe, it, expect } from 'vitest';
import { buildBatchFromCsv, type CsvEntitySource } from './csv-to-batch';
import { buildImportPreview } from './batch-preview';

describe('buildBatchFromCsv', () => {
  it('顧客→プロジェクト→WBS→各資産を名前参照で束ねる', () => {
    const sources: CsvEntitySource[] = [
      {
        entity: 'customer',
        rows: [{ 会社名: '株式会社サンプル', 部署: '情シス' }],
        columnMap: { name: '会社名', department: '部署' },
      },
      {
        entity: 'project',
        rows: [{ 案件名: '基幹刷新', 顧客: '株式会社サンプル', 目的: 'X', 背景: 'Y', 範囲: 'Z', 開始: '2026-06-01', 終了: '2026-06-30' }],
        columnMap: {
          name: '案件名', customerName: '顧客', purpose: '目的', background: '背景', scope: '範囲',
          plannedStartDate: '開始', plannedEndDate: '終了',
        },
        fixedMap: { devMethod: 'スクラッチ開発' },
      },
      {
        entity: 'wbs',
        rows: [
          { PJ: '基幹刷新', レベル: '1', 名称: '設計', 工数: '' },
          { PJ: '基幹刷新', レベル: '2', 名称: '基本設計', 工数: '8' },
          { PJ: '基幹刷新', レベル: '2', 名称: '詳細設計', 工数: '12' },
        ],
        columnMap: { projectName: 'PJ', level: 'レベル', name: '名称', plannedEffort: '工数' },
      },
      {
        entity: 'risk',
        rows: [{ PJ: '基幹刷新', 件名: '納期リスク', 影響: '高' }],
        columnMap: { projectName: 'PJ', title: '件名', impact: '影響' },
        fixedMap: { type: 'risk' },
      },
    ];

    const batch = buildBatchFromCsv(sources);
    expect(batch.source).toBe('csv');
    expect(batch.customers).toHaveLength(1);
    expect(batch.projects).toHaveLength(1);

    const p = batch.projects[0];
    expect(p.customerRef).toBe('株式会社サンプル');
    // WBS: 設計(子あり=WP) → 基本設計/詳細設計(葉=ACT)
    expect(p.wbs.map((r) => [r.name, r.level, r.type])).toEqual([
      ['設計', 1, 'work_package'],
      ['基本設計', 2, 'activity'],
      ['詳細設計', 2, 'activity'],
    ]);
    expect(p.risks).toHaveLength(1);
    expect(p.risks[0].type).toBe('risk');

    // プレビューまで通り、エラーなし (日付は正規化, devMethod は固定値)
    const pv = buildImportPreview(batch);
    expect(pv.errors).toEqual([]);
    expect(pv.resolved.projects[0].devMethod).toBe('scratch');
    expect(pv.resolved.projects[0].plannedStartDate).toBe('2026-06-01');
    expect(pv.summary).toMatchObject({ customers: 1, projects: 1, wbs: 3, risks: 1 });
  });

  it('所属プロジェクトが同バッチに無いWBSは externalWbs に退避 (既存プロジェクトと照合する)', () => {
    const sources: CsvEntitySource[] = [
      {
        entity: 'wbs',
        rows: [{ PJ: '既存の案件', レベル: '1', 名称: 'タスク' }],
        columnMap: { projectName: 'PJ', level: 'レベル', name: '名称' },
        fileName: 'WBS-テンプレート.csv',
      },
    ];
    const batch = buildBatchFromCsv(sources);
    expect(batch.projects).toEqual([]);
    const g = batch.externalWbs.find((x) => x.projectName === '既存の案件');
    expect(g).toBeTruthy();
    expect(g!.rows.length).toBe(1);
    expect(g!.origin?.file).toBe('WBS-テンプレート.csv');
  });

  it('選択項目・日付: CSV列の値が無効なら既定値を採用する (規定値を考慮)', () => {
    const sources: CsvEntitySource[] = [
      {
        entity: 'project',
        rows: [
          {
            案件名: 'P',
            顧客: 'C',
            目的: 'x',
            背景: 'y',
            範囲: 'z',
            開発: 'インポートテスト用', // 無効
            契約: 'インポートテスト用', // 無効
            状態: 'インポートテスト用', // 無効
            開始: 'インポートテスト用', // 無効な日付
            終了: '2026-06-30', // 有効 (YYYY-MM-DD)
          },
        ],
        columnMap: {
          name: '案件名', customerName: '顧客', purpose: '目的', background: '背景', scope: '範囲',
          devMethod: '開発', contractType: '契約', status: '状態',
          plannedStartDate: '開始', plannedEndDate: '終了',
        },
        fixedMap: {
          devMethod: 'スクラッチ開発',
          contractType: '準委任',
          status: '実行中',
          plannedStartDate: '2026-06-01',
        },
      },
    ];
    const p = buildBatchFromCsv(sources).projects[0];
    // 無効な列値 → 既定値が採用される
    expect(p.devMethod).toBe('スクラッチ開発');
    expect(p.contractType).toBe('準委任');
    expect(p.status).toBe('実行中');
    expect(p.plannedStartDate).toBe('2026-06-01');
    // 有効な列値はそのまま (既定値で上書きしない)
    expect(p.plannedEndDate).toBe('2026-06-30');
  });

  it('WBS のレベルが数字でない行は wbsLevelErrors に退避 (プレビューでエラー化)', () => {
    const sources: CsvEntitySource[] = [
      {
        entity: 'wbs',
        rows: [
          { PJ: '案件', レベル: '1', 名称: '設計' },
          { PJ: '案件', レベル: 'あ', 名称: '基本設計' }, // 非数字
          { PJ: '案件', レベル: '', 名称: '詳細設計' }, // 空
        ],
        columnMap: { projectName: 'PJ', level: 'レベル', name: '名称' },
        fileName: 'WBS.csv',
      },
    ];
    const batch = buildBatchFromCsv(sources);
    expect(batch.wbsLevelErrors).toHaveLength(2);
    expect(batch.wbsLevelErrors.map((e) => e.rawLevel)).toEqual(['あ', '']);
    expect(batch.wbsLevelErrors[0].origin?.file).toBe('WBS.csv');
  });

  it('WBS 予定工数: 小数第一位までの数値はそのまま、空は null (エラーなし)', () => {
    const sources: CsvEntitySource[] = [
      {
        entity: 'wbs',
        rows: [
          { PJ: '案件', レベル: '1', 名称: '親' },
          { PJ: '案件', レベル: '2', 名称: 'A', 工数: '8' },
          { PJ: '案件', レベル: '2', 名称: 'B', 工数: '8.5' },
          { PJ: '案件', レベル: '2', 名称: 'C', 工数: '0' },
          { PJ: '案件', レベル: '2', 名称: 'D', 工数: '' },
        ],
        columnMap: { projectName: 'PJ', level: 'レベル', name: '名称', plannedEffort: '工数' },
        fileName: 'WBS.csv',
      },
    ];
    const batch = buildBatchFromCsv(sources);
    expect(batch.wbsEffortErrors).toHaveLength(0);
    const rows = batch.externalWbs[0].rows;
    expect(rows.map((r) => r.plannedEffort)).toEqual([null, 8, 8.5, 0, null]);
  });

  it('WBS 予定工数: 小数第二位以降・負数・非数値は wbsEffortErrors に退避 (プレビューでエラー化)', () => {
    const sources: CsvEntitySource[] = [
      {
        entity: 'wbs',
        rows: [
          { PJ: '案件', レベル: '1', 名称: '親' },
          { PJ: '案件', レベル: '2', 名称: 'A', 工数: '8.55' }, // 小数第二位
          { PJ: '案件', レベル: '2', 名称: 'B', 工数: '-3' }, // 負数
          { PJ: '案件', レベル: '2', 名称: 'C', 工数: 'たくさん' }, // 非数値
        ],
        columnMap: { projectName: 'PJ', level: 'レベル', name: '名称', plannedEffort: '工数' },
        fileName: 'WBS.csv',
      },
    ];
    const batch = buildBatchFromCsv(sources);
    expect(batch.wbsEffortErrors.map((e) => e.rawEffort)).toEqual(['8.55', '-3', 'たくさん']);
    expect(batch.wbsEffortErrors[0].origin?.file).toBe('WBS.csv');
    // 行自体は階層維持のため残り、工数は null になる
    const rows = batch.externalWbs[0].rows;
    expect(rows.map((r) => r.plannedEffort)).toEqual([null, null, null, null]);
  });

  it('プロジェクトが無いリスク・課題は externalRisks へ退避 (空 projectName=standalone)', () => {
    const sources: CsvEntitySource[] = [
      {
        entity: 'risk',
        rows: [
          { 件名: 'R1', 影響: '高' }, // projectName 列なし → standalone
          { PJ: '既存案件', 件名: 'R2' }, // 非空 → 既存照合 (preview)
        ],
        columnMap: { projectName: 'PJ', title: '件名', impact: '影響' },
        fixedMap: { type: 'risk' },
        fileName: 'risk.csv',
      },
    ];
    const batch = buildBatchFromCsv(sources);
    expect(batch.projects).toEqual([]);
    expect(batch.externalRisks).toHaveLength(2);
    expect(batch.externalRisks[0].projectName).toBe(''); // standalone
    expect(batch.externalRisks[0].data.title).toBe('R1');
    expect(batch.externalRisks[1].projectName).toBe('既存案件');
    expect(batch.externalRisks[0].origin?.file).toBe('risk.csv');
  });

  it('固定値(既定値)は列が空のとき採用される', () => {
    const sources: CsvEntitySource[] = [
      {
        entity: 'customer',
        rows: [{ 会社名: 'A社', 備考: '' }],
        columnMap: { name: '会社名', notes: '備考' },
        fixedMap: { notes: '（移行データ）' },
      },
    ];
    const batch = buildBatchFromCsv(sources);
    expect(batch.customers[0].notes).toBe('（移行データ）');
  });
});

describe('リスク・課題: 影響度/重要度・発生可能性/緊急度のカラム分離', () => {
  const riskColumnMap = {
    projectName: 'PJ', type: '種別', title: '件名',
    impact: '影響度', importance: '重要度', likelihood: '発生可能性', urgency: '緊急度',
    riskNature: '脅威好機', visibility: '公開範囲', deadline: '期限',
  };

  it('種別に応じて使う列を切り替える (リスク→影響度/発生可能性, 課題→重要度/緊急度。DB 列は同一)', () => {
    const sources: CsvEntitySource[] = [
      {
        entity: 'risk',
        rows: [
          { 種別: 'リスク', 件名: 'R1', 影響度: '高', 発生可能性: '中', 脅威好機: '脅威', 公開範囲: '公開' },
          { 種別: '課題', 件名: 'I1', 重要度: '低', 緊急度: '高', 公開範囲: '公開' },
        ],
        columnMap: riskColumnMap,
      },
    ];
    const batch = buildBatchFromCsv(sources);
    expect(batch.valueErrors).toEqual([]);
    const pv = buildImportPreview(batch);
    expect(pv.errors).toEqual([]);
    const [r, i] = pv.resolved.externalRisks;
    expect(r.data).toMatchObject({ type: 'risk', impact: 'high', likelihood: 'medium', riskNature: 'threat' });
    expect(i.data).toMatchObject({ type: 'issue', impact: 'low', likelihood: 'high', riskNature: null });
  });

  it('種別が選択肢外なら valueErrors (field=type)', () => {
    const batch = buildBatchFromCsv([
      { entity: 'risk', rows: [{ 種別: 'なにか', 件名: 'R' }], columnMap: riskColumnMap, fileName: 'リスク.csv' },
    ]);
    const err = batch.valueErrors.find((e) => e.field === 'type');
    expect(err).toBeTruthy();
    expect(err!.entity).toBe('risk');
    expect(err!.origin?.file).toBe('リスク.csv');
  });

  it('リスクの影響度が選択肢外なら valueErrors (field=impact)', () => {
    const batch = buildBatchFromCsv([
      { entity: 'risk', rows: [{ 種別: 'リスク', 件名: 'R', 影響度: 'とても高い' }], columnMap: riskColumnMap },
    ]);
    expect(batch.valueErrors.map((e) => e.field)).toContain('impact');
  });

  it('課題の重要度が選択肢外なら valueErrors (field=importance, 列ラベル=重要度)', () => {
    const batch = buildBatchFromCsv([
      { entity: 'risk', rows: [{ 種別: '課題', 件名: 'I', 重要度: '超重要' }], columnMap: riskColumnMap },
    ]);
    const err = batch.valueErrors.find((e) => e.field === 'importance');
    expect(err).toBeTruthy();
    // プレビューで列ラベルが「重要度」になる
    const pv = buildImportPreview(batch);
    const pe = pv.errors.find((e) => e.field === 'importance');
    expect(pe!.column).toBe('重要度');
  });

  it('脅威/好機・公開範囲・期限の不正をまとめて検証 (期限は認識不能な日付のみエラー)', () => {
    const batch = buildBatchFromCsv([
      {
        entity: 'risk',
        rows: [{ 種別: 'リスク', 件名: 'R', 脅威好機: '中立', 公開範囲: '機密', 期限: '06/01/2026' }],
        columnMap: riskColumnMap,
      },
    ]);
    const fields = batch.valueErrors.map((e) => e.field).sort();
    expect(fields).toEqual(['deadline', 'riskNature', 'visibility']);
  });

  it('期限が YYYY/MM/DD (Excel 既定) なら受理 (deadline エラーなし)', () => {
    const batch = buildBatchFromCsv([
      {
        entity: 'risk',
        rows: [{ 種別: 'リスク', 件名: 'R', 期限: '2026/06/01', 公開範囲: '公開' }],
        columnMap: riskColumnMap,
      },
    ]);
    expect(batch.valueErrors.some((e) => e.field === 'deadline')).toBe(false);
    const pv = buildImportPreview(batch);
    expect(pv.resolved.externalRisks[0].data.deadline).toBe('2026-06-01');
  });

  it('課題行では脅威/好機を検証しない (リスクのみ対象)', () => {
    const batch = buildBatchFromCsv([
      { entity: 'risk', rows: [{ 種別: '課題', 件名: 'I', 脅威好機: '中立' }], columnMap: riskColumnMap },
    ]);
    expect(batch.valueErrors.some((e) => e.field === 'riskNature')).toBe(false);
  });
});

describe('ナレッジ/振り返り: プルダウン・日付の選択肢検証', () => {
  it('ナレッジ: 種別・公開範囲が選択肢外なら valueErrors', () => {
    const batch = buildBatchFromCsv([
      {
        entity: 'knowledge',
        rows: [{ タイトル: 'K', 種別: 'なぞ', 公開: '機密' }],
        columnMap: { title: 'タイトル', knowledgeType: '種別', visibility: '公開' },
      },
    ]);
    expect(batch.valueErrors.map((e) => e.field).sort()).toEqual(['knowledgeType', 'visibility']);
  });

  it('振り返り: 公開範囲・実施日を検証 (認識不能な日付はエラー)', () => {
    const batch = buildBatchFromCsv([
      {
        entity: 'retrospective',
        rows: [{ 実施日: '06/01/2026', 公開: '機密' }],
        columnMap: { conductedDate: '実施日', visibility: '公開' },
      },
    ]);
    expect(batch.valueErrors.map((e) => e.field).sort()).toEqual(['conductedDate', 'visibility']);
  });

  it('振り返り: 実施日が YYYY/MM/DD なら受理して正規化', () => {
    const batch = buildBatchFromCsv([
      {
        entity: 'retrospective',
        rows: [{ 実施日: '2026/06/01', 公開: '公開' }],
        columnMap: { conductedDate: '実施日', visibility: '公開' },
      },
    ]);
    expect(batch.valueErrors).toEqual([]);
    const pv = buildImportPreview(batch);
    expect(pv.resolved.externalRetros[0].data.conductedDate).toBe('2026-06-01');
  });

  it('正しい選択肢・日付ならエラーなし', () => {
    const batch = buildBatchFromCsv([
      {
        entity: 'knowledge',
        rows: [{ タイトル: 'K', 種別: '調査', 公開: '公開' }],
        columnMap: { title: 'タイトル', knowledgeType: '種別', visibility: '公開' },
      },
    ]);
    expect(batch.valueErrors).toEqual([]);
    const pv = buildImportPreview(batch);
    expect(pv.errors).toEqual([]);
    expect(pv.resolved.externalKnowledge[0].data).toMatchObject({ knowledgeType: 'research', visibility: 'public' });
  });

  it('選択肢外でも 既定値(マッピング)が正しければ既定値を採用しエラーなし', () => {
    const batch = buildBatchFromCsv([
      {
        entity: 'knowledge',
        rows: [{ タイトル: 'K', 公開: '機密' }], // 列値は不正
        columnMap: { title: 'タイトル', visibility: '公開' },
        fixedMap: { visibility: '公開' }, // 既定値は有効
      },
    ]);
    expect(batch.valueErrors).toEqual([]);
    const pv = buildImportPreview(batch);
    expect(pv.resolved.externalKnowledge[0].data.visibility).toBe('public');
  });
});
