'use client';

/**
 * プロジェクト詳細画面 (タブ式構造) のクライアントコンポーネント。
 *
 * 役割:
 *   1 つのプロジェクトに対する全機能のハブ。Tabs で「概要 / 見積もり / WBS /
 *   ガント / リスク / 課題 / 振り返り / ナレッジ / メンバー」等を切り替える。
 *
 * 重要設計:
 *   - 各タブの内容は lazy fetch (PR #29): タブ切替時に該当 API を初めて叩くことで
 *     初期ロードを軽量化。ページ全体を 1 ショットで取得すると重いため。
 *   - 状態遷移ボタン (planning → estimating → ...) はここから API を叩く。
 *     遷移ルール違反は 409 STATE_CONFLICT を表示する。
 *   - 編集 / 削除はメンバーシップ + ロールに応じて表示制御 (canEdit prop)。
 *
 * 認可: ページ側でメンバーシップ確認済。canEdit / canCreate は role に基づき決定。
 * API: /api/projects/[id], /api/projects/[id]/status (PATCH)
 *
 * 関連:
 *   - SPECIFICATION.md (プロジェクト詳細画面)
 *   - DESIGN.md §6 (状態遷移) / §8 (権限制御) / §17 (パフォーマンス改修)
 */

import { useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import { PROJECT_STATUSES, DEV_METHODS } from '@/types';
import type { ProjectDTO } from '@/services/project.service';
import type { EstimateDTO } from '@/services/estimate.service';
import type { TaskDTO } from '@/services/task.service';
import type { RiskDTO } from '@/services/risk.service';
import type { RetroDTO } from '@/services/retrospective.service';
import type { MemberDTO } from '@/services/member.service';
import type { KnowledgeDTO } from '@/services/knowledge.service';
import type { UserDTO } from '@/services/user.service';
import { useLazyFetch, type LazyState } from '@/lib/use-lazy-fetch';
import { AttachmentList } from '@/components/attachments/attachment-list';
import { SingleUrlField } from '@/components/attachments/single-url-field';
import { DateFieldWithActions } from '@/components/ui/date-field-with-actions';
import { EstimatesClient } from './estimates/estimates-client';
import { TasksClient } from './tasks/tasks-client';
import { GanttClient } from './gantt/gantt-client';
import { RisksClient } from './risks/risks-client';
import { RetrospectivesClient } from './retrospectives/retrospectives-client';
import { ProjectKnowledgeClient } from './knowledge/project-knowledge-client';
import { MembersClient } from './members-client';
import { SuggestionsPanel } from './suggestions/suggestions-panel';

type CustomerOption = { id: string; name: string };

type Props = {
  project: ProjectDTO;
  projectRole: string | null;
  systemRole: string;
  userId: string;
  canEdit: boolean;
  canCreate: boolean;
  /** 2026-04-24: リスク/課題/振り返り/ナレッジ 一覧 向けの create 可否 (admin 短絡なし) */
  canCreateOwnedList: boolean;
  // PR #111-2: 編集ダイアログの顧客選択肢
  customers: CustomerOption[];
};

const NEXT_STATUSES: Record<string, string[]> = {
  planning: ['estimating'],
  estimating: ['scheduling'],
  scheduling: ['executing'],
  executing: ['completed'],
  completed: ['retrospected'],
  retrospected: ['closed'],
  closed: [],
};

/**
 * 遅延ロードタブの状態に応じて loading / error / content を切り替える表示ラッパー。
 * 外側でタブ可視時に load() を呼び出す設計とセットで使う。
 */
function LazyTabContent<T>({
  state,
  children,
}: {
  state: LazyState<T>;
  children: (data: T) => React.ReactNode;
}) {
  if (state.status === 'idle' || state.status === 'loading') {
    return <div className="py-8 text-center text-sm text-muted-foreground">読み込み中...</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="py-8 text-center text-sm text-destructive">
        読み込みに失敗しました: {state.error}
      </div>
    );
  }
  return <>{children(state.data)}</>;
}

