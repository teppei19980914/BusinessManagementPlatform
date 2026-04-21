/**
 * 画面遷移パス定数 (PR #81 で集約):
 *
 *   `<Link href="...">` / `router.push(...)` / `redirect(...)` で使う画面ルートを
 *   一箇所に集約する。`src/config/routes.ts` (認可判定用パスリスト) とは別物で、
 *   こちらは「個別画面への遷移」用の定数。
 *
 * 設計判断:
 *   - パスリテラルが画面コードに散在すると、URL 体系を変更したときに大量の
 *     ファイルを横断置換する必要が生じる (例: /projects → /workspace/projects)
 *   - 本ファイルを集約点にすることで、URL 構造変更時は本ファイル 1 箇所の編集で済む
 *   - 動的セグメントを含むパスは関数として提供 (例: `projectDetail(id)`)
 *
 * 命名規則:
 *   - 静的パス: 大文字スネークケース (PROJECTS_PATH 等)
 *   - 動的パス: 関数として提供 (projectDetail / projectGantt 等)
 *
 * 認可判定 (middleware) 用パスは `routes.ts` (PUBLIC_PATHS / MFA_PENDING_PATHS) を参照。
 */

// ---------- 認証関連 (未認証可) ----------

/** ログイン画面。認証失敗時のリダイレクト先でもある (`config/routes.ts` の LOGIN_PATH と同値)。 */
export const LOGIN_ROUTE = '/login';

/** パスワード再設定画面 (リカバリーコード認証)。 */
export const RESET_PASSWORD_ROUTE = '/reset-password';

/** 招待メールから初回パスワード設定する画面 (token クエリ付きで呼ばれる)。 */
export const SETUP_PASSWORD_ROUTE = '/setup-password';

// ---------- ダッシュボード (要認証) ----------

/** プロジェクト一覧画面 (アプリのトップ相当)。 */
export const PROJECTS_ROUTE = '/projects';

/** マイタスク横断画面。 */
export const MY_TASKS_ROUTE = '/my-tasks';

/** 全リスク横断画面。 */
export const ALL_RISKS_ROUTE = '/risks';

/** 全課題横断画面 (PR #60 #1 でリスクと分離)。 */
export const ALL_ISSUES_ROUTE = '/issues';

/** 全振り返り横断画面。 */
export const ALL_RETROSPECTIVES_ROUTE = '/retrospectives';

/** 全ナレッジ横断画面。 */
export const KNOWLEDGE_ROUTE = '/knowledge';

/** 個人メモ画面 (アカウントメニュー → メモ)。 */
export const MEMOS_ROUTE = '/memos';

/** 全メモ横断画面 (visibility=public のみ)。 */
export const ALL_MEMOS_ROUTE = '/all-memos';

/** 設定画面 (テーマ / パスワード変更 / MFA)。 */
export const SETTINGS_ROUTE = '/settings';

// ---------- 管理者専用 ----------

export const ADMIN_USERS_ROUTE = '/admin/users';
export const ADMIN_AUDIT_LOGS_ROUTE = '/admin/audit-logs';
export const ADMIN_ROLE_CHANGES_ROUTE = '/admin/role-changes';

// ---------- 動的パス (パラメータ付き) ----------

/** プロジェクト詳細画面 (概要タブ)。 */
export function projectDetail(projectId: string): string {
  return `/projects/${projectId}`;
}

/** プロジェクト見積もりタブ。 */
export function projectEstimates(projectId: string): string {
  return `/projects/${projectId}/estimates`;
}

/** プロジェクト WBS / タスク管理タブ。 */
export function projectTasks(projectId: string): string {
  return `/projects/${projectId}/tasks`;
}

/** プロジェクトガントチャートタブ。 */
export function projectGantt(projectId: string): string {
  return `/projects/${projectId}/gantt`;
}

/** プロジェクトリスクタブ。 */
export function projectRisks(projectId: string): string {
  return `/projects/${projectId}/risks`;
}

/** プロジェクト課題タブ (type=issue)。 */
export function projectIssues(projectId: string): string {
  return `/projects/${projectId}/issues`;
}

/** プロジェクト振り返りタブ。 */
export function projectRetrospectives(projectId: string): string {
  return `/projects/${projectId}/retrospectives`;
}

/** プロジェクトナレッジタブ。 */
export function projectKnowledge(projectId: string): string {
  return `/projects/${projectId}/knowledge`;
}
