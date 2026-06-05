/**
 * 外部移行インポート — 共通中間形式 NormalizedBatch (ADR-0034 §0-1)
 *
 * 各サービスのコネクタは「相手のデータをこの形に正規化する」までを責務とし、
 * マッピング・検証・依存解決・取り込みは共通の import 基盤が担う。
 *
 * 設計方針:
 *   - フィールド値は **生の抽出値 (主に文字列)** で保持する。選択項目の内部値化は
 *     [value-mapping.ts]、日付の正規化は [date-normalize.ts] を取り込み経路で適用する
 *     (= 変換ロジックを 1 箇所に集約し、コネクタはサービス差異の吸収に専念)。
 *   - 親子参照は **バッチ内の sourceKey** で表す (顧客→プロジェクト→各資産)。
 *     既存データは参照しない自己完結バッチ (ADR-0034 §2)。
 *   - WBS は [wbs-hierarchy.ts] の WbsRow (前順序 + レベル) で保持する。
 */

import type { WbsRow } from './wbs-hierarchy';

/** たすきばのインポート対象エンティティ種別 */
export type ImportEntityKind =
  | 'customer'
  | 'project'
  | 'wbs'
  | 'risk'
  | 'knowledge'
  | 'retrospective';

/** 第1弾の対応ソース (ADR-0034 / IMPORT_CONNECTORS.md) */
export type ImportSource = 'notion' | 'backlog' | 'kintone' | 'pleasanter' | 'google_sheets' | 'csv';

/** 取り込み元の位置情報 (エラーメッセージ用)。CSV 経由のみ設定、API 経由は undefined。 */
export interface SourceOrigin {
  /** 取り込み元 CSV のファイル名 */
  file?: string;
  /** CSV のデータ行番号 (1 始まり、ヘッダ行を除く) */
  row?: number;
}

export interface NormalizedCustomer {
  /** バッチ内一意キー (子からの参照に使う)。多くは顧客名 or ソース ID */
  sourceKey: string;
  name: string;
  department?: string | null;
  contactPerson?: string | null;
  contactEmail?: string | null;
  notes?: string | null;
  origin?: SourceOrigin;
}

export interface NormalizedRiskIssue {
  type: 'risk' | 'issue';
  title?: string;
  occurrence?: string | null;
  content?: string | null;
  cause?: string | null;
  impact?: string; // 生値。resolveImpact で内部値化
  likelihood?: string | null;
  responsePolicy?: string | null;
  deadline?: string | null; // 生値。normalizeDate で正規化
  riskNature?: string | null;
  visibility?: string; // 生値。resolveVisibility で内部値化 (既定 draft)
  // 結果(result)・優先度(priority) は対象外 (ADR-0034)
  origin?: SourceOrigin;
}

export interface NormalizedKnowledge {
  title?: string;
  knowledgeType?: string; // 生値。resolveKnowledgeType
  background?: string | null;
  content?: string | null;
  result?: string | null;
  visibility?: string; // 生値。resolveVisibility
  origin?: SourceOrigin;
}

export interface NormalizedRetrospective {
  conductedDate?: string | null; // 生値。normalizeDate。空は当日補完 (取り込み経路)
  planSummary?: string | null;
  actualSummary?: string | null;
  goodPoints?: string | null;
  problems?: string | null;
  improvements?: string | null;
  visibility?: string; // 生値。resolveVisibility
  origin?: SourceOrigin;
}

export interface NormalizedProject {
  sourceKey: string;
  /** 紐づく顧客のバッチ内キー (NormalizedCustomer.sourceKey)。同バッチ or 既存顧客で解決 */
  customerRef?: string | null;
  /** 顧客名の既定値 (マッピングの「既定値」)。customerRef が未解決のときのフォールバック先 */
  customerRefDefault?: string | null;
  name: string;
  purpose?: string;
  background?: string;
  scope?: string;
  devMethod?: string; // 生値。resolveDevMethod (既定 other)
  contractType?: string | null; // 生値。resolveContractType
  status?: string; // 生値。resolveProjectStatus (既定 planning)
  plannedStartDate?: string | null; // 生値。normalizeDate (必須)
  plannedEndDate?: string | null;
  /** WBS (前順序 + レベル)。WP/ACT は構造判定済 */
  wbs: WbsRow[];
  risks: NormalizedRiskIssue[];
  knowledge: NormalizedKnowledge[];
  retros: NormalizedRetrospective[];
  origin?: SourceOrigin;
}

/**
 * バッチ内にプロジェクトが無い WBS グループ。
 * projectName が「同バッチのプロジェクト」に無いが、**既存プロジェクト**に紐づく可能性がある
 * WBS を退避する (プレビューで既存プロジェクトと名前照合し、無ければエラー)。ADR-0034 §2。
 */
