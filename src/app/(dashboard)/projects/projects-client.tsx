'use client';

/**
 * プロジェクト一覧画面 (アプリのトップ相当) のクライアントコンポーネント。
 *
 * 役割:
 *   全プロジェクトの一覧表示 + 検索 (顧客名・プロジェクト名) + ステータス絞込 +
 *   新規作成ダイアログ。各行クリックでプロジェクト詳細画面へ遷移。
 *
 * 表示範囲:
 *   ログイン済ユーザは全プロジェクトを閲覧可 (詳細・編集権限はメンバーシップ依存)。
 *
 * 認可: ログイン済ユーザは作成 + 一覧可。詳細以降の操作は project_members で判定。
 * API: /api/projects (GET/POST)
 *
 * 関連:
 *   - SPECIFICATION.md (プロジェクト一覧 / 新規作成)
 *   - DESIGN.md §6 (状態遷移)
 *   - DESIGN.md §23 (核心機能 / 新規作成時の提案サジェスト連動)
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { nativeSelectClass } from '@/components/ui/native-select-style';
// PR #126: 顧客件数が増える想定のため SearchableSelect を使用
import { SearchableSelect } from '@/components/ui/searchable-select';
// fix/project-create-customer-validation: 重複定義を集約、全角読点 (、) 対応追加
import { parseTagsInput } from '@/lib/parse-tags';
import {
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SortableResizableHead } from '@/components/sort/sortable-resizable-head';
import { useMultiSort } from '@/components/sort/use-multi-sort';
import { multiSort } from '@/lib/multi-sort';
import { ResizableTableShell } from '@/components/common/resizable-table-shell';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { PROJECT_STATUSES, DEV_METHODS, CONTRACT_TYPES } from '@/types';
import type { ProjectDTO } from '@/services/project.service';
import { DateFieldWithActions } from '@/components/ui/date-field-with-actions';
import {
  StagedAttachmentsInput,
  persistStagedAttachments,
  type StagedAttachment,
} from '@/components/attachments/staged-attachments-input';

type CustomerOption = { id: string; name: string };

type Props = {
  initialProjects: ProjectDTO[];
  initialTotal: number;
  isAdmin: boolean;
  // PR #111-2: 新規作成ダイアログの顧客選択肢
  customers: CustomerOption[];
};

// PR feat/sortable-columns: カラム列キー → 行値の getter。multiSort の比較に使う。
function getProjectSortValue(p: ProjectDTO, columnKey: string): unknown {
  switch (columnKey) {
    case 'name': return p.name;
    case 'customer': return p.customerName ?? '';
    case 'devMethod': return p.devMethod;
    case 'status': return p.status;
    case 'plannedStartDate': return p.plannedStartDate ?? '';
    case 'plannedEndDate': return p.plannedEndDate ?? '';
    default: return null;
  }
}

const statusColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  planning: 'outline',
  estimating: 'outline',
  scheduling: 'secondary',
  executing: 'default',
  completed: 'secondary',
  retrospected: 'secondary',
  closed: 'destructive',
};

export function ProjectsClient({
  initialProjects,
  initialTotal,
  isAdmin,
  customers,
}: Props) {
  const router = useRouter();
  const t = useTranslations('project');
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [error, setError] = useState('');
  // PR feat/sortable-columns (2026-05-01): カラムソート (sessionStorage 永続化、複数列対応)。
  const { sortState, setSortColumn } = useMultiSort('sort:projects');
  const sortedProjects = multiSort(initialProjects, sortState, getProjectSortValue);

  const [form, setForm] = useState({
    name: '',
    customerId: '',
    purpose: '',
    background: '',
    scope: '',
    devMethod: 'scratch',
    // PR-β / 項目 14: 契約形態 (新設、新規作成時は空 = 後で編集して設定)
    contractType: '' as '' | 'quasi_mandate' | 'lump_sum' | 'ses' | 'other',
    plannedStartDate: '',
    plannedEndDate: '',
    // PR #65: 核心機能 (提案型サービス) のタグ入力。カンマ区切り文字列で受け取り、
    // 送信時に string[] へ変換する。空要素は除外。
    businessDomainTagsInput: '',
    techStackTagsInput: '',
    processTagsInput: '',
  });

  // fix/project-create-customer-validation: 重複定義を `@/lib/parse-tags` に集約。
  // 半角カンマ `,` に加え全角読点 `、` (日本語入力中に自然に混ざる) も区切りとして受容する。

  // PR #67: 作成ダイアログで入力された添付 URL を staging。
  // プロジェクト作成成功後に entityId を使って一括 POST する。
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>([]);

  async function handleSearch() {
    const params = new URLSearchParams();
    if (keyword) params.set('keyword', keyword);
    if (statusFilter) params.set('status', statusFilter);
    router.push(`/projects?${params.toString()}`);
    router.refresh();
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    // クライアント側で事前バリデーション (HTML5 `required` で拾えない SearchableSelect 用)。
    // 空 customerId で POST すると API は Zod UUID 検証で 400 を返し、その 400 がブラウザの
    // Network/Console に出力されてしまう (fetch は 4xx でも throw しないがブラウザは必ず表示)。
    // 本サービスのエラー情報最小化方針に反するため、サーバに届く前に弾いて UI 上のみで通知する。
    if (!form.customerId) {
      setError(t('customerSelectError'));
      return;
    }

    // タグは入力欄の生文字列 (form.*TagsInput) をカンマ分割して送信する
    const payload = {
      name: form.name,
      customerId: form.customerId,
      purpose: form.purpose,
      background: form.background,
      scope: form.scope,
      devMethod: form.devMethod,
      // PR-β / 項目 14: 契約形態 (空文字は null で送信、validator は nullable)
      contractType: form.contractType || null,
      plannedStartDate: form.plannedStartDate,
      plannedEndDate: form.plannedEndDate,
      businessDomainTags: parseTagsInput(form.businessDomainTagsInput),
      techStackTags: parseTagsInput(form.techStackTagsInput),
      processTags: parseTagsInput(form.processTagsInput),
    };

    const res = await withLoading(() =>
      fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );

    if (!res.ok) {
      const json = await res.json();
      const msg = json.error?.message || json.error?.details?.[0]?.message || t('createFailed');
      setError(msg);
      showError('プロジェクトの作成に失敗しました');
      return;
    }

    const json = await res.json();
    showSuccess('プロジェクトを作成しました');

    // PR #67: 作成成功直後にステージされた添付を一括 POST
    if (stagedAttachments.length > 0 && json.data?.id) {
      await persistStagedAttachments({
        entityType: 'project',
        entityId: json.data.id,
        items: stagedAttachments,
      });
    }
    setStagedAttachments([]);

    setIsCreateOpen(false);
    setForm({
      name: '',
      customerId: '',
      purpose: '',
      background: '',
      scope: '',
      devMethod: 'scratch',
      contractType: '' as '' | 'quasi_mandate' | 'lump_sum' | 'ses' | 'other',
      plannedStartDate: '',
      plannedEndDate: '',
      businessDomainTagsInput: '',
      techStackTagsInput: '',
      processTagsInput: '',
    });
    // PR #65: 新規作成直後は ?suggestions=1 を付けて遷移、詳細画面側で提案モーダルを表示
    router.push(`/projects/${json.data.id}?suggestions=1`);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {/* Phase A 要件 6: h2 ページタイトル削除 (ナビタブ名と重複のため) */}
      <div className="flex items-center justify-end">
        {isAdmin && (
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">{t('createButton')}</DialogTrigger>
            {/* PR #87 横展開: grid-cols-2 + DateFieldWithActions を含むため max-w-[min(90vw,42rem)] に揃える */}
            <DialogContent className="max-w-[min(90vw,42rem)] max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{t('createDialogTitle')}</DialogTitle>
                <DialogDescription>{t('createDialogDescription')}</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4">
                {error && (
                  <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
                )}
                <div className="space-y-2">
                  {/* fix/project-create-customer-validation: htmlFor/id で a11y リンク付与
                      (screen reader 読み上げ + Playwright getByLabel が解決可能に) */}
                  <Label htmlFor="project-create-name">{t('fieldName')}</Label>
                  <Input
                    id="project-create-name"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    maxLength={100}
                    required
                  />
                </div>
                <div className="space-y-2">
                  {/* PR #111-2: 顧客は Customer マスタから選択。未登録の場合は /customers で先に作成する。
                      PR #126: 顧客件数が増える想定のため SearchableSelect を使用 (viewport 比で検索欄を動的表示) */}
                  <Label htmlFor="project-create-customer">{t('fieldCustomer')}</Label>
                  <SearchableSelect
                    id="project-create-customer"
                    value={form.customerId}
                    onValueChange={(v) => setForm({ ...form, customerId: v })}
                    options={customers.map((c) => ({ value: c.id, label: c.name }))}
                    placeholder={t('customerSelectPlaceholder')}
                    aria-label={t('customerSelectAriaLabel')}
                  />
                  {customers.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t('customerEmptyHintPrefix')}
                      <Link href="/customers" className="text-info hover:underline">
                        {t('customerEmptyHintLink')}
                      </Link>
                      {t('customerEmptyHintSuffix')}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="project-create-purpose">{t('fieldPurpose')}</Label>
                  <textarea
                    id="project-create-purpose"
                    className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={form.purpose}
                    onChange={(e) => setForm({ ...form, purpose: e.target.value })}
                    rows={3}
                    maxLength={2000}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="project-create-background">{t('fieldBackground')}</Label>
                  <textarea
                    id="project-create-background"
                    className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={form.background}
                    onChange={(e) => setForm({ ...form, background: e.target.value })}
                    rows={3}
                    maxLength={2000}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="project-create-scope">{t('fieldScope')}</Label>
                  <textarea
                    id="project-create-scope"
                    className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={form.scope}
                    onChange={(e) => setForm({ ...form, scope: e.target.value })}
                    rows={3}
                    maxLength={2000}
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="project-create-devmethod">{t('fieldDevMethod')}</Label>
                    <select id="project-create-devmethod" value={form.devMethod} onChange={(e) => setForm({ ...form, devMethod: e.target.value })} className={nativeSelectClass}>
                      {Object.entries(DEV_METHODS).map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    {/* PR-β / 項目 14: 契約形態 (新設、未選択は空文字 → null 送信) */}
                    <Label htmlFor="project-create-contracttype">{t('fieldContractType')}</Label>
                    <select
                      id="project-create-contracttype"
                      value={form.contractType}
                      onChange={(e) => setForm({ ...form, contractType: e.target.value as typeof form.contractType })}
                      className={nativeSelectClass}
                    >
                      <option value="">{t('contractTypeUnset')}</option>
                      {Object.entries(CONTRACT_TYPES).map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>{t('fieldPlannedStartDate')}</Label>
                    <DateFieldWithActions
                      value={form.plannedStartDate}
                      onChange={(v) => setForm({ ...form, plannedStartDate: v })}
                      required
                      hideClear
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('fieldPlannedEndDate')}</Label>
                    <DateFieldWithActions
                      value={form.plannedEndDate}
                      onChange={(v) => setForm({ ...form, plannedEndDate: v })}
                      required
                      hideClear
                    />
                  </div>
                </div>
                {/*
                  PR #65: 提案型サービス (核心機能) のためのタグ入力。
                  PR #4 (T-03): 任意入力に変更 + アコーディオン折りたたみで負担軽減。
                    LLM 自動タグ抽出 (PR #220 / #223) が空欄を保存後に自動補完するため、
                    手動入力は「自分のドメイン知識を反映したい場合」のみ推奨。
                */}
                <details className="rounded-md border bg-muted/30 p-3 space-y-2">
                  <summary className="cursor-pointer select-none text-sm font-medium">
                    {t('tagsAccordionTitle')}
                  </summary>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('tagsAccordionGuidance')}
                  </p>
                  <div className="space-y-2 pt-2">
                    <Label htmlFor="project-create-business-domain-tags">{t('fieldBusinessDomainTags')} <span className="text-xs text-muted-foreground">{t('tagSeparatorHintSuggestion')}</span></Label>
                    <Input
                      id="project-create-business-domain-tags"
                      value={form.businessDomainTagsInput}
                      onChange={(e) => setForm({ ...form, businessDomainTagsInput: e.target.value })}
                      placeholder={t('tagPlaceholderBusinessDomain')}
                      maxLength={500}
                    />
                  </div>
                  <div className="space-y-2 pt-2">
                    <Label htmlFor="project-create-tech-stack-tags">{t('fieldTechStackTags')} <span className="text-xs text-muted-foreground">{t('tagSeparatorHintSuggestion')}</span></Label>
                    <Input
                      id="project-create-tech-stack-tags"
                      value={form.techStackTagsInput}
                      onChange={(e) => setForm({ ...form, techStackTagsInput: e.target.value })}
                      placeholder={t('tagPlaceholderTechStackFull')}
                      maxLength={500}
                    />
                  </div>
                  <div className="space-y-2 pt-2">
                    <Label htmlFor="project-create-process-tags">{t('fieldProcessTags')} <span className="text-xs text-muted-foreground">{t('tagSeparatorHintSuggestion')}</span></Label>
                    <Input
                      id="project-create-process-tags"
                      value={form.processTagsInput}
                      onChange={(e) => setForm({ ...form, processTagsInput: e.target.value })}
                      placeholder={t('tagPlaceholderProcessFull')}
                      maxLength={500}
                    />
                  </div>
                </details>
                {/* PR #67: 作成と同時に関連 URL を登録可能 */}
                <StagedAttachmentsInput
                  value={stagedAttachments}
                  onChange={setStagedAttachments}
                />
                <Button type="submit" className="w-full">
                  {t('createSubmit')}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {/* 検索・フィルタ */}
      <div className="flex gap-4">
        <Input
          placeholder={t('searchPlaceholder')}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          className="max-w-xs"
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? '')}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder={t('statusFilterAll')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">{t('statusFilterAll')}</SelectItem>
            {Object.entries(PROJECT_STATUSES).map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={handleSearch}>
          {t('searchButton')}
        </Button>
      </div>

      {/*
        PR #128a: PC (md+) は既存の ResizableTable (列幅ドラッグ可能) を維持、
        モバイル (md 未満) は並列でカード表示。PC UX は一切変更していない。
      */}
      <div className="hidden md:block">
        <ResizableTableShell tableKey="projects">
            <TableHeader>
              <TableRow>
                <SortableResizableHead columnKey="name" defaultWidth={220} label={t('fieldName')} sortState={sortState} onSortChange={setSortColumn} />
                <SortableResizableHead columnKey="customer" defaultWidth={160} label={t('fieldCustomer')} sortState={sortState} onSortChange={setSortColumn} />
                <SortableResizableHead columnKey="devMethod" defaultWidth={140} label={t('fieldDevMethod')} sortState={sortState} onSortChange={setSortColumn} />
                <SortableResizableHead columnKey="status" defaultWidth={110} label={t('fieldStatus')} sortState={sortState} onSortChange={setSortColumn} />
                <SortableResizableHead columnKey="plannedStartDate" defaultWidth={120} label={t('fieldPlannedStartDate')} sortState={sortState} onSortChange={setSortColumn} />
                <SortableResizableHead columnKey="plannedEndDate" defaultWidth={120} label={t('fieldPlannedEndDate')} sortState={sortState} onSortChange={setSortColumn} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedProjects.map((project) => (
                <TableRow key={project.id}>
                  <TableCell>
                    <Link
                      href={`/projects/${project.id}`}
                      className="font-medium text-info hover:underline"
                    >
                      {project.name}
                    </Link>
                  </TableCell>
                  <TableCell>{project.customerName}</TableCell>
                  <TableCell>
                    {DEV_METHODS[project.devMethod as keyof typeof DEV_METHODS] || project.devMethod}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusColors[project.status] || 'secondary'}>
                      {PROJECT_STATUSES[project.status as keyof typeof PROJECT_STATUSES] ||
                        project.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{project.plannedStartDate}</TableCell>
                  <TableCell>{project.plannedEndDate}</TableCell>
                </TableRow>
              ))}
              {sortedProjects.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    {t('listEmpty')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
        </ResizableTableShell>
      </div>

      {/* PR #128a: モバイル (md 未満) 専用のカードビュー */}
      <div className="space-y-2 md:hidden" role="list" aria-label={t('listTitle')}>
        {initialProjects.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('listEmpty')}
          </p>
        ) : (
          initialProjects.map((project) => (
            <Link
              key={project.id}
              href={`/projects/${project.id}`}
              role="listitem"
              className="block rounded-md border bg-card p-3 text-sm transition-colors hover:bg-muted"
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <span className="flex-1 font-medium text-info">{project.name}</span>
                <Badge variant={statusColors[project.status] || 'secondary'}>
                  {PROJECT_STATUSES[project.status as keyof typeof PROJECT_STATUSES] ||
                    project.status}
                </Badge>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-xs text-muted-foreground">{t('fieldCustomer')}</dt>
                <dd className="text-foreground">{project.customerName || '-'}</dd>
                <dt className="text-xs text-muted-foreground">{t('fieldDevMethod')}</dt>
                <dd className="text-foreground">
                  {DEV_METHODS[project.devMethod as keyof typeof DEV_METHODS] || project.devMethod}
                </dd>
                <dt className="text-xs text-muted-foreground">{t('fieldPeriod')}</dt>
                <dd className="text-foreground">
                  {project.plannedStartDate || '-'} 〜 {project.plannedEndDate || '-'}
                </dd>
              </dl>
            </Link>
          ))
        )}
      </div>
      {initialTotal > 20 && (
        <p className="text-sm text-muted-foreground">{t('totalCountHint', { total: initialTotal, shown: 20 })}</p>
      )}
    </div>
  );
}
