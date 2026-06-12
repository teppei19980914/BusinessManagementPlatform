/**
 * 工数見積もり Word エクスポート (v1.2.0)
 *
 * docx 9.7.1 を使用 (v1.2.0 で新規追加)。
 *
 * ドキュメント構成:
 *   表紙: プロジェクト名・出力日・合計工数（バッファ込み）
 *   1. 工数サマリ: カテゴリ別小計テーブル・バッファ・合計
 *   2. 見積明細: カテゴリ別グルーピングした明細テーブル
 *   3. 備考一覧: 備考が入力されている明細の内容を集約
 */

import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  TextRun,
  HeadingLevel,
  AlignmentType,
  WidthType,
  BorderStyle,
} from 'docx';
import { TASK_CATEGORIES, EFFORT_UNITS } from '@/types';
import { getMethodOption } from '@/config/estimate-master';
import type { EstimateDTO } from '@/services/estimate.service';

function toYYYYMMDD(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
function formatDate(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function cellText(text: string, bold = false): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, bold, size: 18 })] })],
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
  });
}

function headerCell(text: string): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, bold: true, size: 18 })] })],
    shading: { fill: 'E2E8F0' },
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
  });
}

export async function exportEstimateWord(
  estimates: EstimateDTO[],
  projectName: string,
  bufferRate: number,
): Promise<void> {
  const today = new Date();

  // ---- 集計 ----
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
  // 1. 工数サマリテーブル
  // ================================================================
  const summaryRows = [
    new TableRow({ children: [headerCell('カテゴリ'), headerCell('工数 (h)')] }),
    ...categoryTotals.map((c) => new TableRow({
      children: [cellText(c.label), cellText(String(c.total))],
    })),
    new TableRow({ children: [cellText('小計 (h)', true), cellText(String(subtotal), true)] }),
    new TableRow({ children: [cellText(`バッファ (${bufferRate * 100}%)`, true), cellText(String(bufferHours))] }),
    new TableRow({ children: [cellText('合計（バッファ込み）(h)', true), cellText(String(totalWithBuffer), true)] }),
  ];

  const summaryTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: summaryRows,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1 },
      bottom: { style: BorderStyle.SINGLE, size: 1 },
      left: { style: BorderStyle.SINGLE, size: 1 },
      right: { style: BorderStyle.SINGLE, size: 1 },
      insideVertical: { style: BorderStyle.SINGLE, size: 1 },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1 },
    },
  });

  // ================================================================
  // 2. 見積明細テーブル（カテゴリ別）
  // ================================================================
  const detailRows: TableRow[] = [
    new TableRow({
      children: [
        headerCell('項目名'),
        headerCell('区分'),
        headerCell('入力モード'),
        headerCell('開発ツール'),
        headerCell('工数'),
        headerCell('ステータス'),
      ],
    }),
    ...estimates.map((e) => {
      const methodOpt = e.inputMode === 'coefficient' ? getMethodOption(e.devMethod) : undefined;
      return new TableRow({
        children: [
          cellText(e.itemName),
          cellText(TASK_CATEGORIES[e.category as keyof typeof TASK_CATEGORIES] ?? e.category),
          cellText(e.inputMode === 'coefficient' ? '係数' : '手動'),
          cellText(methodOpt?.label ?? '—'),
          cellText(`${e.estimatedEffort} ${EFFORT_UNITS[e.effortUnit as keyof typeof EFFORT_UNITS] ?? e.effortUnit}`),
          cellText(e.isConfirmed ? '確定' : '未確定'),
        ],
      });
    }),
  ];

  const detailTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: detailRows,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1 },
      bottom: { style: BorderStyle.SINGLE, size: 1 },
      left: { style: BorderStyle.SINGLE, size: 1 },
      right: { style: BorderStyle.SINGLE, size: 1 },
      insideVertical: { style: BorderStyle.SINGLE, size: 1 },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1 },
    },
  });

  // ================================================================
  // 3. 備考一覧
  // ================================================================
  const withNotes = estimates.filter((e) => e.notes && e.notes.trim() !== '');

  // ================================================================
  // ドキュメント組み立て
  // ================================================================
  const doc = new Document({
    sections: [{
      children: [
        // 表紙
        new Paragraph({
          text: `${projectName}`,
          heading: HeadingLevel.TITLE,
          alignment: AlignmentType.CENTER,
        }),
        new Paragraph({
          children: [new TextRun({ text: '工数見積もり報告書', size: 28, bold: true })],
          alignment: AlignmentType.CENTER,
        }),
        new Paragraph({ text: '' }),
        new Paragraph({
          children: [new TextRun({ text: `出力日: ${formatDate(today)}`, size: 20 })],
          alignment: AlignmentType.CENTER,
        }),
        new Paragraph({
          children: [new TextRun({ text: `合計工数（バッファ込み）: ${totalWithBuffer}h`, size: 20, bold: true })],
          alignment: AlignmentType.CENTER,
        }),
        new Paragraph({ text: '' }),
        new Paragraph({ text: '' }),

        // 1. 工数サマリ
        new Paragraph({ text: '1. 工数サマリ', heading: HeadingLevel.HEADING_1 }),
        summaryTable,
        new Paragraph({ text: '' }),

        // 2. 見積明細
        new Paragraph({ text: '2. 見積明細', heading: HeadingLevel.HEADING_1 }),
        detailTable,
        new Paragraph({ text: '' }),

        // 3. 備考一覧
        new Paragraph({ text: '3. 備考一覧', heading: HeadingLevel.HEADING_1 }),
        ...(withNotes.length === 0
          ? [new Paragraph({ children: [new TextRun({ text: '備考なし', italics: true, color: '888888' })] })]
          : withNotes.flatMap((e) => [
              new Paragraph({
                children: [new TextRun({ text: `【${e.itemName}】`, bold: true, size: 20 })],
              }),
              new Paragraph({
                children: [new TextRun({ text: e.notes ?? '', size: 18 })],
                indent: { left: 360 },
              }),
            ])
        ),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const blob = new Blob([new Uint8Array(buffer)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${projectName}_工数見積もり報告書_${toYYYYMMDD(today)}.docx`;
  a.click();
  URL.revokeObjectURL(url);
}
