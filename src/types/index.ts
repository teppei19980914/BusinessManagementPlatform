// マスタデータ定数
// 設計書: DESIGN.md セクション 13.2

export const DEV_METHODS = {
  scratch: 'スクラッチ開発',
  power_platform: 'PowerPlatform',
  package: 'パッケージ導入',
  other: 'その他',
} as const;

export type DevMethod = keyof typeof DEV_METHODS;

export const TASK_CATEGORIES = {
  requirements: '要件定義',
  design: '設計',
  development: '開発',
  testing: '試験',
  review: 'レビュー',
  management: '管理',
  other: 'その他',
} as const;

export type TaskCategory = keyof typeof TASK_CATEGORIES;

export const KNOWLEDGE_TYPES = {
  research: '調査',
  verification: '検証',
  incident: '障害対応',
  decision: '意思決定',
  lesson: '教訓',
  best_practice: 'ベストプラクティス',
  other: 'その他',
} as const;

export type KnowledgeType = keyof typeof KNOWLEDGE_TYPES;

export const PROJECT_STATUSES = {
  planning: '企画中',
  estimating: '見積中',
  scheduling: '計画中',
  executing: '実行中',
  completed: '完了',
  retrospected: '振り返り完了',
  closed: 'クローズ',
} as const;

export type ProjectStatus = keyof typeof PROJECT_STATUSES;

export const WBS_TYPES = {
  work_package: 'ワークパッケージ',
  activity: 'アクティビティ',
} as const;

export type WbsType = keyof typeof WBS_TYPES;

export const TASK_STATUSES = {
  not_started: '未着手',
  in_progress: '進行中',
  completed: '完了',
  on_hold: '保留',
} as const;

export type TaskStatus = keyof typeof TASK_STATUSES;

export const PRIORITIES = {
  low: '低',
  medium: '中',
  high: '高',
} as const;

export type Priority = keyof typeof PRIORITIES;

export const RISK_ISSUE_STATES = {
  open: '未対応',
  in_progress: '対応中',
  monitoring: '監視中',
  resolved: '解消',
} as const;

export type RiskIssueState = keyof typeof RISK_ISSUE_STATES;

/**
 * 公開範囲 (PR #60 で 2 値体系に統合)
 *   - draft : 下書き = 作成者 + admin のみ閲覧可
 *   - public: 公開   = 全ログインユーザが閲覧可
 * 従来の project/company は migration で全て public に集約済 (20260418 migration)。
 * リスク/課題、振り返り、ナレッジの 3 エンティティ共通で使用。
 */
export const VISIBILITIES = {
  draft: '下書き',
  public: '公開',
} as const;

export type Visibility = keyof typeof VISIBILITIES;

/**
 * リスクの脅威/好機分類 (PR #60)。
 *   - threat     : 脅威 (ネガティブ事象、従来のリスク概念)
 *   - opportunity: 好機 (ポジティブ事象、PMBOK ガイド 第 7 版 の「機会」)
 * 課題 (issue) では使用しない。type='risk' 時のみ UI で表示 / 保存する。
 */
export const RISK_NATURES = {
  threat: '脅威',
  opportunity: '好機',
} as const;

export type RiskNature = keyof typeof RISK_NATURES;

export const SYSTEM_ROLES = {
  admin: 'システム管理者',
  general: '一般ユーザ',
} as const;

export type SystemRole = keyof typeof SYSTEM_ROLES;

export const PROJECT_ROLES = {
  pm_tl: 'PM/TL',
  member: 'メンバー',
  viewer: '閲覧者',
} as const;

export type ProjectRole = keyof typeof PROJECT_ROLES;

export const EFFORT_UNITS = {
  person_hour: '人時',
  person_day: '人日',
} as const;

export type EffortUnit = keyof typeof EFFORT_UNITS;
