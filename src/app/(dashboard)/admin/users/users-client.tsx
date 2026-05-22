'use client';

/**
 * ユーザ管理画面 (システム管理者専用) のクライアントコンポーネント。
 *
 * 役割:
 *   - 全ユーザの一覧表示 (アクティブ/非アクティブ含む)
 *   - 新規ユーザ発行ダイアログ (検証メール送信)
 *   - 既存ユーザの編集 (氏名 / システムロール / 有効状態)
 *   - リカバリーコード再発行
 *
 * 認可: ページ側 (page.tsx) で systemRole='admin' を確認済の前提。
 * API: /api/admin/users (GET/POST), /api/admin/users/[userId] (PATCH)
 *
 * 関連: SPECIFICATION.md (ユーザ管理画面)
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useListSearchParams } from '@/components/common/use-list-search-params';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
// Phase E 要件 1〜3 (2026-04-29): 共通行クリック部品
import { ClickableRow } from '@/components/common/clickable-row';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import { UserEditDialog } from '@/components/dialogs/user-edit-dialog';
import { SYSTEM_ROLES } from '@/types';
import type { UserDTO } from '@/services/user.service';
import type { TenantPlan } from '@/lib/tenant';
// PR #117 → PR #119: session 連携フォーマッタ (TZ/locale はユーザ設定を反映)
import { useFormatters } from '@/lib/use-formatters';
import { SortableHeader } from '@/components/sort/sortable-header';
import { useMultiSort } from '@/components/sort/use-multi-sort';
import { multiSort } from '@/lib/multi-sort';

type Props = {
  initialUsers: UserDTO[];
  // P-2 (2026-05-08): Beginner プラン席数上限の UI ガード
  tenantPlan: TenantPlan;
  activeUserCount: number;
  beginnerMaxSeats: number;
  // fix/admin-users-defensive-render (2026-05-15): server 側 data 取得が失敗した時に
  //   表示する警告バナーの可否。デフォルト false (= 正常)。
  dataLoadError?: boolean;
  // feat/crud-permission-redesign (2026-05-20 追加要件): 自分自身のロール変更禁止のため、
  //   ログイン中ユーザの id を server から受け取り UserEditDialog へ伝播する。
  currentUserId: string;
  // PR #425 (2026-05-22) KDD §5.X+102: URL ?keyword=xxx 初期値
  initialKeyword?: string;
};

function getUserSortValue(u: UserDTO, columnKey: string): unknown {
  switch (columnKey) {
    case 'name': return u.name;
    case 'email': return u.email;
    case 'role': return u.systemRole;
    case 'status': return u.isActive ? 1 : 0;
    case 'createdAt': return u.createdAt;
    default: return null;
  }
}

export function UsersClient({ initialUsers, tenantPlan, activeUserCount, beginnerMaxSeats, dataLoadError = false, currentUserId, initialKeyword = '' }: Props) {
  const tAction = useTranslations('action');
  const t = useTranslations('admin.users');
  const router = useRouter();
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();
  // PR #119: session 連携フォーマッタ
  const { formatDate, formatDateTimeFull } = useFormatters();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  // PR #59 Req 3: 行クリックで編集ダイアログ
  const [editingUser, setEditingUser] = useState<UserDTO | null>(null);
  // PR #85: ロック判定用の「今」スナップショット。
  // Date.now() は render 中に呼べない (react-hooks/purity)。マウント時 1 回の評価で、
  // ユーザ一覧画面を開いている間にロック表示が自動で切り替わる必要はない想定。
  const [nowAtMount] = useState(() => Date.now());

  // PR feat/sortable-columns (2026-05-01): カラムソート (sessionStorage 永続化、複数列対応)
  const { sortState, setSortColumn } = useMultiSort('sort:admin-users');

  // PR #425 (2026-05-22) KDD §5.X+102: 入力即フィルタ + URL ?keyword=xxx 永続化
  const { keyword, setKeyword } = useListSearchParams({ initialKeyword });
  const filteredUsers = useMemo(() => {
    if (!keyword) return initialUsers;
    const lower = keyword.toLowerCase();
    return initialUsers.filter((u) =>
      u.name.toLowerCase().includes(lower) || u.email.toLowerCase().includes(lower),
    );
  }, [initialUsers, keyword]);
  const sortedUsers = multiSort(filteredUsers, sortState, getUserSortValue);

  const [form, setForm] = useState({
    name: '',
    email: '',
    systemRole: 'general' as 'admin' | 'general',
  });

  // P-2 (2026-05-08): Beginner プラン席数上限の UI ガード
  // Beginner プラン契約テナントで activeUserCount >= beginnerMaxSeats なら新規招待ボタンを disabled
  const isSeatLimitReached = tenantPlan === 'beginner' && activeUserCount >= beginnerMaxSeats;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const res = await withLoading(() =>
      fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      }),
    );

    const json = await res.json();

    if (!res.ok) {
      const code = json.error?.code;
      if (code === 'DUPLICATE_EMAIL') {
        setError(t('duplicateEmail'));
      } else if (code === 'SEAT_LIMIT_EXCEEDED') {
        // P-2 (2026-05-08): Beginner プラン席数上限超過 (UI ガード突破時の防御)
        setError(t('seatLimitExceeded'));
      } else if (code === 'EMAIL_SEND_FAILED') {
        setError(t('invitationSendFailed'));
      } else if (code === 'VALIDATION_ERROR') {
        setError(json.error?.details?.[0]?.message || t('validationError'));
      } else {
        setError(json.error?.message || t('registrationFailed'));
      }
      showError('ユーザの登録に失敗しました');
      return;
    }

    setSuccess(true);
    showSuccess('ユーザを登録し、招待メールを送信しました');
    router.refresh();
  }

  function handleClose() {
    setSuccess(false);
    setIsDialogOpen(false);
    setError('');
    setForm({ name: '', email: '', systemRole: 'general' });
  }

  // PR #89: 非アクティブユーザの手動ロック (vercel cron の日次実行に加え、手動でも実行可能)。
  // feat/account-lock 改修: 旧 (論理削除) → 新 (isActive=false ロック) へ方針変更。
  // 過去ナレッジ等の作成者表示を維持しつつ、ログインだけ封じる折衷。復帰は admin が
  // 当該ユーザ行の編集ダイアログから isActive をトグル。
  async function handleManualLockInactive() {
    if (!confirm(t('lockInactiveConfirm'))) return;
    const res = await withLoading(() =>
      fetch('/api/admin/users/lock-inactive', { method: 'POST' }),
    );
    if (!res.ok) {
      showError('非アクティブユーザの手動ロックに失敗しました');
      return;
    }
    const json = await res.json().catch(() => ({ data: null }));
    const count = json?.data?.lockedUserIds?.length ?? 0;
    showSuccess(`非アクティブユーザ ${count} 件をロックしました`);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {/* fix/admin-users-defensive-render (2026-05-15): server data load 失敗時のバナー。
          listUsers / getTenantSelfInfo が throw した場合、画面は空表示になるが
          ヘッダ + 招待 dialog 等の操作は維持。 */}
      {dataLoadError && (
        <div className="rounded border border-destructive/30 bg-destructive/10 p-3 text-sm">
          <p className="font-semibold">⚠ ユーザ一覧の読み込みに失敗しました</p>
          <p className="mt-1 text-muted-foreground">
            一時的な問題の可能性があります。ページを再読み込みするか、しばらくしてから再試行してください。
            問題が継続する場合は管理者にお問合せください。
          </p>
        </div>
      )}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{t('title')}</h2>
        <div className="flex items-center gap-2">
        {/*
          P-2 (2026-05-08): Beginner プランのみ席数表示 (席埋まり状況の可視化)。
          Expert / Pro は無制限のため表示しない。
        */}
        {tenantPlan === 'beginner' && (
          <span className="text-sm text-muted-foreground">
            {t('seatUsageLabel', { current: activeUserCount, max: beginnerMaxSeats })}
          </span>
        )}
        <Button variant="outline" size="sm" onClick={handleManualLockInactive}>
          {t('lockInactive')}
        </Button>
        <Dialog open={isDialogOpen} onOpenChange={(open) => { if (!open) handleClose(); else setIsDialogOpen(true); }}>
          {/*
            P-2 (2026-05-08): 席数上限到達時は disabled + tooltip でユーザに事前に通知。
            disabled 状態でも DialogTrigger が開かないよう button (button[disabled]) で実装。
            UI ガードを突破した場合 (race / curl 直叩き等) は API 側 SEAT_LIMIT_EXCEEDED で防御。
          */}
          {isSeatLimitReached ? (
            <button
              type="button"
              disabled
              title={t('seatLimitTooltip', { max: beginnerMaxSeats })}
              className="inline-flex shrink-0 cursor-not-allowed items-center justify-center rounded-md bg-primary/40 px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs"
            >
              {t('createUser')}
            </button>
          ) : (
            <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">{t('createUser')}</DialogTrigger>
          )}
          {/* PR #112: 大画面での余白過多対策 (基底で scroll 対応済) */}
          <DialogContent className="max-w-[min(90vw,32rem)] lg:max-w-[min(70vw,44rem)]">
            {success ? (
              <>
                <DialogHeader>
                  <DialogTitle>{t('invitationSent')}</DialogTitle>
                  <DialogDescription>
                    {t('invitationSentBody', { email: form.email })}
                  </DialogDescription>
                </DialogHeader>
                <Button onClick={handleClose}>{tAction('close')}</Button>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>{t('createUser')}</DialogTitle>
                  <DialogDescription>
                    {t('createUserDescription')}
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleCreate} className="space-y-4">
                  {error && (
                    <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="name">{t('fieldUserName')}</Label>
                    <Input
                      id="name"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      maxLength={100}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">{t('fieldEmail')}</Label>
                    <Input
                      id="email"
                      type="email"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="role">{t('fieldSystemRole')}</Label>
                    <select value={form.systemRole} onChange={(e) => setForm({ ...form, systemRole: e.target.value as 'admin' | 'general' })} className={nativeSelectClass}>
                      {/* feat/crud-permission-redesign (2026-05-20 追加要件): super_admin は管理テナント所属で
                          テナント側 UI からの招待を禁止 (option 自体を出さない)。 */}
                      {Object.entries(SYSTEM_ROLES)
                        .filter(([key]) => key !== 'super_admin')
                        .map(([key, label]) => (
                          <option key={key} value={key}>{label}</option>
                        ))}
                    </select>
                  </div>
                  <Button type="submit" className="w-full">
                    {t('sendInvitation')}
                  </Button>
                </form>
              </>
            )}
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {/* PR #425 (2026-05-22) KDD §5.X+102: 入力即フィルタ + URL ?keyword=xxx 永続化 */}
      <div>
        <Input
          placeholder={t('searchPlaceholder')}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          className="max-w-xs"
          data-testid="admin-users-search-input"
        />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <SortableHeader columnKey="name" label={t('fieldUserName')} sortState={sortState} onSortChange={setSortColumn} />
            </TableHead>
            <TableHead>
              <SortableHeader columnKey="email" label={t('fieldEmail')} sortState={sortState} onSortChange={setSortColumn} />
            </TableHead>
            <TableHead>
              <SortableHeader columnKey="role" label={t('columnRole')} sortState={sortState} onSortChange={setSortColumn} />
            </TableHead>
            <TableHead>
              <SortableHeader columnKey="status" label={t('columnStatus')} sortState={sortState} onSortChange={setSortColumn} />
            </TableHead>
            {/*
              PR #85 / PR #116 / T-21: 認証ロック状態
              - パスワード失敗ロック: failedLoginCount 5 回で一時ロック (30 分)
              - 永続ロック (T-21 / 2026-04-28 実装): 一時ロックが PERMANENT_LOCK_THRESHOLD 回 (= 3 回)
                発生で permanentLock=true。解除は admin 編集ダイアログから手動 (ユーザの正規復帰確認後)
              - MFA 失敗ロック (PR #116): mfaFailedCount 3 回で一時ロック (30 分) / recovery code で自己解除可
              - 1 列集約: tooltip で内訳 (原因・解除予定・失敗回数) を表示
            */}
            <TableHead>{t('columnAuthLock')}</TableHead>
            <TableHead>
              <SortableHeader columnKey="createdAt" label={t('columnCreatedAt')} sortState={sortState} onSortChange={setSortColumn} />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedUsers.map((user) => {
            const pwTemporaryLocked
              = !!user.lockedUntil && new Date(user.lockedUntil).getTime() > nowAtMount;
            // PR #116: MFA ロック (パスワードロックとは別系統)
            const mfaTemporaryLocked
              = !!user.mfaLockedUntil && new Date(user.mfaLockedUntil).getTime() > nowAtMount;

            // PR #116 A 案: tooltip に全情報を集約。表示優先度:
            //   永続 > パスワード一時 > MFA 一時 > パスワード失敗カウント > MFA 失敗カウント > —
            const lockBadgeProps = (() => {
              if (user.permanentLock) {
                return {
                  variant: 'destructive' as const,
                  label: t('permanentLock'),
                  title: t('permanentLockTitle'),
                };
              }
              if (pwTemporaryLocked) {
                return {
                  variant: 'destructive' as const,
                  label: t('temporaryLockPassword'),
                  title: t('temporaryLockPasswordTitle', {
                    count: user.failedLoginCount,
                    unlockAt: formatDateTimeFull(user.lockedUntil!),
                  }),
                };
              }
              if (mfaTemporaryLocked) {
                return {
                  variant: 'destructive' as const,
                  label: t('temporaryLockMfa'),
                  title: t('temporaryLockMfaTitle', {
                    unlockAt: formatDateTimeFull(user.mfaLockedUntil!),
                  }),
                };
              }
              if (user.failedLoginCount > 0) {
                return {
                  variant: 'secondary' as const,
                  label: t('pwFailedBadge', { count: user.failedLoginCount }),
                  title: t('pwFailedBadgeTitle'),
                };
              }
              if (user.mfaFailedCount > 0) {
                return {
                  variant: 'secondary' as const,
                  label: t('mfaFailedBadge', { count: user.mfaFailedCount }),
                  title: t('mfaFailedBadgeTitle'),
                };
              }
              return null;
            })();

            return (
              <ClickableRow
                key={user.id}
                onClick={() => setEditingUser(user)}
              >
                <TableCell className="font-medium">{user.name}</TableCell>
                <TableCell>{user.email}</TableCell>
                <TableCell>
                  <Badge variant={user.systemRole === 'admin' ? 'default' : 'secondary'}>
                    {SYSTEM_ROLES[user.systemRole as keyof typeof SYSTEM_ROLES] || user.systemRole}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={user.isActive ? 'default' : 'destructive'}>
                    {user.isActive ? t('statusActive') : t('statusInactive')}
                  </Badge>
                </TableCell>
                <TableCell>
                  {lockBadgeProps ? (
                    <Badge variant={lockBadgeProps.variant} title={lockBadgeProps.title}>
                      {lockBadgeProps.label}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>{formatDate(user.createdAt)}</TableCell>
              </ClickableRow>
            );
          })}
          {sortedUsers.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                {t('noUsers')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <UserEditDialog
        user={editingUser}
        open={editingUser != null}
        onOpenChange={(v) => { if (!v) setEditingUser(null); }}
        onSaved={async () => { router.refresh(); }}
        currentUserId={currentUserId}
      />
    </div>
  );
}
