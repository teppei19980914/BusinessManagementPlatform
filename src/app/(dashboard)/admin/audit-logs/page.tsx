import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { prisma } from '@/lib/db';
// PR #117 → PR #119: session 連携フォーマッタ (ユーザ個別 TZ/locale を反映)
import { getServerFormatters } from '@/lib/server-formatters';
import { isAdminOrAbove } from '@/lib/permissions';
import { AuditLogsTable, type AuditLogRow } from './audit-logs-table';

// 2026-06-03: 画面から選べる表示件数 (取得上限)。?limit= で URL 永続化。既定 300。'all' = 全件。
const AUDIT_LOG_LIMIT_OPTIONS = ['100', '300', '1000', 'all'] as const;
const DEFAULT_AUDIT_LOG_LIMIT = '300';

export default async function AuditLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ limit?: string }>;
}) {
  const session = await auth();
  // feat/crud-permission-redesign (2026-05-20): API 側の requireAdmin (admin + super_admin) と整合。
  //   旧実装は `=== 'admin'` 厳密比較で super_admin が UI に到達できなかった (UI/API ズレ)。
  if (!session || !isAdminOrAbove(session.user)) redirect('/');

  const t = await getTranslations('admin.auditLogs');
  const { formatDateTimeFull } = await getServerFormatters();

  // 2026-06-03: 表示件数は ?limit= から取得 (許可値のみ採用、不正値は既定 300)。'all' は take なし (全件)。
  const sp = await searchParams;
  const limitParam: string = (AUDIT_LOG_LIMIT_OPTIONS as readonly string[]).includes(sp.limit ?? '')
    ? (sp.limit as string)
    : DEFAULT_AUDIT_LOG_LIMIT;
  const take = limitParam === 'all' ? undefined : Number(limitParam);

  // 2026-05-10 Phase 2-10: AuditLog 直接 tenantId 列で絞込み (旧 user join 経由フィルタから移行)。
  //   User 物理削除後の宙ぶらりんログにも追従でき、indexed lookup で高速。
  const logs = await prisma.auditLog.findMany({
    where: { tenantId: session.user.tenantId },
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    ...(take != null ? { take } : {}),
  });

  // PR feat/sortable-columns: client component (sortable) に渡せるよう plain object に整形。
  // formatDateTimeFull は session TZ を参照するため server 側で実行する必要がある。
  // 2026-06-03: 操作種別・対象種別の表示はロケールに合わせて翻訳 (例: UPDATE→更新 / knowledge→ナレッジ)。
  //   未定義のキーは生値にフォールバック (t.has で存在確認してから翻訳)。
  const localizeAction = (action: string): string =>
    t.has(`actionLabels.${action}`) ? t(`actionLabels.${action}`) : action;
  const localizeEntity = (entityType: string): string =>
    t.has(`entityLabels.${entityType}`) ? t(`entityLabels.${entityType}`) : entityType;

  // 2026-06-03: 監査 JSON (afterValue 優先 / DELETE は beforeValue) から派生情報を取り出す。
  const jsonOf = (log: (typeof logs)[number]): Record<string, unknown> => {
    const v = (log.afterValue ?? log.beforeValue) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  };
  // #1: risk_issue (リスク・課題 共通テーブル) は JSON の type で「リスク」「課題」に振り分けて行表示する。
  const entityKeyOf = (log: (typeof logs)[number]): string => {
    if (log.entityType === 'risk_issue' || log.entityType === 'risk_issue_project') {
      const t = jsonOf(log).type;
      if (t === 'risk') return 'risk';
      if (t === 'issue') return 'issue';
    }
    return log.entityType;
  };
  // 2026-06-03: 添付 (リンク/ファイル) は「どの画面で行われたか」を示す。
  //   対象 = 親エンティティ種別 (リスク/ナレッジ等)、操作 = リンク追加/削除・ファイル添付/削除。
  const isAttachment = (log: (typeof logs)[number]): boolean => log.entityType === 'attachment';
  const attachmentIsFile = (log: (typeof logs)[number]): boolean =>
    jsonOf(log).storageProvider === 'supabase';
  // 対象 (entityDisplay): 添付は親種別、risk_issue は type で振り分け、それ以外は通常翻訳。
  const entityDisplayOf = (log: (typeof logs)[number]): string => {
    if (isAttachment(log)) {
      const parent = jsonOf(log).parentEntityType;
      if (typeof parent === 'string' && t.has(`entityLabels.${parent}`)) return t(`entityLabels.${parent}`);
      return localizeEntity('attachment'); // 旧ログ (親種別未記録) は汎用「添付」
    }
    return localizeEntity(entityKeyOf(log));
  };
  // 操作 (actionDisplay): 添付は「リンク/ファイル × 追加/更新/削除」に区別、それ以外は通常翻訳。
  const actionDisplayOf = (log: (typeof logs)[number]): string => {
    if (isAttachment(log)) {
      const file = attachmentIsFile(log);
      if (log.action === 'CREATE') return t(file ? 'attachmentActions.fileAdd' : 'attachmentActions.linkAdd');
      if (log.action === 'DELETE') return t(file ? 'attachmentActions.fileRemove' : 'attachmentActions.linkRemove');
      if (log.action === 'UPDATE') return t(file ? 'attachmentActions.fileUpdate' : 'attachmentActions.linkUpdate');
    }
    return localizeAction(log.action);
  };
  // 対象名: 添付は内容を記録しないため空 (「—」表示)。それ以外は JSON から name/title 等を推定。
  const targetNameOf = (log: (typeof logs)[number]): string => {
    if (isAttachment(log)) return '';
    const j = jsonOf(log);
    for (const key of ['name', 'title', 'fileName', 'email'] as const) {
      const v = j[key];
      if (typeof v === 'string' && v.trim().length > 0) return v;
    }
    return '';
  };

  const rows: AuditLogRow[] = logs.map((log) => ({
    id: log.id,
    createdAtIso: log.createdAt.toISOString(),
    createdAtDisplay: formatDateTimeFull(log.createdAt.toISOString()),
    userName: log.user.name,
    action: log.action,
    actionDisplay: actionDisplayOf(log),
    entityDisplay: entityDisplayOf(log),
    targetName: targetNameOf(log),
  }));

  return (
    <div className="space-y-6">
      <AuditLogsTable
        logs={rows}
        currentLimit={limitParam}
        limitOptions={[...AUDIT_LOG_LIMIT_OPTIONS]}
        // 'all' でなく、取得件数が上限に達している場合のみ「最新N件まで」を表示
        isCapped={take != null && logs.length >= take}
      />
    </div>
  );
}
