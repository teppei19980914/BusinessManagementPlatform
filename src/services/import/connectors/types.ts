/**
 * 外部移行インポート — APIコネクタ共通契約 (ADR-0034 / IMPORT_CONNECTORS.md)
 *
 * 設計の要:
 *   - コネクタの責務は「相手サービスのデータを取得し、既存CSV経路が食える CsvEntitySource[]
 *     (フラットな文字列行 + 列マッピング) に正規化する」ことだけ。
 *     検証・値解決・WBS階層復元・依存解決・取り込みは既存 import 基盤
 *     (csv-to-batch / batch-preview / batch-apply) を**丸ごと再利用**する。
 *     → 既存パイプラインへの改変ゼロ = デグレ面ゼロ。
 *   - 副作用 (HTTP fetch) と純変換 (records → CsvEntitySource) を分離する。
 *     純変換は各コネクタが個別に export し、HTTP を叩かず決定的に単体テストする。
 *   - 認証情報 (ConnectorAuth) は取得の数秒だけメモリ保持し、処理直後に破棄する
 *     (永続保存しない。ADR-0034 §9 の「取得後即破棄」)。
 */

import type { CsvEntitySource } from '../csv-to-batch';
import type { ImportEntityKind, ImportSource } from '../normalized-batch';

/**
 * ユーザが入力する接続情報。サーバ側で取得の数秒だけ保持し、処理直後に破棄する。
 * ベースURL / サブドメインは推測せず**必ずユーザ入力**で受ける (IMPORT_CONNECTORS.md §0-2)。
 */
export interface ConnectorAuth {
  /** API キー / 統合トークン / ApiKey 等 (サービスにより意味が異なる) */
  token: string;
  /**
   * ベースURL or サブドメイン (ユーザ入力で吸収)。
   *   - Backlog: `https://xxx.backlog.com` / `.jp` / `.backlogtool.com`
   *   - kintone: `https://xxx.kintone.com` / `.cybozu.com`
   *   - Pleasanter: オンプレ `https://host` / クラウド `https://pleasanter.net/fs`
   *   - Notion / Sheets: 固定ベースのため空でよい
   */
  baseUrl?: string;
  /** サービス固有の追加認証 (kintone の横断参照トークン カンマ連結など) */
  extra?: Record<string, string>;
}

/** discover が返す項目定義 (マッピングUIの「ソース項目」候補になる)。 */
export interface DiscoveredField {
  /** ソース側のキー (Notion property 名 / kintone フィールドコード / 列名 / Backlog フィールド名) */
  key: string;
  /** 画面表示用ラベル */
  label: string;
  /** 型ヒント (UI 表示・並べ替え用。'text'|'number'|'date'|'select'|'multi_select'|'user'|'relation'|'unknown') */
  type?: string;
}

/** discover が返す「取得元」1件 (Notion DB / Backlog プロジェクト / kintone アプリ / Pleasanter サイト / Sheets タブ)。 */
export interface DiscoveredSource {
  /** サービス内の安定ID (data_source_id / projectId / appId / siteId / シート名) */
  id: string;
  /** 表示名 */
  name: string;
  /** マッピングUIの列候補になる項目定義。自由構造サービスで特に重要 */
  fields: DiscoveredField[];
  /** この取得元が向くエンティティのヒント (任意。例: Pleasanter Issues→wbs) */
  entityHint?: ImportEntityKind;
}

/** discover の結果。サービス内の取得元一覧 + 各項目定義。 */
export interface DiscoveredSchema {
  source: ImportSource;
  sources: DiscoveredSource[];
  /** 接続確認・権限・共有漏れ等の注意 (UI に警告表示)。 */
  warnings: string[];
}

/**
 * 1つの取得元を、たすきばの1エンティティへ対応づけるマッピング。
 * columnMap / fixedMap は既存CSV経路の {@link CsvEntitySource} と完全に同義
 * (= マッピングUI・検証・値解決を共通化できる)。
 */
export interface SourceMapping {
  /** discover の {@link DiscoveredSource.id} */
  sourceId: string;
  /** 取り込み先エンティティ種別 */
  entity: ImportEntityKind;
  /** たすきば内部フィールド名 → ソース項目キー (CSV の columnMap と同義)。 */
  columnMap: Record<string, string>;
  /** たすきば内部フィールド名 → 既定値 (CSV の fixedMap と同義。空欄のフォールバック)。 */
  fixedMap?: Record<string, string>;
  /**
   * WBS 階層: 親レコードを指すソース項目キー (Pleasanter ClassX / kintone 親キー等)。
   * Notion sub-item relation / Backlog parentIssueId のように構造が固定のサービスでは未使用。
   */
  parentKey?: string;
  /**
   * サービス固有の振り分けオプション。
   *   - Backlog: { wbsIssueTypeIds: number[] }(WBSとして扱う issueType.id)
   *   - 他: 必要に応じて拡張
   */
  options?: Record<string, unknown>;
}

/** ウィザードで確定したマッピング全体 (複数の取得元 → 複数エンティティ)。 */
export interface ConnectorMapping {
  mappings: SourceMapping[];
}

/**
 * APIコネクタの共通契約。
 *   discover    : 接続して取得元一覧 + 項目定義を返す (副作用)。トークンは呼出直後に破棄。
 *   fetchSources: マッピングに従い全件取得し、既存CSV経路が食う CsvEntitySource[] に正規化 (副作用)。
 *
 * 各コネクタは内部で「fetch (生レコード取得)」と「pure transform (生レコード → CsvEntitySource[])」を
 * 分離し、後者を個別に export して単体テストする。
 */
export interface MigrationConnector {
  readonly source: ImportSource;
  discover(auth: ConnectorAuth): Promise<DiscoveredSchema>;
  fetchSources(auth: ConnectorAuth, mapping: ConnectorMapping): Promise<CsvEntitySource[]>;
}

/** ImportSource のうち API 取得を伴うもの (csv を除く)。 */
export type ApiImportSource = Exclude<ImportSource, 'csv'>;
