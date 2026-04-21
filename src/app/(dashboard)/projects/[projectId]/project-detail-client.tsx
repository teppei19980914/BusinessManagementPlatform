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

type Props = {
  project: ProjectDTO;
  projectRole: string | null;
  systemRole: string;
  userId: string;
  canEdit: boolean;
  canCreate: boolean;
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
  canEdit, canCreate,
}: Props) {
  const t = useTranslations('action');
  const router = useRouter();
  const { withLoading } = useLoading();
  const [isChangingStatus, setIsChangingStatus] = useState(false);
  // 概要タブ内ヘッダの操作ボタン権限 (PR #58):
  //   状態変更 / 編集: 実際のプロジェクト PM/TL のみ (systemRole='admin' は除外)
  //   削除: システム管理者のみ (pm_tl は除外)
  //   → 運用作業 (PM/TL 責務) と プラットフォーム管理 (admin 責務) を明確に分離
  //   注: checkMembership が admin を projectRole='pm_tl' にマップするため、
  //       systemRole !== 'admin' で「真の pm_tl メンバー」に限定する
  const isActualPmTl = projectRole === 'pm_tl' && systemRole !== 'admin';
  const isSystemAdmin = systemRole === 'admin';
  const canChangeStatus = isActualPmTl;
  const canDeleteProject = isSystemAdmin;
  const nextStatuses = NEXT_STATUSES[project.status] || [];

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    name: project.name,
    customerName: project.customerName,
    purpose: project.purpose,
    background: project.background,
    scope: project.scope,
    devMethod: project.devMethod,
    plannedStartDate: project.plannedStartDate,
    plannedEndDate: project.plannedEndDate,
  });
  const [editError, setEditError] = useState('');

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

  async function handleDelete() {
    // 2 段階確認:
    //   1) まずプロジェクト削除の意思確認
    //   2) 次に「関連データ（リスク/課題・振り返り・ナレッジ）も削除するか」を問う
    //      - OK (cascade): 関連データを物理削除
    //      - キャンセル: 関連データは残す（全○○ 画面には残る。admin のみ管理可能）
    //   なお、ナレッジは他プロジェクトと共有している場合は当該プロジェクトとの
    //   紐付けのみ解除する (他プロジェクトの閲覧を壊さないため)。
    if (!confirm('このプロジェクトを削除しますか？この操作は取り消せません。')) return;

    const cascade = confirm(
      '関連データも削除しますか？\n\n'
      + '[OK] このプロジェクトに紐づく リスク/課題・振り返り・ナレッジ を物理削除\n'
      + '       （ナレッジは他プロジェクトと共有している場合、紐付けのみ解除）\n'
      + '[キャンセル] 関連データは残す\n'
      + '       （全リスク/課題・全振り返り・全ナレッジ 画面に表示され続けます。\n'
      + '        管理はシステム管理者のみが可能になります）',
    );

    const url = cascade
      ? `/api/projects/${project.id}?cascade=true`
      : `/api/projects/${project.id}`;
    await withLoading(() => fetch(url, { method: 'DELETE' }));
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
        <div className="flex items-center gap-2">
          {/*
            概要タブ内のみ表示 (PR #58):
              - 状態変更 (ラベルから "..." を削除): PM/TL のみ
              - 編集: PM/TL のみ
              - 削除: システム管理者のみ
            activeTab === 'overview' で他タブ閲覧時には非表示化する
          */}
          {activeTab === 'overview' && canChangeStatus && nextStatuses.length > 0 && (
            <Select onValueChange={handleStatusChange} disabled={isChangingStatus}>
              <SelectTrigger className="w-44">
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
          {activeTab === 'overview' && isActualPmTl && (
            <>
              <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
                <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent">{t('edit')}</DialogTrigger>
                {/* PR #87 横展開: grid-cols-2 + DateFieldWithActions を含むため max-w-2xl に揃える */}
                <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
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
                      <Label>顧客名</Label>
                      <Input value={editForm.customerName} onChange={(e) => setEditForm({ ...editForm, customerName: e.target.value })} required />
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
            <Button variant="outline" className="text-destructive" onClick={handleDelete}>{t('delete')}</Button>
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
                    canEdit={canEdit}
                    canCreate={canCreate}
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
                    canEdit={canEdit}
                    canCreate={canCreate}
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
                canEdit={canEdit}
                canComment={canCreate}
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
                canCreate={canCreate}
                canDelete={canEdit}
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
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
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
    </div>
  );
}
