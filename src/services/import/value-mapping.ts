/**
 * 外部移行インポート — 選択項目の値マッピング (ADR-0034)
 *
 * 役割:
 *   外部ソース (CSV/API) の選択値を、たすきばの内部値へ正規化する。
 *   - 表示ラベル (例 "下書き") でも内部値 (例 "draft") でも受け付ける
 *   - 前後空白・大文字小文字を無視
 *   - 不正値・空欄はその項目の既定値へ (公開範囲は draft = 「誤データは全て下書き」ADR-0034 §4)
 *
 * 単一の真実は src/config/master-data.ts。本モジュールはそこから逆引き表を構築するだけで、
 * 値の追加は master-data.ts 1 箇所で完結する。
 */

import {
  VISIBILITIES,
  PROJECT_STATUSES,
  DEV_METHODS,
  CONTRACT_TYPES,
  IMPACT_LEVELS,
  RISK_NATURES,
  RISK_ISSUE_TYPES,
  KNOWLEDGE_TYPES,
} from '@/config/master-data';

/** 比較用に正規化 (前後空白除去 + 小文字化)。日本語ラベルは小文字化の影響を受けない。 */
function normalize(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/**
 * master-data の {内部キー: 表示ラベル} から「内部キー or 表示ラベル → 内部キー」の逆引き関数を作る。
 * 一致しなければ null を返す (呼び出し側で既定値 or null を決める)。
 */
function buildResolver<T extends string>(map: Record<T, string>): (raw: unknown) => T | null {
  const lookup = new Map<string, T>();
  for (const key of Object.keys(map) as T[]) {
    lookup.set(normalize(key), key); // 内部キーを受け付ける
    lookup.set(normalize(map[key]), key); // 表示ラベルを受け付ける
  }
  return (raw: unknown): T | null => {
    const n = normalize(raw);
    if (n === '') return null;
    return lookup.get(n) ?? null;
  };
}

const visibilityResolver = buildResolver(VISIBILITIES);
const projectStatusResolver = buildResolver(PROJECT_STATUSES);
const devMethodResolver = buildResolver(DEV_METHODS);
const contractTypeResolver = buildResolver(CONTRACT_TYPES);
const impactResolver = buildResolver(IMPACT_LEVELS);
const riskNatureResolver = buildResolver(RISK_NATURES);
const riskTypeResolver = buildResolver(RISK_ISSUE_TYPES);
const knowledgeTypeResolver = buildResolver(KNOWLEDGE_TYPES);

export type Visibility = keyof typeof VISIBILITIES;
export type ProjectStatus = keyof typeof PROJECT_STATUSES;
export type DevMethod = keyof typeof DEV_METHODS;
export type ContractType = keyof typeof CONTRACT_TYPES;
export type ImpactLevel = keyof typeof IMPACT_LEVELS;
export type RiskNature = keyof typeof RISK_NATURES;
export type RiskIssueType = keyof typeof RISK_ISSUE_TYPES;
export type KnowledgeType = keyof typeof KNOWLEDGE_TYPES;

/**
 * 公開範囲。不正値・空欄は 'draft' (下書き)。
 * ADR-0034: 誤ったデータは全て下書きで作成し、取り込みを止めない。
 */
export function resolveVisibility(raw: unknown): Visibility {
  return visibilityResolver(raw) ?? 'draft';
}

/** プロジェクトステータス。不正値・空欄は 'planning' (企画中)。 */
export function resolveProjectStatus(raw: unknown): ProjectStatus {
  return projectStatusResolver(raw) ?? 'planning';
}

/** 開発方式 (必須項目)。不正値・空欄は 'other' (そのほか)。 */
export function resolveDevMethod(raw: unknown): DevMethod {
  return devMethodResolver(raw) ?? 'other';
}

/** 契約形態 (任意)。不正値・空欄は null (= 未設定)。 */
export function resolveContractType(raw: unknown): ContractType | null {
  return contractTypeResolver(raw);
}

/**
 * 開発方式が「空 or 既知の値」か。空は許容 (プレビューで既定値補完)、
 * 非空かつ未知の値のみ false (= プレビューでエラー表示)。
 */
export function isKnownDevMethod(raw: unknown): boolean {
  return normalize(raw) === '' || devMethodResolver(raw) !== null;
}

/** 契約形態が「空 or 既知の値」か。判定基準は {@link isKnownDevMethod} と同じ。 */
export function isKnownContractType(raw: unknown): boolean {
  return normalize(raw) === '' || contractTypeResolver(raw) !== null;
}

/** プロジェクトステータスが「空 or 既知の値」か。判定基準は {@link isKnownDevMethod} と同じ。 */
export function isKnownProjectStatus(raw: unknown): boolean {
  return normalize(raw) === '' || projectStatusResolver(raw) !== null;
}

/** 影響度 / 重要度。不正値・空欄は 'medium' (中)。 */
export function resolveImpact(raw: unknown): ImpactLevel {
  return impactResolver(raw) ?? 'medium';
}

/** 発生可能性 / 緊急度 (任意)。不正値・空欄は null。 */
export function resolveLikelihood(raw: unknown): ImpactLevel | null {
  return impactResolver(raw);
}

/** 脅威 / 好機 (リスクのみ・任意)。不正値・空欄は null。 */
export function resolveRiskNature(raw: unknown): RiskNature | null {
  return riskNatureResolver(raw);
}

/** ナレッジ種別。不正値・空欄は 'other' (その他)。 */
export function resolveKnowledgeType(raw: unknown): KnowledgeType {
  return knowledgeTypeResolver(raw) ?? 'other';
}

/** リスク/課題の種別。不正値・空欄は 'issue' (課題)。 */
export function resolveRiskType(raw: unknown): RiskIssueType {
  return riskTypeResolver(raw) ?? 'issue';
}

// ---- B群 (リスク・課題 / ナレッジ / 振り返り) のプルダウン検証 ----
//   「空 or 既知の値」のみ true。非空かつ未知の値のみ false (= プレビューでエラー表示)。
//   空を許容するのは A群 (プロジェクト) と同じく「マッピング画面の既定値で補完できる」ため。

/** 公開範囲が「空 or 既知の値」か。 */
export function isKnownVisibility(raw: unknown): boolean {
  return normalize(raw) === '' || visibilityResolver(raw) !== null;
}

/** 影響度 / 重要度 / 発生可能性 / 緊急度が「空 or 既知の値 (高/中/低)」か。 */
export function isKnownImpact(raw: unknown): boolean {
  return normalize(raw) === '' || impactResolver(raw) !== null;
}

/** 脅威 / 好機が「空 or 既知の値」か。 */
export function isKnownRiskNature(raw: unknown): boolean {
  return normalize(raw) === '' || riskNatureResolver(raw) !== null;
}

/** リスク/課題の種別が「空 or 既知の値 (リスク/課題)」か。 */
export function isKnownRiskType(raw: unknown): boolean {
  return normalize(raw) === '' || riskTypeResolver(raw) !== null;
}

/** ナレッジ種別が「空 or 既知の値」か。 */
export function isKnownKnowledgeType(raw: unknown): boolean {
  return normalize(raw) === '' || knowledgeTypeResolver(raw) !== null;
}
