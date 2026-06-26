/**
 * 外部移行インポート — エンティティ別「インポート対象項目」カタログ (ADR-0034)
 *
 * マッピングUIが「どのたすきば項目に列を割り当てられるか」を表示するためのソース。
 * 対象は「画面で設定できる項目のみ」(field-reference.md / COLUMN_USAGE_MAP.md)。
 * 非表示・編集専用・自動算出 (結果/優先度/分類等) は含めない。
 * 値マッピング・日付正規化・公開範囲フォールバックは取り込み経路 (batch-preview) が担う。
 */

import type { ImportEntityKind } from './normalized-batch';

export interface ImportFieldDef {
  /** 内部フィールド名 (CsvEntitySource の columnMap キーと一致) */
  field: string;
  /** 画面ラベル */
  label: string;
  /** 必須か (A群=ハード必須 / 親参照)。B群は公開範囲=下書きで空可なので false */
  required?: boolean;
  /** 補足 */
  hint?: string;
}

export const IMPORT_FIELD_CATALOG: Record<ImportEntityKind, ImportFieldDef[]> = {
  customer: [
    { field: 'name', label: '顧客名', required: true },
    { field: 'department', label: '部門' },
    { field: 'contactPerson', label: '担当者' },
    { field: 'contactEmail', label: '担当者メール' },
    { field: 'notes', label: '備考' },
  ],
  project: [
    { field: 'name', label: 'プロジェクト名', required: true },
    { field: 'customerName', label: '顧客名', required: true, hint: '取り込む顧客の名前と一致させます' },
    { field: 'purpose', label: '目的', required: true },
    { field: 'background', label: '背景', required: true },
    { field: 'scope', label: 'スコープ', required: true },
    { field: 'devMethod', label: '開発方式', hint: 'スクラッチ開発／ローコード・ノーコード開発／パッケージ開発／そのほか' },
    { field: 'contractType', label: '契約形態', hint: '準委任／請負／SES／そのほか' },
    { field: 'status', label: 'ステータス', hint: '企画中／見積中／計画中／実行中／クローズ' },
    { field: 'plannedStartDate', label: '開始予定日', required: true, hint: 'YYYY-MM-DD または YYYY/MM/DD（例: 2026/06/01）' },
    { field: 'plannedEndDate', label: '終了予定日', required: true, hint: 'YYYY-MM-DD または YYYY/MM/DD' },
  ],
  wbs: [
    { field: 'projectName', label: 'プロジェクト名', required: true, hint: '取り込むプロジェクトの名前と一致させます' },
    { field: 'level', label: 'レベル', required: true, hint: '階層の深さ (1=最上位)。子を持つ行はワークパッケージ、葉はアクティビティ' },
    { field: 'name', label: '名称', required: true },
    { field: 'plannedStartDate', label: '開始予定日', hint: 'アクティビティのみ' },
    { field: 'plannedEndDate', label: '終了予定日', hint: 'アクティビティのみ' },
    { field: 'plannedEffort', label: '予定工数(人時)', hint: 'アクティビティのみ・0 以上の数値（小数第一位まで。例: 8 / 8.5）' },
    { field: 'includeWeekends', label: '土日祝日を含める', hint: 'true / false（省略時は false）' },
  ],
  risk: [
    { field: 'projectName', label: 'プロジェクト名', hint: '紐づけるプロジェクト名 (空なら紐づけなし)' },
    { field: 'type', label: '種別', hint: 'リスク／課題 (このいずれか。空欄は課題扱い)' },
    { field: 'title', label: '件名' },
    { field: 'occurrence', label: '発生事象' },
    { field: 'content', label: 'メモ' },
    { field: 'cause', label: '原因' },
    // 影響度(リスク) と 重要度(課題) は別カラム。種別に応じて使う列が決まる (どちらも DB は impact 列)。
    { field: 'impact', label: '影響度', hint: '種別=リスクの場合・高／中／低' },
    { field: 'importance', label: '重要度', hint: '種別=課題の場合・高／中／低' },
    // 発生可能性(リスク) と 緊急度(課題) も別カラム (どちらも DB は likelihood 列)。
    { field: 'likelihood', label: '発生可能性', hint: '種別=リスクの場合・高／中／低' },
    { field: 'urgency', label: '緊急度', hint: '種別=課題の場合・高／中／低' },
    { field: 'responsePolicy', label: '対応方針' },
    { field: 'deadline', label: '期限', hint: 'YYYY-MM-DD または YYYY/MM/DD（例: 2026/06/01）' },
    { field: 'riskNature', label: '脅威／好機', hint: 'リスクのみ・脅威／好機' },
    { field: 'visibility', label: '公開範囲', hint: '下書き／公開 (既定=下書き)' },
  ],
  knowledge: [
    { field: 'projectName', label: 'プロジェクト名', hint: '紐づけるプロジェクト名 (空なら紐づけなし)' },
    { field: 'title', label: 'タイトル' },
    { field: 'knowledgeType', label: '種別', hint: '調査／検証／障害対応／意思決定／教訓／ベストプラクティス／その他' },
    { field: 'background', label: '背景' },
    { field: 'content', label: '内容' },
    { field: 'result', label: '結果' },
    { field: 'visibility', label: '公開範囲', hint: '下書き／公開 (既定=下書き)' },
  ],
  retrospective: [
    { field: 'projectName', label: 'プロジェクト名', hint: '紐づけるプロジェクト名 (空なら紐づけなし)' },
    { field: 'conductedDate', label: '実施日', hint: '空なら当日を補完。入れる場合は YYYY-MM-DD または YYYY/MM/DD（例: 2026/06/01）' },
    { field: 'planSummary', label: '計画総括' },
    { field: 'actualSummary', label: '実績総括' },
    { field: 'goodPoints', label: '良かった点' },
    { field: 'problems', label: '問題点' },
    { field: 'improvements', label: '次回改善事項' },
    { field: 'visibility', label: '公開範囲', hint: '下書き／公開 (既定=下書き)' },
  ],
};

