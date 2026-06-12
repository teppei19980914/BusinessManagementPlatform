/**
 * 工数見積もり Excel エクスポート (v1.2.0)
 *
 * exceljs は既存依存 (^4.4.0)。ビルドサイズ削減のため dynamic import を使用する
 * (file-text-extraction.service.ts と同じパターン)。
 *
 * シート構成:
 *   - Sheet1 "工数サマリ": カテゴリ別小計・バッファ設定・合計工数
 *   - Sheet2 "見積明細": 全明細行 (項目名・区分・入力モード・ツール・工数・確定状態・備考)
 */

import { TASK_CATEGORIES, EFFORT_UNITS } from '@/types';
import { getMethodOption } from '@/config/estimate-master';
import type { EstimateDTO } from '@/services/estimate.service';

function formatDate(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

function toYYYYMMDD(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export async function exportEstimateExcel(
  estimates: EstimateDTO[],
  projectName: string,
  bufferRate: number,
): Promise<void> {
  const ExcelJS = (await import('exceljs')) as typeof import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const today = new Date();

  // ---- カテゴリ別集計 ----
  const categoryKeys = Object.keys(TASK_CATEGORIES) as Array<keyof typeof TASK_CATEGORIES>;
  const categoryTotals = categoryKeys.map((key) => ({
    key,
    label: TASK_CATEGORIES[key],
    total: estimates.filter((e) => e.category === key).reduce((s, e) => s + e.estimatedEffort, 0),
  })).filter((c) => c.total > 0);

  const subtotal = estimates.reduce((s, e) => s + e.estimatedEffort, 0);
  const bufferHours = Math.round(subtotal * bufferRate * 10) / 10;
  const totalWithBuffer = Math.round((subtotal + bufferHours) * 10) / 10;

  // ================================================================
  // Sheet 1: 工数サマリ
  // ================================================================
  const summarySheet = workbook.addWorksheet('工数サマリ');
  summarySheet.columns = [{ width: 30 }, { width: 20 }];

  summarySheet.addRow([`プロジェクト名`, projectName]);
  summarySheet.addRow([`出力日`, formatDate(today)]);
  summarySheet.addRow([]);
  summarySheet.addRow(['カテゴリ', '工数 (h)']);

  const headerRow = summarySheet.lastRow;
  if (headerRow) {
    headerRow.font = { bold: true };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
  }

  for (const c of categoryTotals) {
    summarySheet.addRow([c.label, c.total]);
  }

  summarySheet.addRow([]);
  summarySheet.addRow(['小計 (h)', subtotal]);
  summarySheet.addRow([`バッファ (${bufferRate * 100}%)`, bufferHours]);

  const totalRow = summarySheet.addRow([`合計 (h・バッファ込み)`, totalWithBuffer]);
  totalRow.font = { bold: true };

  // ================================================================
  // Sheet 2: 見積明細
  // ================================================================
  const detailSheet = workbook.addWorksheet('見積明細');
  detailSheet.columns = [
    { header: '項目名', key: 'itemName', width: 30 },
    { header: '区分', key: 'category', width: 14 },
    { header: '入力モード', key: 'inputMode', width: 12 },
    { header: '開発ツール', key: 'tool', width: 24 },
    { header: '規模係数', key: 'scaleCoeff', width: 10 },
    { header: '難易度係数', key: 'difficultyCoeff', width: 12 },
    { header: '基準時間 (h)', key: 'baseHours', width: 14 },
    { header: '工数', key: 'estimatedEffort', width: 10 },
    { header: '単位', key: 'effortUnit', width: 8 },
    { header: 'ステータス', key: 'state', width: 10 },
    { header: '備考', key: 'notes', width: 40 },
  ];

  const detailHeader = detailSheet.getRow(1);
  detailHeader.font = { bold: true };
  detailHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };

  for (const e of estimates) {
    const methodOpt = e.inputMode === 'coefficient' ? getMethodOption(e.devMethod) : undefined;
    detailSheet.addRow({
      itemName: e.itemName,
      category: TASK_CATEGORIES[e.category as keyof typeof TASK_CATEGORIES] ?? e.category,
      inputMode: e.inputMode === 'coefficient' ? '係数' : '手動',
      tool: methodOpt?.label ?? '—',
      scaleCoeff: e.scaleCoeff ?? '—',
      difficultyCoeff: e.difficultyCoeff ?? '—',
      baseHours: e.baseHours ?? '—',
      estimatedEffort: e.estimatedEffort,
      effortUnit: EFFORT_UNITS[e.effortUnit as keyof typeof EFFORT_UNITS] ?? e.effortUnit,
      state: e.isConfirmed ? '確定' : '未確定',
      notes: e.notes ?? '',
    });
  }

  // ---- ダウンロード ----
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${projectName}_工数見積もり_${toYYYYMMDD(today)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
