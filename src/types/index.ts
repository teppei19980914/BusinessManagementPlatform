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

export const VISIBILITIES = {
  draft: '下書き',
  project: 'プロジェクト限定',
  company: '社内公開',
} as const;

export type Visibility = keyof typeof VISIBILITIES;

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