export function ProjectDetailClient({
  project, projectRole, systemRole, userId,
  canEdit, canCreate, canCreateOwnedList, customers,
}: Props) {
  const t = useTranslations('action');
  const router = useRouter();
  const { withLoading } = useLoading();
  const [isChangingStatus, setIsChangingStatus] = useState(false);
  // 概要タブ内ヘッダの操作ボタン権限 (PR #58 → fix/quick-ux item 1 で改修):
  //   状態変更 / 編集: 実際のプロジェクト PM/TL **または** システム管理者
  //   削除: システム管理者のみ (pm_tl は除外、プラットフォーム管理責務の分離は維持)
  //
  //   2026-04-26 ユーザ報告「状態変更プルダウンがなくなった」を受けて、admin も
  //   状態変更できるよう緩和。元の設計 (PM/TL のみ) は運用責務分離の意図だったが、
  //   admin が代行できないと運用が詰まるケースが多発したため。
  //   注: checkMembership が admin を projectRole='pm_tl' にマップする挙動は維持。
  const isActualPmTl = projectRole === 'pm_tl' && systemRole !== 'admin';
  const isSystemAdmin = systemRole === 'admin';
  const canChangeStatus = isActualPmTl || isSystemAdmin;
  const canDeleteProject = isSystemAdmin;
  const nextStatuses = NEXT_STATUSES[project.status] || [];

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    name: project.name,
    customerId: project.customerId,
    purpose: project.purpose,
    background: project.background,
    scope: project.scope,
    devMethod: project.devMethod,
    plannedStartDate: project.plannedStartDate,
    plannedEndDate: project.plannedEndDate,
  });
  const [editError, setEditError] = useState('');

  // PR #88: 編集ダイアログを開くたびに DB の最新データ (project prop) を初期表示する。
  // useState は初回 mount でしか初期値を評価しないため、そのままでは router.refresh 後や
  // 編集途中で閉じて再度開いた際に古い値が残ってしまう。onOpenChange の o=true 分岐で
  // project の最新値を都度リセットする。
  const openEditDialog = () => {
    setEditForm({
      name: project.name,
      customerId: project.customerId,
      purpose: project.purpose,
      background: project.background,
      scope: project.scope,
      devMethod: project.devMethod,
      plannedStartDate: project.plannedStartDate,
      plannedEndDate: project.plannedEndDate,
    });
    setEditError('');
    setIsEditOpen(true);
  };
  const handleEditOpenChange = (open: boolean) => {
    if (open) openEditDialog();
    else setIsEditOpen(false);
  };

  // --- タブごとの遅延フェッチ状態 ---
  // 概要タブ以外のデータは「ユーザがそのタブを最初に開いた時」にフェッチする。
  // 2 度目以降のタブ切替時はメモリキャッシュから即座に表示する。
  // CRUD 直後は対応する onReload が force 再取得する。
  const tasks = useLazyFetch<{ tree: TaskDTO[]; flat: TaskDTO[] }>(
    `/api/projects/${project.id}/tasks/tree`,
  );
  const estimates = useLazyFetch<EstimateDTO[]>(`/api/projects/${project.id}/estimates`);
  const risks = useLazyFetch<RiskDTO[]>(`/api/projects/${project.id}/risks`);
  const retros = useLazyFetch<RetroDTO[]>(`/api/projects/${project.id}/retrospectives`);
  const members = useLazyFetch<MemberDTO[]>(`/api/projects/${project.id}/members`);
  // プロジェクト scoped のナレッジ一覧 (PR #52): 「ナレッジ一覧」タブは
  // このプロジェクトに紐づくナレッジのみ表示する。「全ナレッジ」 (/knowledge) は
  // 全プロジェクトのナレッジを表示するが、どちらも同一 knowledge テーブルを参照する
  // ため、一方での CRUD がもう一方に即座に反映される (連動)。
  const knowledges = useLazyFetch<KnowledgeDTO[]>(`/api/projects/${project.id}/knowledge`);
  const allUsers = useLazyFetch<UserDTO[]>(`/api/admin/users`);

  const [activeTab, setActiveTab] = useState('overview');

  // PR #65 核心機能: 新規プロジェクト作成直後に ?suggestions=1 付きで遷移してくるパス用。
  // URL クエリを見てモーダルを開くかを決定し、モーダル閉鎖時は URL から除去する。
  const searchParams = useSearchParams();
  const [isSuggestionsModalOpen, setIsSuggestionsModalOpen] = useState(
    searchParams.get('suggestions') === '1',
  );
  const closeSuggestionsModal = useCallback(() => {
    setIsSuggestionsModalOpen(false);
    // URL から ?suggestions=1 を消して再アクセスで再表示されないようにする
    router.replace(`/projects/${project.id}`);
  }, [router, project.id]);

  function handleTabChange(value: string) {
    setActiveTab(value);
    // タブ表示時に必要なデータをロード（キャッシュヒットなら no-op）
    switch (value) {
      case 'estimates':
        estimates.load();
        break;
      case 'tasks':
        tasks.load();
        members.load();
        break;
      case 'gantt':
        tasks.load();
        // Gantt の担当者フィルタで使う（WBS と同仕様）
        members.load();
        break;
      case 'risks':
      case 'issues':
        risks.load();
        members.load();
        break;
      case 'retrospectives':
        retros.load();
        break;
      case 'knowledge':
        knowledges.load();
        break;
      case 'members':
        members.load();
        if (systemRole === 'admin') allUsers.load();
        break;
      default:
        break;
    }
  }

  // CRUD 直後に呼ぶ再取得ハンドラ。router.refresh() は概要タブのプロジェクト基本情報のみで
  // 十分なため、タブ内 CRUD ではタブローカルの load(true) のみで完結させる。
  const reloadTasks = useCallback(async () => {
    await tasks.load(true);
  }, [tasks]);
  const reloadEstimates = useCallback(async () => {
    await estimates.load(true);
  }, [estimates]);
  const reloadRisks = useCallback(async () => {
    await risks.load(true);
  }, [risks]);
  const reloadRetros = useCallback(async () => {
    await retros.load(true);
  }, [retros]);
  const reloadMembers = useCallback(async () => {
    await members.load(true);
  }, [members]);
  const reloadKnowledges = useCallback(async () => {
    await knowledges.load(true);
  }, [knowledges]);

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    setEditError('');
    const res = await withLoading(() =>
      fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm),
      }),
    );
    if (!res.ok) {
      const json = await res.json();
      setEditError(json.error?.message || '更新に失敗しました');
      return;
    }
    setIsEditOpen(false);
    router.refresh();
  }

  // PR #89: 細粒度カスケード削除ダイアログ (4 チェックボックス) の state
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [cascadeRisks, setCascadeRisks] = useState(false);
  const [cascadeIssues, setCascadeIssues] = useState(false);
  const [cascadeRetros, setCascadeRetros] = useState(false);
  const [cascadeKnowledge, setCascadeKnowledge] = useState(false);

  function openDeleteDialog() {
    // 毎回 default (全 off = 資産として残す) でリセット
    setCascadeRisks(false);
    setCascadeIssues(false);
    setCascadeRetros(false);
    setCascadeKnowledge(false);
    setIsDeleteOpen(true);
  }

  async function handleConfirmDelete() {
    setIsDeleteOpen(false);
    // cascade=true は常時 ON (プロジェクト本体 + 強制削除対象を処理するため)。
    // 個別フラグは UI のチェックで上書きされる。
    const params = new URLSearchParams({
      cascade: 'true',
      cascadeRisks: String(cascadeRisks),
      cascadeIssues: String(cascadeIssues),
      cascadeRetros: String(cascadeRetros),
      cascadeKnowledge: String(cascadeKnowledge),
    });
    await withLoading(() =>
      fetch(`/api/projects/${project.id}?${params.toString()}`, { method: 'DELETE' }),
    );
    router.push('/projects');
  }

  async function handleStatusChange(newStatus: string | null) {
    if (!newStatus) return;
    setIsChangingStatus(true);
    const res = await withLoading(() =>
      fetch(`/api/projects/${project.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      }),
    );
    setIsChangingStatus(false);
    if (res.ok) router.refresh();
  }

  return (
    <div className="space-y-6">
      {/* ヘッダー */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-semibold">{project.name}</h2>
            <Badge>
              {PROJECT_STATUSES[project.status as keyof typeof PROJECT_STATUSES] || project.status}
            </Badge>
          </div>
          <p className="mt-1 text-muted-foreground">{project.customerName}</p>
        </div>
        {/* fix/quick-ux hotfix: PR-A で admin に状態変更 Select が出るようになった結果、
            mobile (390px) で flex 子要素 (Select w-44 + 編集 + 削除) が幅不足で重なり、
            削除ボタンが intercept されて E2E (05-teardown Step 11 chromium-mobile) が click
            timeout で fail。flex-wrap 許容 + Select 幅を mobile 短縮 (w-36) で解消。
            PC (md+) では従来通り w-44 の幅を維持。 */}
        <div className="flex flex-wrap items-center gap-2 justify-end">
          {/*
            概要タブ内のみ表示 (PR #58):
              - 状態変更 (ラベルから "..." を削除): PM/TL or admin (PR-A で緩和)
              - 編集: PM/TL or admin (PR-A で緩和)
              - 削除: システム管理者のみ
            activeTab === 'overview' で他タブ閲覧時には非表示化する
          */}
          {activeTab === 'overview' && canChangeStatus && nextStatuses.length > 0 && (
            <Select onValueChange={handleStatusChange} disabled={isChangingStatus}>
              <SelectTrigger className="w-36 md:w-44">
                <SelectValue placeholder="状態変更" />
              </SelectTrigger>
              <SelectContent>
                {nextStatuses.map((s) => (
                  <SelectItem key={s} value={s}>
                    → {PROJECT_STATUSES[s as keyof typeof PROJECT_STATUSES]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {activeTab === 'overview' && (isActualPmTl || isSystemAdmin) && (
            <>
              <Dialog open={isEditOpen} onOpenChange={handleEditOpenChange}>
                <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent">{t('edit')}</DialogTrigger>
                {/* PR #87 横展開: grid-cols-2 + DateFieldWithActions を含むため max-w-[min(90vw,42rem)] に揃える */}
                <DialogContent className="max-w-[min(90vw,42rem)] max-h-[80vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>プロジェクト編集</DialogTitle>
                    <DialogDescription>プロジェクト情報を編集してください。</DialogDescription>
                  </DialogHeader>
                  <form onSubmit={handleEdit} className="space-y-4">
                    {editError && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{editError}</div>}
                    <div className="space-y-2">
                      <Label>プロジェクト名</Label>
                      <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required />
                    </div>
                    <div className="space-y-2">
                      {/* PR #111-2: 顧客は Customer マスタから選択 */}
                      <Label>顧客</Label>
                      <select
                        value={editForm.customerId}
                        onChange={(e) => setEditForm({ ...editForm, customerId: e.target.value })}
                        className={nativeSelectClass}
                        required
                      >
                        {customers.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <Label>目的</Label>
                      <textarea className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={editForm.purpose} onChange={(e) => setEditForm({ ...editForm, purpose: e.target.value })} rows={3} required />
                    </div>
                    <div className="space-y-2">
                      <Label>開発方式</Label>
                      <select value={editForm.devMethod} onChange={(e) => setEditForm({ ...editForm, devMethod: e.target.value })} className={nativeSelectClass}>
                        {Object.entries(DEV_METHODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>開始予定日</Label>
                        <DateFieldWithActions value={editForm.plannedStartDate} onChange={(v) => setEditForm({ ...editForm, plannedStartDate: v })} required hideClear />
                      </div>
                      <div className="space-y-2">
                        <Label>終了予定日</Label>
                        <DateFieldWithActions value={editForm.plannedEndDate} onChange={(v) => setEditForm({ ...editForm, plannedEndDate: v })} required hideClear />
                      </div>
                    </div>
                    <Button type="submit" className="w-full">更新</Button>
                  </form>
                </DialogContent>
              </Dialog>
            </>
          )}
          {activeTab === 'overview' && canDeleteProject && (
            <Button variant="outline" className="text-destructive" onClick={openDeleteDialog}>{t('delete')}</Button>
          )}
          <Button variant="outline" onClick={() => router.push('/projects')}>
            一覧に戻る
          </Button>
        </div>
      </div>

      {/* タブ - 全機能をタブ内に直接埋め込み */}
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">概要</TabsTrigger>
          {canEdit && <TabsTrigger value="estimates">見積もり</TabsTrigger>}
          <TabsTrigger value="tasks">WBS管理</TabsTrigger>
          <TabsTrigger value="gantt">ガント</TabsTrigger>
          <TabsTrigger value="risks">リスク一覧</TabsTrigger>
          <TabsTrigger value="issues">課題一覧</TabsTrigger>
          <TabsTrigger value="retrospectives">振り返り一覧</TabsTrigger>
          <TabsTrigger value="knowledge">ナレッジ一覧</TabsTrigger>
          {/* PR #65 核心機能: 過去プロジェクトから流用できるナレッジ・課題を常時提案 */}
          <TabsTrigger value="suggestions">参考</TabsTrigger>
          {(systemRole === 'admin' || projectRole === 'pm_tl') && (
            <TabsTrigger value="members">メンバー</TabsTrigger>
          )}
        </TabsList>

        {/* 概要タブ（サーバで既に取得済みの project のみ表示、fetch 不要）*/}
        <TabsContent value="overview" className="mt-4 space-y-6">
          <div className="grid gap-6 md:grid-cols-2">
            <div className="rounded-lg border p-4">
              <h3 className="mb-2 font-semibold">基本情報</h3>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">開発方式</dt>
                  <dd>{DEV_METHODS[project.devMethod as keyof typeof DEV_METHODS] || project.devMethod}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">開始予定日</dt>
                  <dd>{project.plannedStartDate}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">終了予定日</dt>
                  <dd>{project.plannedEndDate}</dd>
                </div>
              </dl>
            </div>
            <div className="rounded-lg border p-4">
              <h3 className="mb-2 font-semibold">目的</h3>
              <p className="whitespace-pre-wrap text-sm text-foreground">{project.purpose}</p>
            </div>
            <div className="rounded-lg border p-4">
              <h3 className="mb-2 font-semibold">背景</h3>
              <p className="whitespace-pre-wrap text-sm text-foreground">{project.background}</p>
            </div>
            <div className="rounded-lg border p-4">
              <h3 className="mb-2 font-semibold">スコープ</h3>
              <p className="whitespace-pre-wrap text-sm text-foreground">{project.scope}</p>
              {project.outOfScope && (
                <>
                  <h3 className="mb-2 mt-4 font-semibold">スコープ外</h3>
                  <p className="whitespace-pre-wrap text-sm text-foreground">{project.outOfScope}</p>
                </>
              )}
            </div>
          </div>
          {project.notes && (
            <div className="rounded-lg border p-4">
              <h3 className="mb-2 font-semibold">備考</h3>
              <p className="whitespace-pre-wrap text-sm text-foreground">{project.notes}</p>
            </div>
          )}

          {/* PR #64 Phase 2: プロジェクト関連 URL (メインドキュメント 1 本 + 参考資料 複数) */}
          <div className="rounded-lg border p-4 space-y-4">
            <h3 className="font-semibold">関連 URL</h3>
            <SingleUrlField
              entityType="project"
              entityId={project.id}
              slot="primary"
              canEdit={canEdit}
              label="メイン資料"
              defaultDisplayName="提案書 / 見積根拠"
            />
            <AttachmentList
              entityType="project"
              entityId={project.id}
              canEdit={canEdit}
              label="その他の関連 URL"
            />
          </div>
        </TabsContent>

        {/* 見積もりタブ（canEdit のみ）*/}
        {canEdit && (
          <TabsContent value="estimates" className="mt-4">
            <LazyTabContent state={estimates.state}>
              {(data) => (
                <EstimatesClient
                  projectId={project.id}
                  estimates={data}
                  canEdit={canEdit}
                  onReload={reloadEstimates}
                />
              )}
            </LazyTabContent>
          </TabsContent>
        )}

        {/* WBS/タスクタブ（tasks と members が必要）*/}
        <TabsContent value="tasks" className="mt-4">
          <LazyTabContent state={tasks.state}>
            {(tasksData) => (
              <LazyTabContent state={members.state}>
                {(membersData) => (
                  <TasksClient
                    projectId={project.id}
                    tasks={tasksData.tree}
                    members={membersData}
                    projectRole={projectRole}
                    systemRole={systemRole}
                    userId={userId}
                    onReload={reloadTasks}
                  />
                )}
              </LazyTabContent>
            )}
          </LazyTabContent>
        </TabsContent>

        {/* ガントチャートタブ（tree を渡して階層構造を描画・WP 折りたたみ + 担当者フィルタ対応）*/}
        <TabsContent value="gantt" className="mt-4">
          <LazyTabContent state={tasks.state}>
            {(tasksData) => (
              <LazyTabContent state={members.state}>
                {(membersData) => (
                  <GanttClient
                    projectId={project.id}
                    tasks={tasksData.tree}
                    members={membersData}
                  />
                )}
              </LazyTabContent>
            )}
          </LazyTabContent>
        </TabsContent>

        {/* リスクタブ (PR #60 #1: risk のみ表示) */}
        <TabsContent value="risks" className="mt-4">
          <LazyTabContent state={risks.state}>
            {(risksData) => (
              <LazyTabContent state={members.state}>
                {(membersData) => (
                  <RisksClient
                    projectId={project.id}
                    risks={risksData}
                    members={membersData}
                    canCreate={canCreateOwnedList}
                    currentUserId={userId}
                    systemRole={systemRole}
                    typeFilter="risk"
                    onReload={reloadRisks}
                  />
                )}
              </LazyTabContent>
            )}
          </LazyTabContent>
        </TabsContent>

        {/* 課題タブ (PR #60 #1: issue のみ表示) */}
        <TabsContent value="issues" className="mt-4">
          <LazyTabContent state={risks.state}>
            {(risksData) => (
              <LazyTabContent state={members.state}>
                {(membersData) => (
                  <RisksClient
                    projectId={project.id}
                    risks={risksData}
                    members={membersData}
                    canCreate={canCreateOwnedList}
                    currentUserId={userId}
                    systemRole={systemRole}
                    typeFilter="issue"
                    onReload={reloadRisks}
                  />
                )}
              </LazyTabContent>
            )}
          </LazyTabContent>
        </TabsContent>

        {/* 振り返りタブ */}
        <TabsContent value="retrospectives" className="mt-4">
          <LazyTabContent state={retros.state}>
            {(data) => (
              <RetrospectivesClient
                projectId={project.id}
                retros={data}
                canCreate={canCreateOwnedList}
                canComment={canCreate}
                currentUserId={userId}
                onReload={reloadRetros}
              />
            )}
          </LazyTabContent>
        </TabsContent>

        {/*
          ナレッジ一覧タブ (PR #52 以降):
            - このプロジェクトに紐づくナレッジのみ表示 (project-scoped)
            - 作成/削除はプロジェクトメンバーのみ (ProjectKnowledgeClient 内で制御)
            - 作成時に projectId を自動で関連付けるため「全ナレッジ」にも即反映
        */}
        <TabsContent value="knowledge" className="mt-4">
          <LazyTabContent state={knowledges.state}>
            {(result) => (
              <ProjectKnowledgeClient
                projectId={project.id}
                knowledges={result}
                canCreate={canCreateOwnedList}
                currentUserId={userId}
                onReload={reloadKnowledges}
              />
            )}
          </LazyTabContent>
        </TabsContent>

        {/*
          参考タブ (PR #65 核心機能): 過去プロジェクトから流用可能な
          ナレッジ・課題を類似度スコア付きで表示し、採用操作を提供する。
          本タブは独自の fetch (SuggestionsPanel 内) を持つため LazyTabContent 不要。
        */}
        <TabsContent value="suggestions" className="mt-4">
          <SuggestionsPanel projectId={project.id} canAdopt={canCreate} />
        </TabsContent>

        {/* メンバータブ（admin/pm_tl のみ、admin なら allUsers も必要）*/}
        {(systemRole === 'admin' || projectRole === 'pm_tl') && (
          <TabsContent value="members" className="mt-4">
            <LazyTabContent state={members.state}>
              {(membersData) => {
                if (systemRole === 'admin') {
                  return (
                    <LazyTabContent state={allUsers.state}>
                      {(allUsersData) => (
                        <MembersClient
                          projectId={project.id}
                          members={membersData}
                          allUsers={allUsersData}
                          isAdmin={true}
                          onReload={reloadMembers}
                        />
                      )}
                    </LazyTabContent>
                  );
                }
                return (
                  <MembersClient
                    projectId={project.id}
                    members={membersData}
                    allUsers={[]}
                    isAdmin={false}
                    onReload={reloadMembers}
                  />
                );
              }}
            </LazyTabContent>
          </TabsContent>
        )}
      </Tabs>

      {/*
        PR #65 核心機能: 新規プロジェクト作成直後に自動起動する提案モーダル。
        ?suggestions=1 クエリで遷移してきたときだけ初期表示され、閉じると URL から除去される。
        抜け漏れゼロ化の UX を実現するため、作成フローの延長として強制露出する。
      */}
      <Dialog
        open={isSuggestionsModalOpen}
        onOpenChange={(o) => { if (!o) closeSuggestionsModal(); }}
      >
        <DialogContent className="max-w-[min(90vw,48rem)] max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>類似ナレッジ / 過去課題の提案</DialogTitle>
            <DialogDescription>
              新規プロジェクトに活用可能な過去資産を提案します。採用することで、
              未然に防げるリスクを減らせます (後で「参考」タブからも参照可能です)。
            </DialogDescription>
          </DialogHeader>
          <SuggestionsPanel projectId={project.id} canAdopt={canCreate} />
          <div className="mt-4 flex justify-end">
            <Button variant="outline" onClick={closeSuggestionsModal}>
              閉じる
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* PR #89: プロジェクト削除 細粒度カスケード確認ダイアログ */}
      <Dialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <DialogContent className="max-w-[min(90vw,36rem)]">
          <DialogHeader>
            <DialogTitle>プロジェクトを削除しますか？</DialogTitle>
            <DialogDescription>
              この操作は取り消せません。各資産一覧 (リスク / 課題 / 振り返り / ナレッジ) は、
              チェックを入れた項目のみ物理削除されます。チェックを入れないものは資産として
              全○○画面に残ります。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
              <div className="mb-1 font-medium text-foreground">強制削除される項目 (選択不可)</div>
              プロジェクト本体・概要・見積もり・WBS管理・ガント・メンバー・関連 URL
            </div>
            <div className="space-y-2 rounded-md border border-border p-3">
              <div className="mb-1 text-sm font-medium">資産として扱う項目 (各一覧から削除するかチェック)</div>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={cascadeRisks}
                  onChange={(e) => setCascadeRisks(e.target.checked)}
                  className="mt-0.5 rounded"
                />
                <span>リスク一覧 (プロジェクトに紐づく「リスク」を削除)</span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={cascadeIssues}
                  onChange={(e) => setCascadeIssues(e.target.checked)}
                  className="mt-0.5 rounded"
                />
                <span>課題一覧 (プロジェクトに紐づく「課題」を削除)</span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={cascadeRetros}
                  onChange={(e) => setCascadeRetros(e.target.checked)}
                  className="mt-0.5 rounded"
                />
                <span>振り返り一覧 (プロジェクトの振り返り + コメントを削除)</span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={cascadeKnowledge}
                  onChange={(e) => setCascadeKnowledge(e.target.checked)}
                  className="mt-0.5 rounded"
                />
                <span>
                  ナレッジ一覧 (単独紐付けのみ物理削除。他プロジェクトと共有するナレッジは
                  紐付けだけ解除し本体は残す)
                </span>
              </label>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setIsDeleteOpen(false)}>
              キャンセル
            </Button>
            <Button
              variant="outline"
              className="border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={handleConfirmDelete}
            >
              プロジェクトを削除する
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