export interface ExternalWbsGroup {
  /** 所属プロジェクト名 (既存プロジェクトと照合する) */
  projectName: string;
  /** プロジェクト名の既定値 (マッピングの「既定値」)。projectName が未解決のときのフォールバック先 */
  projectNameDefault?: string | null;
  /** 代表 origin (最初の行。エラー表示用) */
  origin?: SourceOrigin;
  /** 階層変換済みの WBS 行 */
  rows: WbsRow[];
}

/**
 * 取り込み 1 バッチの全データ。
 * customers / projects は自己完結 (親は同バッチ内 sourceKey で解決)。
 * テナント直下のナレッジ等も、現状はプロジェクト配下に持たせる (プロジェクト未指定取り込みは
 * customerRef/プロジェクト無しの扱いを取り込み経路で決定)。
 */
/**
 * バッチにプロジェクトが無い資産 (リスク・課題/ナレッジ/振り返り)。
 * projectName が空 = プロジェクト紐づけなし (standalone)、非空 = 既存プロジェクトに名前照合。
 * RiskIssue/Retrospective.projectId は nullable、Knowledge はテナント直下のため standalone 可。
 */
export interface ExternalAsset<T> {
  /** 所属プロジェクト名 (空 = standalone) */
  projectName: string;
  /** プロジェクト名の既定値 (未解決時のフォールバック先) */
  projectNameDefault?: string | null;
  origin?: SourceOrigin;
  data: T;
}

/** CSV パースで確定した WBS レベルの不正 (数字でない/空)。プレビューで errors に合流。 */
export interface WbsLevelError {
  /** 所属プロジェクト名 (エラー識別子) */
  projectName: string;
  /** 取り込み元の位置 (ファイル名・行番号) */
  origin?: SourceOrigin;
  /** 入力されていた生のレベル値 */
  rawLevel: string;
}

/**
 * CSV パースで確定した WBS 予定工数(人時)の不正。プレビューで errors に合流。
 * 工数は「小数第一位までの 0 以上の数値」のみ許容 (手動入力フォームと整合)。
 */
export interface WbsEffortError {
  /** 所属プロジェクト名 (エラー識別子) */
  projectName: string;
  /** 取り込み元の位置 (ファイル名・行番号) */
  origin?: SourceOrigin;
  /** 入力されていた生の工数値 */
  rawEffort: string;
}

/**
 * プルダウン項目が選択肢外、または日付項目が YYYY-MM-DD 書式でない値の不正。
 * CSV パース段階で確定し、プレビューで errors に合流する (csv-to-batch が reason まで生成)。
 * 対象: リスク・課題 / ナレッジ / 振り返り の 種別・影響度/重要度・発生可能性/緊急度・
 *       脅威/好機・公開範囲・日付 (期限・実施日) 等。
 */
export interface ImportValueError {
  /** エンティティ種別 (列ラベル解決に使う) */
  entity: ImportEntityKind;
  /** 行/エンティティの識別子 (件名・タイトル等) */
  ref: string;
  /** たすきば内部フィールド名 (= 列ラベル解決キー) */
  field: string;
  /** 取り込み元の位置 (ファイル名・行番号) */
  origin?: SourceOrigin;
  /** 何が問題で、どう直すか (選択肢一覧 or YYYY-MM-DD 形式) */
  reason: string;
}

export interface NormalizedBatch {
  source: ImportSource;
  customers: NormalizedCustomer[];
  projects: NormalizedProject[];
  /** 同バッチにプロジェクトが無い WBS (既存プロジェクトに紐づく可能性。プレビューで照合) */
  externalWbs: ExternalWbsGroup[];
  /** バッチにプロジェクトが無いリスク・課題 (空=standalone / 非空=既存照合) */
  externalRisks: ExternalAsset<NormalizedRiskIssue>[];
  /** バッチにプロジェクトが無いナレッジ */
  externalKnowledge: ExternalAsset<NormalizedKnowledge>[];
  /** バッチにプロジェクトが無い振り返り */
  externalRetros: ExternalAsset<NormalizedRetrospective>[];
  /** WBS レベル列が数字でない/空の行 (プレビューでエラー化) */
  wbsLevelErrors: WbsLevelError[];
  /** WBS 予定工数(人時)が小数第一位までの数値でない行 (プレビューでエラー化) */
  wbsEffortErrors: WbsEffortError[];
  /** プルダウン選択肢外 / 日付書式不正の値 (プレビューでエラー化) */
  valueErrors: ImportValueError[];
  /** コネクタ/変換段階で出た警告 (循環・孤児・日付変換等)。プレビュー一覧に表示 */
  warnings: string[];
}

/** 空のバッチを生成 (コネクタの初期値) */
export function emptyBatch(source: ImportSource): NormalizedBatch {
  return {
    source,
    customers: [],
    projects: [],
    externalWbs: [],
    externalRisks: [],
    externalKnowledge: [],
    externalRetros: [],
    wbsLevelErrors: [],
    wbsEffortErrors: [],
    valueErrors: [],
    warnings: [],
  };
}