/** 内部フィールド名 → 画面の日本語ラベル (= テンプレCSVの列名)。未定義はフィールド名をそのまま返す。 */
export function getImportFieldLabel(entity: ImportEntityKind, field: string): string {
  return IMPORT_FIELD_CATALOG[entity]?.find((d) => d.field === field)?.label ?? field;
}

export const IMPORT_ENTITY_LABELS: Record<ImportEntityKind, string> = {
  customer: '顧客',
  project: 'プロジェクト',
  wbs: 'WBS（タスク）',
  risk: 'リスク・課題',
  knowledge: 'ナレッジ',
  retrospective: '振り返り',
};

/** 取り込み順 (依存順: 顧客→プロジェクト→子)。UI の表示順にも使う。 */
export const IMPORT_ENTITY_ORDER: ImportEntityKind[] = [
  'customer',
  'project',
  'wbs',
  'risk',
  'knowledge',
  'retrospective',
];

/**
 * インポート対象フィールドの DB 最大文字数 (VarChar 列の上限)。掲載が無いフィールドは Text(無制限)。
 * 正本は prisma/schema.prisma。超過は取り込み時にサイレント切り捨てされず、プレビューでエラーになる
 * (外部API・大きなCSV/Excel セルからの長文流入で apply 時に Prisma が弾く事故を、プレビュー段で予防)。
 */
export const IMPORT_FIELD_MAX_LENGTH: Partial<Record<ImportEntityKind, Record<string, number>>> = {
  customer: { name: 100, department: 100, contactPerson: 100, contactEmail: 255 },
  project: { name: 100 },
  wbs: { name: 100 },
  risk: { title: 100 },
  knowledge: { title: 150 },
};

/** (entity, field) の DB 最大長を返す。無制限 (Text) は undefined。 */
export function getImportFieldMaxLength(entity: ImportEntityKind, field: string): number | undefined {
  return IMPORT_FIELD_MAX_LENGTH[entity]?.[field];
}
