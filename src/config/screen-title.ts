/**
 * 画面タイトル解決 (feat/collapsed-nav-screen-title, 2026-06-05):
 *
 * 役割:
 *   現在の pathname から「画面名」に対応する i18n キー (`nav` namespace) を返す。
 *   ヘッダのナビが常時グループ dropdown のため、現在どの画面を開いて
 *   いるかが分かりにくい場合がある。画面上部に画面名を表示する用途で使う (CollapsedNavScreenTitle)。
 *
 * 設計:
 *   - ラベルは `nav` namespace を再利用する (新規 i18n キーを作らず drift を避ける)。
 *   - 解決ルールは「長い prefix を先に評価」する longest-prefix-match。
 *   - 該当する画面が無い場合は null を返す (= 画面名を表示しない)。
 *   - プロジェクト: 一覧 (`/projects`) は `allProjects`、詳細・タブ (`/projects/[id]...`) は
 *     エリアラベル `groupProjects` ("プロジェクト") を返す (詳細画面はプロジェクト名を別途表示するため)。
 */

/** `pathname` が `prefix` 自身、または `prefix/...` で始まるか (セグメント境界で判定)。 */
function startsWithSegment(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

/**
 * 評価順 = 配列順 (長い prefix を先に置く)。値は `nav` namespace のキー。
 * `/settings/tenant` を `/settings` より先に置くなど、より具体的なものを上に並べる。
 */
const SCREEN_TITLE_RULES: ReadonlyArray<{ prefix: string; navKey: string }> = [
  { prefix: '/settings/tenant', navKey: 'tenantSettings' }, // 請求履歴 (/settings/tenant/billing) 含む
  { prefix: '/settings', navKey: 'settings' },
  { prefix: '/admin/super/tenants', navKey: 'superAdminTenants' },
  { prefix: '/admin/super/usage', navKey: 'superAdminUsage' },
  { prefix: '/admin/super', navKey: 'superAdminDashboard' },
  { prefix: '/admin/users', navKey: 'adminUsers' },
  { prefix: '/admin/audit-logs', navKey: 'adminAuditLogs' },
  { prefix: '/admin/role-changes', navKey: 'adminRoleChanges' },
  { prefix: '/my-tasks', navKey: 'myTasks' },
  { prefix: '/risks', navKey: 'allRisks' },
  { prefix: '/issues', navKey: 'allIssues' },
  { prefix: '/retrospectives', navKey: 'allRetrospectives' },
  { prefix: '/knowledge', navKey: 'allKnowledge' },
  { prefix: '/all-memos', navKey: 'allMemos' },
  { prefix: '/memos', navKey: 'memos' },
  { prefix: '/customers', navKey: 'allCustomers' },
  { prefix: '/guide', navKey: 'guide' },
  { prefix: '/help', navKey: 'help' },
  { prefix: '/changelog', navKey: 'versionInfo' },
];

/**
 * pathname から画面名に対応する `nav` namespace のキーを返す。該当なしは null。
 * 呼出側 (CollapsedNavScreenTitle) は `useTranslations('nav')` で文言化する。
 */
export function getScreenTitleNavKey(pathname: string): string | null {
  // プロジェクト: 詳細・タブ (/projects/[id]...) と 一覧 (/projects) を分ける。
  if (pathname.startsWith('/projects/')) return 'groupProjects';
  if (pathname === '/projects') return 'allProjects';

  for (const { prefix, navKey } of SCREEN_TITLE_RULES) {
    if (startsWithSegment(pathname, prefix)) return navKey;
  }
  return null;
}
