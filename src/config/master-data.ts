/**
 * マスタデータ定数 (PR #75 Phase 1):
 *
 *   業務概念の列挙値 (ステータス / 優先度 / 公開範囲 等) を単一の真実として管理する。
 *   UI 表示・Zod 検証・DB 投入のいずれからもここを参照する。
 *
 * 設計原則:
 *   - キーは DB に格納する英数字、値は画面に表示する日本語ラベル
 *   - `as const` でキーの型を厳密化し、`keyof typeof X` で型を得る
 *   - `src/types/index.ts` は後方互換のため本ファイルを再エクスポートする
 *
 * 値を追加するときは本ファイル 1 箇所を編集すれば、型検査で呼び出し側の網羅性を担保できる。
 */

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

// ============================================================
// Stakeholder Management (PMBOK 13)
// ============================================================

/**
 * ステークホルダーの姿勢 (Attitude / Stance)。
 *   - supportive: 賛成 (推進派、味方)
 *   - neutral   : 中立 (態度未表明 / 状況依存)
 *   - opposing  : 反対 (抵抗勢力)
 *
 * 同じ Power/Interest 象限でも姿勢で対応戦略が変わる:
 *   例: 「影響大 × 関心大 × 賛成」=主要パートナー、「同 × 反対」=最警戒。
 */
export const STAKEHOLDER_ATTITUDES = {
  supportive: '賛成',
  neutral: '中立',
  opposing: '反対',
} as const;

export type StakeholderAttitude = keyof typeof STAKEHOLDER_ATTITUDES;

/**
 * ステークホルダーのエンゲージメント水準 (PMBOK 13.1.2 Engagement Assessment Matrix)。
 *
 * 「現在のエンゲージメント (current)」と「望ましいエンゲージメント (desired)」を
 * 個別に持たせ、Gap がある人 = 能動的働きかけが必要な人として PM が抽出できる。
 *
 *   - unaware   : プロジェクトを認識していない
 *   - resistant : 抵抗的 (変化に反対)
 *   - neutral   : 中立 (賛否どちらでもない)
 *   - supportive: 支持的 (賛成しているが受動的)
 *   - leading   : 主導的 (能動的に推進している)
 */
export const STAKEHOLDER_ENGAGEMENTS = {
  unaware: '認識していない',
  resistant: '抵抗的',
  neutral: '中立',
  supportive: '支持的',
  leading: '主導的',
} as const;

export type StakeholderEngagement = keyof typeof STAKEHOLDER_ENGAGEMENTS;

const ENGAGEMENT_ORDER: StakeholderEngagement[] = [
  'unaware', 'resistant', 'neutral', 'supportive', 'leading',
];

/**
 * Engagement Gap を整数で返す (desired - current)。
 *   正の値: 強める方向の働きかけが必要 (例: neutral→supportive で gap=+1)
 *   負の値: 抑える方向 (例: leading→supportive で gap=-1)
 *   ゼロ  : 望ましい状態にある
 */
export function calcEngagementGap(
  current: StakeholderEngagement,
  desired: StakeholderEngagement,
): number {
  return ENGAGEMENT_ORDER.indexOf(desired) - ENGAGEMENT_ORDER.indexOf(current);
}

/**
 * Power/Interest grid の 4 象限 (Mendelow's Matrix, PMBOK 13)。
 *   - manage_closely : 影響大 × 関心大 — 密接に連携 (Manage Closely)
 *   - keep_satisfied : 影響大 × 関心小 — 満足させておく (Keep Satisfied)
 *   - keep_informed  : 影響小 × 関心大 — 常に情報を伝える (Keep Informed)
 *   - monitor        : 影響小 × 関心小 — モニタリング (Monitor)
 */
export const STAKEHOLDER_QUADRANTS = {
  manage_closely: '密接に連携',
  keep_satisfied: '満足させておく',
  keep_informed: '常に情報を伝える',
  monitor: 'モニタリング',
} as const;

export type StakeholderQuadrant = keyof typeof STAKEHOLDER_QUADRANTS;

/**
 * 影響度 / 関心度 (1-5) から Power/Interest grid の象限を分類する。
 * 閾値: >= 4 を「大」、それ以外を「小」とする (中央値 3 は「小」寄り扱い)。
 */
export function classifyStakeholderQuadrant(
  influence: number,
  interest: number,
): StakeholderQuadrant {
  const highInfluence = influence >= 4;
  const highInterest = interest >= 4;
  if (highInfluence && highInterest) return 'manage_closely';
  if (highInfluence && !highInterest) return 'keep_satisfied';
  if (!highInfluence && highInterest) return 'keep_informed';
  return 'monitor';
}

/**
 * 影響度 / 関心度の許容範囲 (1-5)。validator と UI 双方が参照する。
 */
export const STAKEHOLDER_LEVEL_MIN = 1;
export const STAKEHOLDER_LEVEL_MAX = 5;
