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

import { useCallback, useEffect, useState } from 'react';
// Phase E 要件 1〜3 (2026-04-29): 共通クリッカブルカード部品
import { ClickableCard } from '@/components/common/clickable-row';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Menu } from '@base-ui/react/menu';
import { ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';
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
import { PROJECT_STATUSES, DEV_METHODS, CONTRACT_TYPES } from '@/types';
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
// feat/stakeholder-management: PM/TL + admin のみ閲覧可。lazy fetch でタブ初表示時に取得。
import { StakeholdersClient } from './stakeholders/stakeholders-client';
import type { StakeholderDTO } from '@/services/stakeholder.service';
// feat/markdown-textarea: Markdown 入力 + プレビュー + 既存値との差分表示
import { MarkdownTextarea, MarkdownDisplay } from '@/components/ui/markdown-textarea';

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
  const t = useTranslations('project');
  if (state.status === 'idle' || state.status === 'loading') {
    return <div className="py-8 text-center text-sm text-muted-foreground">{t('overviewLoading')}</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="py-8 text-center text-sm text-destructive">
        {t('overviewLoadFailed', { error: state.error })}
      </div>
    );
  }
  return <>{children(state.data)}</>;
}

export function ProjectDetailClient({
  project, projectRole, systemRole, userId,
  canEdit, canCreate, canCreateOwnedList, customers,
}: Props) {
  const t = useTranslations('project');
  const tAction = useTranslations('action');
  const router = useRouter();
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();
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

  // feat/overview-tab-detail (PR-B item 3+4): 編集 dialog を 11 フィールド全て編集可能に拡張。
  // タグ入力はカンマ区切り文字列で扱い (parseTagsInput を /lib/parse-tags から流用)、
  // submit 時に string[] に変換する。
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    name: project.name,
    customerId: project.customerId,
    purpose: project.purpose,
    background: project.background,
    scope: project.scope,
    devMethod: project.devMethod,
    contractType: project.contractType ?? '',
    plannedStartDate: project.plannedStartDate,
    plannedEndDate: project.plannedEndDate,
    businessDomainTagsInput: project.businessDomainTags.join(', '),
    techStackTagsInput: project.techStackTags.join(', '),
    processTagsInput: project.processTags.join(', '),
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
      contractType: project.contractType ?? '',
      plannedStartDate: project.plannedStartDate,
      plannedEndDate: project.plannedEndDate,
      businessDomainTagsInput: project.businessDomainTags.join(', '),
      techStackTagsInput: project.techStackTags.join(', '),
      processTagsInput: project.processTags.join(', '),
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
  // feat/stakeholder-management: ステークホルダー一覧 (PM/TL + admin のみ取得・表示)
  const stakeholders = useLazyFetch<StakeholderDTO[]>(`/api/projects/${project.id}/stakeholders`);

  // PR #65 核心機能: 新規プロジェクト作成直後に ?suggestions=1 付きで遷移してくるパス用。
  // PR feat/notification-deep-link-completion (2026-05-01): ?tab=stakeholders&stakeholderId=...
  //   形式の deep link を sticker の通知から受け取って、初期 active tab + auto-open dialog する。
  // URL クエリを見てモーダルを開くかを決定し、モーダル閉鎖時は URL から除去する。
  const searchParams = useSearchParams();

  // 通知 deep link で `?tab=` 指定があれば、それを初期 active tab に使う (権限 tab に限る)。
  // 不正値 / 権限不足 tab を指定された場合は 'overview' fallback。
  const initialTabFromUrl = (() => {
    const t = searchParams.get('tab');
    const allowed = ['overview', 'estimates', 'tasks', 'gantt', 'risks', 'issues', 'retrospectives', 'knowledge', 'members', 'stakeholders', 'suggestions'];
    return t && allowed.includes(t) ? t : 'overview';
  })();
  const [activeTab, setActiveTab] = useState(initialTabFromUrl);

  const [isSuggestionsModalOpen, setIsSuggestionsModalOpen] = useState(
    searchParams.get('suggestions') === '1',
  );
  const closeSuggestionsModal = useCallback(() => {
    setIsSuggestionsModalOpen(false);
    // URL から ?suggestions=1 を消して再アクセスで再表示されないようにする
    router.replace(`/projects/${project.id}`);
  }, [router, project.id]);

  // タブ切替時のデータロード処理 (handleTabChange と初期 mount 時 effect から共通利用)
  const loadTabData = useCallback((value: string) => {
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
      case 'stakeholders':
        // 内部メンバー紐付けプルダウン用に members も取得
        stakeholders.load();
        members.load();
        break;
      default:
        break;
    }
  }, [estimates, tasks, members, risks, retros, knowledges, stakeholders, allUsers, systemRole]);

  function handleTabChange(value: string) {
    setActiveTab(value);
    loadTabData(value);
  }

  // 通知 deep link (e.g. /projects/[id]?tab=stakeholders&stakeholderId=...) で着地した際、
  // initial active tab のデータが lazy fetch されないため mount 時に 1 度だけ強制ロード。
  // PR feat/notification-deep-link-completion / 2026-05-01。
  useEffect(() => {
    if (initialTabFromUrl !== 'overview') {
      loadTabData(initialTabFromUrl);
    }
  }, [initialTabFromUrl, loadTabData]);

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
  // feat/stakeholder-management: CRUD 直後に呼ぶ再取得ハンドラ
  const reloadStakeholders = useCallback(async () => {
    await stakeholders.load(true);
  }, [stakeholders]);

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    setEditError('');
    // feat/overview-tab-detail (PR-B): タグ入力欄 (CSV/読点区切り) を string[] に変換して送信。
    // parseTagsInput は projects-client.tsx と同じ規約 (DEVELOPER_GUIDE §5.10.2 全角読点も受容)。
    const parseTagsInput = (s: string): string[] =>
      s.split(/[,、]/).map((t) => t.trim()).filter((t) => t.length > 0);
    const { businessDomainTagsInput, techStackTagsInput, processTagsInput, contractType, ...rest } = editForm;
    const body = {
      ...rest,
      // PR-β / 項目 14: 契約形態 (空文字は null で送信、validator は nullable)
      contractType: contractType || null,
      businessDomainTags: parseTagsInput(businessDomainTagsInput),
      techStackTags: parseTagsInput(techStackTagsInput),
      processTags: parseTagsInput(processTagsInput),
    };
    const res = await withLoading(() =>
      fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) {
      const json = await res.json();
      const msg = json.error?.message || t('updateFailed');
      setEditError(msg);
      showError('プロジェクトの更新に失敗しました');
      return;
    }
    setIsEditOpen(false);
    showSuccess('プロジェクトを更新しました');
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
    const res = await withLoading(() =>
      fetch(`/api/projects/${project.id}?${params.toString()}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      showError('プロジェクトの削除に失敗しました');
      return;
    }
    showSuccess('プロジェクトを削除しました');
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
    if (res.ok) {
      showSuccess('プロジェクトの状態を更新しました');
      router.refresh();
    } else {
      showError('プロジェクトの状態更新に失敗しました');
    }
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
            // Phase A 要件 8: 「状態変更」Select はアクション型 (選択即実行) のため、
            //   value="" で常時 placeholder を表示し、選択後に内部名 (raw value) が
            //   残らないように制御する。SelectValue children に表示名マッピングを指定し、
            //   万一の即時表示でも PROJECT_STATUSES の表示名が出るよう二重化。
            <Select value="" onValueChange={handleStatusChange} disabled={isChangingStatus}>
              <SelectTrigger className="w-36 md:w-44">
                <SelectValue placeholder={t('statusChangePlaceholder')}>
                  {(value) => (value ? PROJECT_STATUSES[value as keyof typeof PROJECT_STATUSES] || value : t('statusChangePlaceholder'))}
                </SelectValue>
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
                <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent">{tAction('edit')}</DialogTrigger>
                {/* PR #87 横展開: grid-cols-2 + DateFieldWithActions を含むため max-w-[min(90vw,42rem)] に揃える */}
                <DialogContent className="max-w-[min(90vw,42rem)] max-h-[80vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>{t('editDialogTitle')}</DialogTitle>
                    <DialogDescription>{t('editDialogDescription')}</DialogDescription>
                  </DialogHeader>
                  <form onSubmit={handleEdit} className="space-y-4">
                    {editError && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{editError}</div>}
                    <div className="space-y-2">
                      <Label>{t('fieldName')}</Label>
                      <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required />
                    </div>
                    <div className="space-y-2">
                      {/* PR #111-2: 顧客は Customer マスタから選択 */}
                      <Label>{t('fieldCustomer')}</Label>
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
                      <Label>{t('fieldPurpose')}</Label>
                      <MarkdownTextarea value={editForm.purpose} onChange={(v) => setEditForm({ ...editForm, purpose: v })} previousValue={project.purpose} rows={3} required />
                    </div>
                    {/* feat/overview-tab-detail (PR-B): 背景 / スコープも編集可能に追加 (旧仕様は欠落していた) */}
                    <div className="space-y-2">
                      <Label>{t('fieldBackground')}</Label>
                      <MarkdownTextarea value={editForm.background} onChange={(v) => setEditForm({ ...editForm, background: v })} previousValue={project.background} rows={3} required />
                    </div>
                    <div className="space-y-2">
                      <Label>{t('fieldScope')}</Label>
                      <MarkdownTextarea value={editForm.scope} onChange={(v) => setEditForm({ ...editForm, scope: v })} previousValue={project.scope} rows={3} required />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>{t('fieldDevMethod')}</Label>
                        <select value={editForm.devMethod} onChange={(e) => setEditForm({ ...editForm, devMethod: e.target.value })} className={nativeSelectClass}>
                          {Object.entries(DEV_METHODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                      </div>
                      <div className="space-y-2">
                        {/* PR-β / 項目 14: 契約形態 (新設、未選択は空文字 → null 送信) */}
                        <Label>{t('fieldContractType')}</Label>
                        <select
                          value={editForm.contractType}
                          onChange={(e) => setEditForm({ ...editForm, contractType: e.target.value })}
                          className={nativeSelectClass}
                        >
                          <option value="">{t('contractTypeUnset')}</option>
                          {Object.entries(CONTRACT_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>{t('fieldPlannedStartDate')}</Label>
                        <DateFieldWithActions value={editForm.plannedStartDate} onChange={(v) => setEditForm({ ...editForm, plannedStartDate: v })} required hideClear />
                      </div>
                      <div className="space-y-2">
                        <Label>{t('fieldPlannedEndDate')}</Label>
                        <DateFieldWithActions value={editForm.plannedEndDate} onChange={(v) => setEditForm({ ...editForm, plannedEndDate: v })} required hideClear />
                      </div>
                    </div>
                    {/*
                      feat/overview-tab-detail (PR-B): 3 タグ入力 (作成 dialog と同一規約、§5.10.2)
                      PR #4 (T-03): 任意入力 + アコーディオン折りたたみ。LLM 自動補完が空欄を保存後に補完。
                    */}
                    <details className="rounded-md border bg-muted/30 p-3 space-y-2">
                      <summary className="cursor-pointer select-none text-sm font-medium">
                        {t('tagsAccordionTitle')}
                      </summary>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {t('tagsAccordionGuidance')}
                      </p>
                      <div className="space-y-2 pt-2">
                        <Label>{t('fieldBusinessDomainTags')} <span className="text-xs text-muted-foreground">{t('tagSeparatorHint')}</span></Label>
                        <Input value={editForm.businessDomainTagsInput} onChange={(e) => setEditForm({ ...editForm, businessDomainTagsInput: e.target.value })} placeholder={t('tagPlaceholderBusinessDomain')} maxLength={500} />
                      </div>
                      <div className="space-y-2 pt-2">
                        <Label>{t('fieldTechStackTags')} <span className="text-xs text-muted-foreground">{t('tagSeparatorHint')}</span></Label>
                        <Input value={editForm.techStackTagsInput} onChange={(e) => setEditForm({ ...editForm, techStackTagsInput: e.target.value })} placeholder={t('tagPlaceholderTechStack')} maxLength={500} />
                      </div>
                      <div className="space-y-2 pt-2">
                        <Label>{t('fieldProcessTags')} <span className="text-xs text-muted-foreground">{t('tagSeparatorHint')}</span></Label>
                        <Input value={editForm.processTagsInput} onChange={(e) => setEditForm({ ...editForm, processTagsInput: e.target.value })} placeholder={t('tagPlaceholderProcess')} maxLength={500} />
                      </div>
                    </details>
                    <Button type="submit" className="w-full">{t('editSubmit')}</Button>
                  </form>
                </DialogContent>
              </Dialog>
            </>
          )}
          {activeTab === 'overview' && canDeleteProject && (
            <Button variant="outline" className="text-destructive" onClick={openDeleteDialog}>{tAction('delete')}</Button>
          )}
          <Button variant="outline" onClick={() => router.push('/projects')}>
            {t('backToList')}
          </Button>
        </div>
      </div>

      {/* タブ - 全機能をタブ内に直接埋め込み */}
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        {/*
          fix/stakeholder-hotfix: タブ多数 + 狭い viewport で 1 タブだけ次行に折り返した際、
          基底 TabsTrigger の `flex-1` により単独タブが 100% 幅に伸びる不具合を解消。
          - h-auto         : 基底 `h-8` を解除し複数行レイアウトを許可
          - [&>*]:flex-none: 子 TabsTrigger の `flex-1` を打ち消しコンテンツ幅にする
        */}
        <TabsList className="h-auto flex-wrap [&>*]:flex-none">
          <TabsTrigger value="overview">{t('tabOverview')}</TabsTrigger>
          {canEdit && <TabsTrigger value="estimates">{t('tabEstimates')}</TabsTrigger>}
          {/*
            2026-04-30 (Task 1): ガントチャートを WBS タブ内ボタンから独立タブ化。
            「○○一覧」(資産プルダウン) と同じ responsive 方式:
              - PC (lg+): 「WBS管理」「ガントチャート」を独立タブとして表示
              - Mobile (lg-): 「進捗管理 ▼」プルダウンに WBS / ガントチャートを集約
          */}
          {/* PC 表示: 個別タブ (lg+) */}
          <TabsTrigger value="tasks" className="hidden lg:inline-flex">{t('tabTasks')}</TabsTrigger>
          <TabsTrigger value="gantt" className="hidden lg:inline-flex">{t('tabGantt')}</TabsTrigger>
          {/* Mobile 表示: 進捗管理プルダウン (lg-)。配下の値が active なら親も active 表示。 */}
          <Menu.Root>
            <Menu.Trigger
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-3 py-1 text-sm transition-colors hover:bg-accent lg:hidden',
                ['tasks', 'gantt'].includes(activeTab)
                  ? 'bg-background font-medium shadow-sm text-foreground'
                  : 'text-muted-foreground',
              )}
              aria-label={t('progressMenuAria')}
            >
              <span>{t('progressMenuLabel')}</span>
              <ChevronDownIcon className="size-3.5" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner sideOffset={4} className="isolate z-50">
                <Menu.Popup
                  className={cn(
                    'min-w-[180px] origin-(--transform-origin) rounded-md border bg-card text-card-foreground shadow-md',
                    'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95',
                    'data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
                  )}
                >
                  {[
                    { value: 'tasks', label: t('tabTasks') },
                    { value: 'gantt', label: t('tabGantt') },
                  ].map((opt) => (
                    <Menu.Item
                      key={opt.value}
                      onClick={() => handleTabChange(opt.value)}
                      className={cn(
                        'block w-full cursor-pointer px-4 py-2 text-left text-sm transition-colors hover:bg-accent',
                        activeTab === opt.value ? 'bg-accent font-medium' : 'text-foreground',
                      )}
                    >
                      {opt.label}
                    </Menu.Item>
                  ))}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
          {/*
            PR #167 (feat/asset-tab-responsive-mobile):
            画面幅 lg+ では各「○○一覧」を従来通り独立タブとして表示、
            画面幅 lg- (1024px 未満) では「資産 ▼」プルダウン 1 つに集約する
            (ナビ全体: 概要 / 見積もり / WBS管理 / 資産▼ / メンバー / ステークホルダー)。
            dashboard-header.tsx の 3 分類プルダウン pattern と同じ仕組み。
          */}
          {/* PC 表示: 個別タブ (lg+) */}
          <TabsTrigger value="risks" className="hidden lg:inline-flex">{t('tabRisks')}</TabsTrigger>
          <TabsTrigger value="issues" className="hidden lg:inline-flex">{t('tabIssues')}</TabsTrigger>
          <TabsTrigger value="retrospectives" className="hidden lg:inline-flex">{t('tabRetrospectives')}</TabsTrigger>
          <TabsTrigger value="knowledge" className="hidden lg:inline-flex">{t('tabKnowledge')}</TabsTrigger>
          {/* PR #65 核心機能: 過去プロジェクトから流用できるナレッジ・課題を常時提案 */}
          <TabsTrigger value="suggestions" className="hidden lg:inline-flex">{t('tabSuggestions')}</TabsTrigger>
          {/* Mobile 表示: 資産プルダウン (lg-)。配下の値が active なら親も active 表示。 */}
          <Menu.Root>
            <Menu.Trigger
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-3 py-1 text-sm transition-colors hover:bg-accent lg:hidden',
                ['risks', 'issues', 'retrospectives', 'knowledge', 'suggestions'].includes(activeTab)
                  ? 'bg-background font-medium shadow-sm text-foreground'
                  : 'text-muted-foreground',
              )}
              aria-label={t('assetsMenuAria')}
            >
              <span>{t('assetsMenuLabel')}</span>
              <ChevronDownIcon className="size-3.5" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner sideOffset={4} className="isolate z-50">
                <Menu.Popup
                  className={cn(
                    'min-w-[180px] origin-(--transform-origin) rounded-md border bg-card text-card-foreground shadow-md',
                    'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95',
                    'data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
                  )}
                >
                  {[
                    { value: 'risks', label: t('tabRisks') },
                    { value: 'issues', label: t('tabIssues') },
                    { value: 'retrospectives', label: t('tabRetrospectives') },
                    { value: 'knowledge', label: t('tabKnowledge') },
                    { value: 'suggestions', label: t('tabSuggestions') },
                  ].map((opt) => (
                    <Menu.Item
                      key={opt.value}
                      onClick={() => handleTabChange(opt.value)}
                      className={cn(
                        'block w-full cursor-pointer px-4 py-2 text-left text-sm transition-colors hover:bg-accent',
                        activeTab === opt.value ? 'bg-accent font-medium' : 'text-foreground',
                      )}
                    >
                      {opt.label}
                    </Menu.Item>
                  ))}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
          {(systemRole === 'admin' || projectRole === 'pm_tl') && (
            <TabsTrigger value="members">{t('tabMembers')}</TabsTrigger>
          )}
          {/* feat/stakeholder-management: ステークホルダー管理 (PMBOK 13)。
              個人情報・人物評を含むため PM/TL + admin のみ表示・閲覧可。 */}
          {(systemRole === 'admin' || projectRole === 'pm_tl') && (
            <TabsTrigger value="stakeholders">{t('tabStakeholders')}</TabsTrigger>
          )}
        </TabsList>

        {/* 概要タブ（サーバで既に取得済みの project のみ表示、fetch 不要）
            feat/overview-tab-detail (PR-B item 3+4): 作成時 11 フィールド全表示 + click-to-edit。
            isActualPmTl が true のセクションは hover でハイライトし、click で編集 dialog を開く。
            (admin 許可は PR-A 側のスコープなので、本 PR では isActualPmTl ベース) */}
        <TabsContent value="overview" className="mt-4 space-y-6">
          <div className="grid gap-6 md:grid-cols-2">
            <ClickableCard
              active={isActualPmTl}
              subtle
              className="rounded-lg border p-4"
              onClick={openEditDialog}
              title={t('overviewClickToEdit')}
            >
              <h3 className="mb-2 font-semibold">{t('overviewBasicInfo')}</h3>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t('fieldName')}</dt>
                  <dd className="font-medium">{project.name}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t('fieldCustomer')}</dt>
                  <dd>{project.customerName}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t('fieldDevMethod')}</dt>
                  <dd>{DEV_METHODS[project.devMethod as keyof typeof DEV_METHODS] || project.devMethod}</dd>
                </div>
                <div className="flex justify-between">
                  {/* PR-β / 項目 14: 契約形態 (未設定は ─ 表示) */}
                  <dt className="text-muted-foreground">{t('fieldContractType')}</dt>
                  <dd>
                    {project.contractType
                      ? (CONTRACT_TYPES[project.contractType as keyof typeof CONTRACT_TYPES] || project.contractType)
                      : '—'}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t('fieldPlannedStartDate')}</dt>
                  <dd>{project.plannedStartDate}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t('fieldPlannedEndDate')}</dt>
                  <dd>{project.plannedEndDate}</dd>
                </div>
              </dl>
            </ClickableCard>
            <ClickableCard
              active={isActualPmTl}
              subtle
              className="rounded-lg border p-4"
              onClick={openEditDialog}
              title={t('overviewClickToEdit')}
            >
              <h3 className="mb-2 font-semibold">{t('fieldPurpose')}</h3>
              <div className="text-sm text-foreground">
                <MarkdownDisplay value={project.purpose} />
              </div>
            </ClickableCard>
            <ClickableCard
              active={isActualPmTl}
              subtle
              className="rounded-lg border p-4"
              onClick={openEditDialog}
              title={t('overviewClickToEdit')}
            >
              <h3 className="mb-2 font-semibold">{t('fieldBackground')}</h3>
              <div className="text-sm text-foreground">
                <MarkdownDisplay value={project.background} />
              </div>
            </ClickableCard>
            <ClickableCard
              active={isActualPmTl}
              subtle
              className="rounded-lg border p-4"
              onClick={openEditDialog}
              title={t('overviewClickToEdit')}
            >
              <h3 className="mb-2 font-semibold">{t('fieldScope')}</h3>
              <div className="text-sm text-foreground">
                <MarkdownDisplay value={project.scope} />
              </div>
              {project.outOfScope && (
                <>
                  <h3 className="mb-2 mt-4 font-semibold">{t('fieldOutOfScope')}</h3>
                  <div className="text-sm text-foreground">
                    <MarkdownDisplay value={project.outOfScope} />
                  </div>
                </>
              )}
            </ClickableCard>
          </div>
          {/* feat/overview-tab-detail (PR-B item 3): 業務ドメイン/技術スタック/工程の 3 タグセクション (新設) */}
          <div className="grid gap-6 md:grid-cols-3">
            <ClickableCard
              active={isActualPmTl}
              subtle
              className="rounded-lg border p-4"
              onClick={openEditDialog}
              title={t('overviewClickToEdit')}
            >
              <h3 className="mb-2 font-semibold">{t('fieldBusinessDomainTags')}</h3>
              {project.businessDomainTags.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {project.businessDomainTags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t('overviewNotSet')}</p>
              )}
            </ClickableCard>
            <ClickableCard
              active={isActualPmTl}
              subtle
              className="rounded-lg border p-4"
              onClick={openEditDialog}
              title={t('overviewClickToEdit')}
            >
              <h3 className="mb-2 font-semibold">{t('fieldTechStackTags')}</h3>
              {project.techStackTags.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {project.techStackTags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t('overviewNotSet')}</p>
              )}
            </ClickableCard>
            <ClickableCard
              active={isActualPmTl}
              subtle
              className="rounded-lg border p-4"
              onClick={openEditDialog}
              title={t('overviewClickToEdit')}
            >
              <h3 className="mb-2 font-semibold">{t('fieldProcessTags')}</h3>
              {project.processTags.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {project.processTags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t('overviewNotSet')}</p>
              )}
            </ClickableCard>
          </div>
          {project.notes && (
            <ClickableCard
              active={isActualPmTl}
              subtle
              className="rounded-lg border p-4"
              onClick={openEditDialog}
              title={t('overviewClickToEdit')}
            >
              <h3 className="mb-2 font-semibold">{t('fieldNotes')}</h3>
              <div className="text-sm text-foreground">
                <MarkdownDisplay value={project.notes} />
              </div>
            </ClickableCard>
          )}

          {/* PR #64 Phase 2: プロジェクト関連 URL (メインドキュメント 1 本 + 参考資料 複数) */}
          <div className="rounded-lg border p-4 space-y-4">
            <h3 className="font-semibold">{t('relatedUrlSection')}</h3>
            <SingleUrlField
              entityType="project"
              entityId={project.id}
              slot="primary"
              canEdit={canEdit}
              label={t('relatedUrlMainLabel')}
              defaultDisplayName={t('relatedUrlMainDefault')}
            />
            <AttachmentList
              entityType="project"
              entityId={project.id}
              canEdit={canEdit}
              label={t('relatedUrlOthers')}
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

        {/* 2026-04-30 (Task 1): ガントチャートを独立タブとして復活。
            WBS と同じ tasks tree + members を使うため lazy fetch も同じ load() を共用。 */}
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

        {/* feat/stakeholder-management: ステークホルダー管理タブ (PM/TL + admin のみ)。
            内部メンバー紐付けプルダウンに members を使うため、両 lazy fetch をネストする。 */}
        {(systemRole === 'admin' || projectRole === 'pm_tl') && (
          <TabsContent value="stakeholders" className="mt-4">
            <LazyTabContent state={stakeholders.state}>
              {(stakeholdersData) => (
                <LazyTabContent state={members.state}>
                  {(membersData) => (
                    <StakeholdersClient
                      projectId={project.id}
                      stakeholders={stakeholdersData}
                      members={membersData}
                      onReload={reloadStakeholders}
                      /* stakeholderId は URL から useAutoOpenDialog が自前で読む */
                    />
                  )}
                </LazyTabContent>
              )}
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
            <DialogTitle>{t('suggestionsModalTitle')}</DialogTitle>
            <DialogDescription>
              {t('suggestionsModalDescription')}
            </DialogDescription>
          </DialogHeader>
          <SuggestionsPanel projectId={project.id} canAdopt={canCreate} />
          <div className="mt-4 flex justify-end">
            <Button variant="outline" onClick={closeSuggestionsModal}>
              {tAction('close')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* PR #89: プロジェクト削除 細粒度カスケード確認ダイアログ */}
      <Dialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <DialogContent className="max-w-[min(90vw,36rem)]">
          <DialogHeader>
            <DialogTitle>{t('deleteDialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('deleteDialogDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
              <div className="mb-1 font-medium text-foreground">{t('deleteForcedHeading')}</div>
              {t('deleteForcedItems')}
            </div>
            <div className="space-y-2 rounded-md border border-border p-3">
              <div className="mb-1 text-sm font-medium">{t('deleteCascadeHeading')}</div>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={cascadeRisks}
                  onChange={(e) => setCascadeRisks(e.target.checked)}
                  className="mt-0.5 rounded"
                />
                <span>{t('deleteCascadeRisks')}</span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={cascadeIssues}
                  onChange={(e) => setCascadeIssues(e.target.checked)}
                  className="mt-0.5 rounded"
                />
                <span>{t('deleteCascadeIssues')}</span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={cascadeRetros}
                  onChange={(e) => setCascadeRetros(e.target.checked)}
                  className="mt-0.5 rounded"
                />
                <span>{t('deleteCascadeRetros')}</span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={cascadeKnowledge}
                  onChange={(e) => setCascadeKnowledge(e.target.checked)}
                  className="mt-0.5 rounded"
                />
                <span>
                  {t('deleteCascadeKnowledge')}
                </span>
              </label>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setIsDeleteOpen(false)}>
              {tAction('cancel')}
            </Button>
            <Button
              variant="outline"
              className="border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={handleConfirmDelete}
            >
              {t('deleteConfirmButton')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
