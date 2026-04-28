'use client';

/**
 * メンバー管理画面 (プロジェクト詳細タブ配下) のクライアントコンポーネント。
 *
 * 役割:
 *   プロジェクトメンバー一覧 + 追加 + ロール変更 + 除外を管理する。
 *   1 ユーザ × 1 プロジェクトに対して 1 ロール (PM/TL / メンバー / 閲覧者)。
 *
 * 認可:
 *   メンバー追加 / ロール変更 / 除外は **システム管理者のみ** (権限委譲リスク回避)。
 *   PM/TL でも他メンバーの編集はできない (member.service / API ルート側で再判定)。
 *
 * API: /api/projects/[id]/members (GET/POST), /api/projects/[id]/members/[memberId] (PATCH/DELETE)
 *
 * 関連:
 *   - SPECIFICATION.md (メンバー管理)
 *   - DESIGN.md §8 (権限制御 / ロール変更履歴 role_change_logs)
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { nativeSelectClass } from '@/components/ui/native-select-style';
// PR #126: 件数が多くなる想定 (組織成長に追従) の Select には SearchableSelect を使う
import { SearchableSelect } from '@/components/ui/searchable-select';
import { PROJECT_ROLES } from '@/types';
import type { MemberDTO } from '@/services/member.service';
import type { UserDTO } from '@/services/user.service';
// PR #117 → PR #119: session 連携フォーマッタ
import { useFormatters } from '@/lib/use-formatters';

type Props = {
  projectId: string;
  members: MemberDTO[];
  allUsers: UserDTO[];
  isAdmin: boolean;
  /** CRUD 後に呼び出す再取得ハンドラ（未指定時は router.refresh フォールバック）*/
  onReload?: () => Promise<void> | void;
};

export function MembersClient({ projectId, members, allUsers, isAdmin, onReload }: Props) {
  const router = useRouter();
  const t = useTranslations('member');
  const { withLoading } = useLoading();
  // PR #119: session 連携フォーマッタ
  const { formatDate } = useFormatters();
  const reload = useCallback(async () => {
    if (onReload) {
      await onReload();
    } else {
      router.refresh();
    }
  }, [onReload, router]);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ userId: '', projectRole: 'member' });
  const [addError, setAddError] = useState('');

  // メンバー追加候補（既にメンバーのユーザを除外）
  const memberUserIds = new Set(members.map((m) => m.userId));
  const availableUsers = allUsers.filter((u) => !memberUserIds.has(u.id) && u.isActive);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddError('');
    if (!addForm.userId) {
      setAddError(t('userRequired'));
      return;
    }

    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addForm),
      }),
    );

    if (!res.ok) {
      const json = await res.json();
      setAddError(json.error?.message || t('addFailed'));
      return;
    }

    setIsAddOpen(false);
    setAddForm({ userId: '', projectRole: 'member' });
    await reload();
  }

  async function handleRoleChange(memberId: string, newRole: string) {
    await withLoading(() =>
      fetch(`/api/projects/${projectId}/members/${memberId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRole: newRole }),
      }),
    );
    await reload();
  }

  async function handleRemove(memberId: string, userName: string) {
    if (!confirm(t('removeConfirm', { userName }))) return;
    await withLoading(() =>
      fetch(`/api/projects/${projectId}/members/${memberId}`, {
        method: 'DELETE',
      }),
    );
    await reload();
  }

  return (
    <div className="space-y-4">
      {/* Phase A 要件 6: h3 タブタイトル削除 (タブ名と重複のため)。件数のみ右寄せで維持。 */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{t('countOnly', { count: members.length })}</span>
        {isAdmin && (
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">
              {t('addButton')}
            </DialogTrigger>
            {/* PR #112: admin ダイアログは大画面で余白過多になりやすいので lg: で拡大 */}
            <DialogContent className="max-w-[min(90vw,32rem)] lg:max-w-[min(70vw,44rem)]">
              <DialogHeader>
                <DialogTitle>{t('addDialogTitle')}</DialogTitle>
                <DialogDescription>{t('addDialogDescription')}</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleAdd} className="space-y-4">
                {addError && (
                  <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{addError}</div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="member-add-user">{t('userLabel')}</Label>
                  {/* PR #126: 組織成長で候補が増える想定のため SearchableSelect を採用
                      (viewport 比で検索欄の表示有無を動的判定) */}
                  <SearchableSelect
                    id="member-add-user"
                    value={addForm.userId}
                    onValueChange={(v) => setAddForm({ ...addForm, userId: v })}
                    options={availableUsers.map((u) => ({
                      value: u.id,
                      label: t('userOptionLabel', { name: u.name, email: u.email }),
                    }))}
                    placeholder={t('userPlaceholder')}
                    aria-label={t('userAriaLabel')}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('projectRoleLabel')}</Label>
                  <select value={addForm.projectRole} onChange={(e) => setAddForm({ ...addForm, projectRole: e.target.value })} className={nativeSelectClass}>
                    {Object.entries(PROJECT_ROLES).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>
                <Button type="submit" className="w-full">{t('addSubmit')}</Button>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('colUserName')}</TableHead>
            <TableHead>{t('colEmail')}</TableHead>
            <TableHead>{t('colRole')}</TableHead>
            <TableHead>{t('colAddedAt')}</TableHead>
            {isAdmin && <TableHead className="w-24">{t('colActions')}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((m) => (
            <TableRow key={m.id}>
              <TableCell className="font-medium">{m.userName}</TableCell>
              <TableCell>{m.userEmail}</TableCell>
              <TableCell>
                {isAdmin ? (
                  // Phase A 要件 9: ロールトグルの選択後表示が内部名 (manager/member 等) になる問題を修正。
                  //   SelectValue の children render 関数で PROJECT_ROLES から表示名にマップする。
                  <Select
                    value={m.projectRole}
                    onValueChange={(v) => v && handleRoleChange(m.id, v)}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue>
                        {(value) => PROJECT_ROLES[value as keyof typeof PROJECT_ROLES] || value}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(PROJECT_ROLES).map(([key, label]) => (
                        <SelectItem key={key} value={key}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant="secondary">
                    {PROJECT_ROLES[m.projectRole as keyof typeof PROJECT_ROLES] || m.projectRole}
                  </Badge>
                )}
              </TableCell>
              <TableCell>{formatDate(m.createdAt)}</TableCell>
              {isAdmin && (
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={() => handleRemove(m.id, m.userName)}
                  >
                    {t('removeButton')}
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
          {members.length === 0 && (
            <TableRow>
              <TableCell colSpan={isAdmin ? 5 : 4} className="py-8 text-center text-muted-foreground">
                {t('listEmpty')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
