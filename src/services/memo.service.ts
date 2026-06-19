/**
 * メモサービス (PR #70)
 *
 * 方針:
 *   - 個人メモ (Memo) はプロジェクトに紐付かない個人のノート置き場
 *   - visibility='private' (既定): 作成者のみ閲覧可、admin も含め他者不可視
 *   - visibility='public': 全ログインユーザが「全メモ」画面で閲覧可
 *   - 編集は常に作成者本人のみ (admin 特権なし)
 *   - 削除: 作成者本人 OR admin (ただし admin は visibility='public' の他人メモに限る、
 *     全メモ画面のモデレーション用。feat/crud-permission-redesign, 2026-05-20 で追加)
 *   - admin であっても他人の visibility='private' メモは参照不可・削除不可 (プライバシー保護)
 *   - タグは持たせない (業務知見判断は人間ベース、PR #70 要件)
 *
 * 2026-05-15:
 *   - 他資産 (Knowledge / RiskIssue / Retrospective) と同様に embedding 生成 + 提案エンジン
 *     候補化に対応 (本サービスでは memo-embedding featureUnit で課金カウント)。
 *   - 「公開範囲: 自分のみ」(visibility='private') は提案エンジン対象外のため embedding
 *     生成しない (Voyage API 課金回避)。Knowledge の draft 等価ロジック。
 *   - 「公開範囲: 全メンバー」(visibility='public') かつ embedding 対象項目 (title / content)
 *     変更時のみ embedding を生成 / 再生成する。
 */

import { prisma } from '@/lib/db';
import { afterSafe } from '@/lib/after-safe';
import { assertAssigneeTenant } from '@/lib/assignee-validation';
import { generateAndPersistEntityEmbedding, generateAndPersistBatchEmbeddings } from './embedding.service';
import { deleteAssetLinksForEntity } from './asset-link.service';
import type { CreateMemoInput, UpdateMemoInput } from '@/lib/validators/memo';

/**
 * (2026-05-15) Memo の embedding 用 text 合成 helper。
 *
 * 意味検索の質を高めるため、Memo の主要な意味を担う text フィールドを改行結合して
 * Voyage AI に渡す。Memo は title + content のシンプルな構造で、提案エンジンでは
 * 「title が要旨」「content が詳細」として両方を意味比較に投入する。
 *
 * 月初 backfill バッチ (embedding-backfill.service.ts) からも参照されるため export する。
 */
export function composeMemoText(fields: {
  title: string;
  content: string;
}): string {
  return [fields.title, fields.content]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('\n\n');
}

export type MemoDTO = {
  id: string;
  userId: string;
  authorName: string | null;
  title: string;
  content: string;
  visibility: string;
  // feat/asset-assignee-expansion (2026-05-26): 担当者 (作成者と並ぶ編集権限保持者)
  assigneeId: string | null;
  assigneeName: string | null;
  createdAt: string;
  updatedAt: string;
  /** 閲覧者が本人かどうか (UI で編集ボタン等の出し分け用) */
  isMine: boolean;
  /** feat/asset-assignee-expansion (2026-05-26): 編集可否 (= 本人 OR 担当者) */
  canEdit: boolean;
};

function toDTO(
  m: {
    id: string;
    userId: string;
    title: string;
    content: string;
    visibility: string;
    assigneeId: string | null;
    assignee?: { name: string } | null;
    createdAt: Date;
    updatedAt: Date;
    author?: { name: string } | null;
  },
  viewerUserId: string,
): MemoDTO {
  return {
    id: m.id,
    userId: m.userId,
    authorName: m.author?.name ?? null,
    title: m.title,
    content: m.content,
    visibility: m.visibility,
    assigneeId: m.assigneeId,
    assigneeName: m.assignee?.name ?? null,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    isMine: m.userId === viewerUserId,
    // feat/asset-assignee-expansion (2026-05-26): 本人 OR 担当者なら編集可
    canEdit: m.userId === viewerUserId || m.assigneeId === viewerUserId,
  };
}

/**
 * 「メモ」画面 (/memos) 用 — 閲覧ユーザ自身のメモのみ返す (PR #71)。
 * private / public 問わず、自分が作成した全件。ここは編集/削除可能な個人管理画面。
 *
 * 2026-05-09 feedback: テナント越境防止のため `viewerTenantId` でフィルタ。
 *   ユーザは自テナント内でしかメモを作成できないため通常 no-op だが、テナント間で
 *   userId が衝突した場合のフェイルセーフとして必須 (defense-in-depth)。
 */
export async function listMyMemos(
  viewerUserId: string,
  viewerTenantId: string,
): Promise<MemoDTO[]> {
  const rows = await prisma.memo.findMany({
    where: { deletedAt: null, userId: viewerUserId, tenantId: viewerTenantId },
    include: {
      author: { select: { name: true } },
      // feat/asset-assignee-expansion (2026-05-26): 担当者氏名表示用
      assignee: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((m) => toDTO(m, viewerUserId));
}

/**
 * 「全メモ」画面 (/all-memos) 用 — visibility='public' のメモを自テナント内で全件返す。
 * 自分の公開メモも含む (自分のメモでも「公開範囲=全メモに公開」に設定したものは同テナント全員が閲覧対象)。
 * この画面は read-only。編集/削除は個別の /memos 画面側で行う。
 *
 * 2026-05-09 feedback: テナント越境防止のため `viewerTenantId` でフィルタ。
 *   旧実装はテナントフィルタ無しで他テナントの公開メモが見えてしまっていた (重大バグ)。
 */
export async function listPublicMemos(
  viewerUserId: string,
  viewerTenantId: string,
): Promise<MemoDTO[]> {
  const rows = await prisma.memo.findMany({
    where: { deletedAt: null, visibility: 'public', tenantId: viewerTenantId },
    include: {
      author: { select: { name: true } },
      // feat/asset-assignee-expansion (2026-05-26): 担当者氏名表示用
      assignee: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((m) => toDTO(m, viewerUserId));
}

/**
 * 単一メモ取得 (権限チェック込み)。
 * 本人 or (public かつ自分以外) のみ取得可。private な他人のメモはアクセス不可。
 */
export async function getMemoForViewer(
  memoId: string,
  viewerUserId: string,
  viewerTenantId: string,
): Promise<MemoDTO | null> {
  // 2026-05-09 feedback Phase 2-4: 越境取得を遮断するため where に tenantId 必須化。
  const m = await prisma.memo.findFirst({
    where: { id: memoId, deletedAt: null, tenantId: viewerTenantId },
    include: {
      author: { select: { name: true } },
      // feat/asset-assignee-expansion (2026-05-26): 担当者氏名表示用
      assignee: { select: { name: true } },
    },
  });
  if (!m) return null;
  if (m.userId !== viewerUserId && m.visibility !== 'public') {
    return null; // 非公開な他人のメモは「存在しない」扱い (情報漏洩防止)
  }
  return toDTO(m, viewerUserId);
}

export async function createMemo(
  input: CreateMemoInput,
  userId: string,
  tenantId: string,
): Promise<MemoDTO> {
  // 2026-05-09 feedback Phase 2-4: data.tenantId を明示し schema DB DEFAULT 暗黙依存を解消。
  const visibility = input.visibility ?? 'private';
  // feat/asset-assignee-expansion (2026-05-26) severity-1 防御:
  //   private memo に他人 (= userId 以外) を assignee 指定すると、その担当者は memo を
  //   参照不可になる (private は本人のみ閲覧)。UI 上は selector 非表示だが API 直叩きを
  //   弾くため service 層で reject する (memo.service.ts migration コメントの方針実装)。
  if (visibility === 'private' && input.assigneeId && input.assigneeId !== userId) {
    throw new Error('PRIVATE_MEMO_ASSIGNEE_FORBIDDEN');
  }
  // feat/asset-assignee-expansion (2026-05-26) severity-1 越境防御:
  //   担当者として他テナントのユーザを指定する攻撃を service 層で reject。
  await assertAssigneeTenant(input.assigneeId, tenantId);
  const created = await prisma.memo.create({
    data: {
      tenantId,
      userId,
      title: input.title,
      content: input.content,
      visibility,
      // feat/asset-assignee-expansion (2026-05-26): 作成時から担当者指定可
      assigneeId: input.assigneeId ?? null,
    },
    include: {
      author: { select: { name: true } },
      // feat/asset-assignee-expansion (2026-05-26): 担当者氏名表示用
      assignee: { select: { name: true } },
    },
  });

  // (2026-05-15) 公開範囲='全メンバー' のときのみ embedding を生成 + 保存。
  //   公開範囲='自分のみ' (private) は提案エンジン対象外 → Voyage API 課金回避。
  //   失敗時はサイレントにスキップ (本体保存は成功、月初 backfill cron で補完)。
  // PR-9 perf (2026-05-29 / ADR-0026): embedding 生成を `after()` で非同期化。
  if (visibility === 'public') {
    afterSafe(
      generateAndPersistEntityEmbedding({
        table: 'memos',
        rowId: created.id,
        tenantId,
        userId,
        text: composeMemoText({ title: input.title, content: input.content }),
        featureUnit: 'memo-embedding',
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[memo.create] async embedding failed (monthly backfill will retry)', err);
      }),
    );
  }

  return toDTO(created, userId);
}

/**
 * 更新 (作成者のみ)。呼び出し側で認可済み前提だが、二重防御として userId 一致を確認。
 *
 * 2026-05-15: 他資産と同様に embedding を生成 / 再生成する。判定マトリクス:
 *   - 新 visibility = private          → 生成しない (= API 呼出なし、課金なし)
 *   - private → public                 → 生成 (初回 embedding 化)
 *   - public → public + text 変更       → 再生成
 *   - public → public + text 変更なし   → 生成しない (LLM 課金回避)
 *   - public → private                 → 生成しない (既存 embedding は保持)
 */
export async function updateMemo(
  memoId: string,
  input: UpdateMemoInput,
  userId: string,
  viewerTenantId: string,
): Promise<MemoDTO | null> {
  // 2026-05-09 feedback Phase 2-4: 越境編集を遮断するため where に tenantId 必須化。
  // 2026-05-11: visibility 連動の title 必須チェックのため title も取得 (defense-in-depth)。
  // 2026-05-15: embedding 再生成判定のため content と visibility も取得。
  const existing = await prisma.memo.findFirst({
    where: { id: memoId, deletedAt: null, tenantId: viewerTenantId },
    // feat/asset-assignee-expansion (2026-05-26): assigneeId も認可判定対象
    select: { userId: true, assigneeId: true, title: true, content: true, visibility: true },
  });
  if (!existing) return null;
  // feat/asset-assignee-expansion (2026-05-26): 「作成者 (userId) OR 担当者 (assigneeId)」を編集可。
  //   memo は visibility='private' のとき他人参照不可なので、通常 assigneeId は public memo 用。
  //   service 層では assigneeId === userId の場合も編集を許可する (= 引継ぎ完了後の担当者更新)。
  if (existing.userId !== userId && existing.assigneeId !== userId) {
    return null; // 他人のメモは編集不可 (= 作成者でも担当者でもない)
  }

  // 2026-05-11 defense-in-depth: 「全メンバー」(public) 化する更新で、
  //   title が input でも DB でも空になる場合は拒否。
  //   通常 validator (updateMemoSchema) が title=='' を弾くが、API 直叩きで
  //   `{ visibility: 'public' }` のみ送られて DB の既存 title が空のケースを救う。
  if (input.visibility === 'public') {
    const effectiveTitle = input.title !== undefined ? input.title : existing.title;
    if (!effectiveTitle || effectiveTitle.trim().length === 0) {
      throw new Error('PUBLIC_REQUIRES_TITLE');
    }
    // v1.3.0 軽量入力 (2026-06-19): public 化時は本文 (content = Embedding 対象 ∩ UI 入力欄あり) も必須。
    const effContent = input.content !== undefined ? input.content : existing.content;
    if (!effContent || effContent.trim().length === 0) {
      throw new Error('PUBLIC_REQUIRES_FIELDS');
    }
  }

  // feat/asset-assignee-expansion (2026-05-26) severity-1 防御:
  //   effective visibility が 'private' になる更新では、他人 assignee を許容しない。
  //   - input.visibility と input.assigneeId の組合せ、または DB 既存値とのマージ後で判定
  //   - 担当者は private memo を参照不可になるため、authorization 上は edit 可能でも
  //     業務上は不整合 (作成者しか見えないのに編集権限を持つ意味がない)。
  const effectiveVisibility = input.visibility ?? existing.visibility;
  const effectiveAssigneeId =
    input.assigneeId !== undefined ? input.assigneeId : existing.assigneeId;
  if (
    effectiveVisibility === 'private' &&
    effectiveAssigneeId &&
    effectiveAssigneeId !== existing.userId
  ) {
    throw new Error('PRIVATE_MEMO_ASSIGNEE_FORBIDDEN');
  }
  // feat/asset-assignee-expansion (2026-05-26) severity-1 越境防御
  await assertAssigneeTenant(input.assigneeId, viewerTenantId);

  // 2026-05-15: text フィールドが「実値として変わったか」を比較で判定。
  //   未指定 (undefined) または既存値と同一なら trigger しない (LLM 課金回避)。
  const textFieldsChanging =
    (input.title !== undefined && input.title !== existing.title) ||
    (input.content !== undefined && input.content !== existing.content);

  const updated = await prisma.memo.update({
    where: { id: memoId },
    data: {
      title: input.title,
      content: input.content,
      visibility: input.visibility,
      // feat/asset-assignee-expansion (2026-05-26): 担当者更新 (null は明示的にクリア)
      ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
    },
    include: {
      author: { select: { name: true } },
      // feat/asset-assignee-expansion (2026-05-26): 担当者氏名表示用
      assignee: { select: { name: true } },
    },
  });

  // (2026-05-15) embedding 生成判定マトリクス。Knowledge/RiskIssue/Retrospective と同設計:
  //   - 新 visibility が private (= draft 等価)     → 生成しない
  //   - private → public                            → 生成 (初回)
  //   - public → public                            → text 変更時のみ生成
  //   - public → private                            → 生成しない
  const wasPrivate = existing.visibility === 'private';
  const willBePrivate = (input.visibility ?? existing.visibility) === 'private';
  const becamePublic = wasPrivate && !willBePrivate;
  const stayedPublic = !wasPrivate && !willBePrivate;
  const shouldGenerateEmbedding =
    !willBePrivate && (becamePublic || (stayedPublic && textFieldsChanging));

  if (shouldGenerateEmbedding) {
    // PR-9 perf (2026-05-29 / ADR-0026): embedding 再生成を `after()` で非同期化。
    afterSafe(
      generateAndPersistEntityEmbedding({
        table: 'memos',
        rowId: memoId,
        tenantId: viewerTenantId,
        userId,
        text: composeMemoText({ title: updated.title, content: updated.content }),
        featureUnit: 'memo-embedding',
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[memo.update] async embedding failed (monthly backfill will retry)', err);
      }),
    );
  }

  return toDTO(updated, userId);
}

/**
 * 個人「メモ一覧」(/memos) からの **visibility 一括更新** (PR #165 で /memos に移し替え、
 * 元実装は PR #162 /all-memos cross-list 用)。
 * Memo は project に紐付かない個人ノートなので scope は **viewerUserId 自身のメモのみ**。
 * Memo は visibility 値域が `private` / `public`。
 *
 * feat/asset-assignee-expansion (2026-05-26): 個別 update/delete は「作成者 OR 担当者」に
 * 拡張したが、本 bulk は **creator-only 維持**。理由:
 *   - /memos UI は listMyMemos (= `userId === viewerUserId` のみ) で表示
 *   - 担当者が他人のメモを bulk 選択する経路が UI から存在しない (= safe by construction)
 *   - 将来 listMyMemos を「assigned-to-me memo も返す」よう拡張する場合、
 *     本関数も「`userId OR assigneeId === viewerUserId`」に同期更新が必要
 *     (= UI と service 認可の乖離を避けるため、KDD §5.X+154 参照)
 */
export async function bulkUpdateMemosVisibilityFromList(
  ids: string[],
  visibility: 'private' | 'public',
  viewerUserId: string,
  viewerTenantId: string,
): Promise<{
  updatedIds: string[];
  skippedNotOwned: number;
  skippedNotFound: number;
  /** 2026-05-11: 「全メンバー」公開を試みた行のうち、タイトル空のためスキップした件数 */
  skippedEmptyTitle: number;
  /** 2026-05-24: private→public 遷移で batch 生成した embedding 件数 */
  embeddingsGenerated: number;
}> {
  if (ids.length === 0) {
    return { updatedIds: [], skippedNotOwned: 0, skippedNotFound: 0, skippedEmptyTitle: 0, embeddingsGenerated: 0 };
  }

  // 2026-05-09 feedback Phase 2-4: 越境一括更新を遮断するため tenantId 併記。
  // 2026-05-11: title を取得して、'public' 化時に空タイトルをスキップ判定に使う。
  // PR feat/project-list-section-unification (2026-05-24, embedding 追補):
  //   private→public 遷移行のみ embedding 対象になるため、visibility + content も select。
  const targets = await prisma.memo.findMany({
    where: { id: { in: ids }, deletedAt: null, tenantId: viewerTenantId },
    select: { id: true, userId: true, title: true, visibility: true, content: true },
  });
  const skippedNotFound = ids.length - targets.length;
  const owned = targets.filter((t) => t.userId === viewerUserId);
  const skippedNotOwned = targets.length - owned.length;

  // 2026-05-11: 「自分のみ」(private) で作られたタイトル空のメモを一括で「全メンバー」(public)
  //   に昇格させようとした場合、サーバ側 validator のルール (public はタイトル必須) と
  //   整合するように silent skip する。逆方向 (public → private) は制約緩和なので無条件で許可。
  let eligible = owned;
  let skippedEmptyTitle = 0;
  if (visibility === 'public') {
    const beforeCount = eligible.length;
    // v1.3.0 軽量入力 (2026-06-19): public 化は title + 本文 (content = Embedding 対象 ∩ UI 入力欄あり) が
    //   ともに非空の行のみ対象。未充足行は private のまま skip し、単発 update の必須ルールと整合させる。
    eligible = eligible.filter(
      (t) => t.title.trim().length > 0 && t.content.trim().length > 0,
    );
    skippedEmptyTitle = beforeCount - eligible.length;
  }
  const ownedIds = eligible.map((t) => t.id);

  if (ownedIds.length === 0) {
    return { updatedIds: [], skippedNotOwned, skippedNotFound, skippedEmptyTitle, embeddingsGenerated: 0 };
  }

  await prisma.memo.updateMany({
    // 2026-05-12 severity-1 防御: ownedIds は事前 findMany で tenantId 検証済みだが、
    //   updateMany にも tenantId を併記し「全 query で tenantId 必須」原則を徹底
    where: { id: { in: ownedIds }, tenantId: viewerTenantId, userId: viewerUserId },
    data: { visibility },
  });

  // PR feat/project-list-section-unification (2026-05-24): 一括 visibility 変更に伴う embedding
  //   再生成 (コスト最適化版)。単発 updateMemo と整合する判定マトリクス:
  //     - visibility='private' (公開取り下げ)       → 生成しない (提案エンジン対象外)
  //     - visibility='public' へ昇格 + 旧 private  → batch で 1 ApiCallLog 集約して生成
  //     - public→public はそもそも text 変更なし  → 生成しない (LLM 課金回避)
  let embeddingsGenerated = 0;
  if (visibility === 'public') {
    const eligibleForEmbedding = eligible.filter((t) => t.visibility === 'private');
    if (eligibleForEmbedding.length > 0) {
      const items = eligibleForEmbedding.map((t) => ({
        table: 'memos' as const,
        rowId: t.id,
        text: composeMemoText({ title: t.title, content: t.content }),
      }));
      // PR-9 perf (2026-05-29 / ADR-0026): batch embedding 生成を `after()` で非同期化。
      embeddingsGenerated = items.length;
      afterSafe(
        generateAndPersistBatchEmbeddings({
          items,
          tenantId: viewerTenantId,
          userId: viewerUserId,
          featureUnit: 'memo-embedding',
        }).catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[memo.bulk] async embedding failed (monthly backfill will retry)', err);
        }),
      );
    }
  }

  return { updatedIds: ownedIds, skippedNotOwned, skippedNotFound, skippedEmptyTitle, embeddingsGenerated };
}

/**
 * メモを論理削除する。
 *
 * 認可 (feat/crud-permission-redesign, 2026-05-20 改訂):
 *   - 作成者本人: 自分のメモ (visibility='private' / 'public' 問わず) は削除可
 *   - admin: 自テナント内の **visibility='public' な他人メモ** に限り削除可 (全メモ画面のモデレーション用途)
 *   - admin であっても他人の visibility='private' なメモは削除不可 (プライバシー保護)
 *   - admin 以外の第三者は削除不可
 *
 * @returns 削除成功なら true、対象が存在しない or 認可不足なら false (404 / 情報漏洩防止のため例外を投げない)
 */
export async function deleteMemo(
  memoId: string,
  userId: string,
  viewerTenantId: string,
  systemRole: string,
): Promise<boolean> {
  // 2026-05-09 feedback Phase 2-4: 越境削除を遮断するため where に tenantId 必須化。
  // feat/crud-permission-redesign (2026-05-20): admin の public モデレーション削除のため
  //   visibility カラムも select する。
  // feat/asset-assignee-expansion (2026-05-26): assigneeId も認可判定対象
  const existing = await prisma.memo.findFirst({
    where: { id: memoId, deletedAt: null, tenantId: viewerTenantId },
    select: { userId: true, assigneeId: true, visibility: true },
  });
  if (!existing) return false;
  // feat/asset-assignee-expansion (2026-05-26): 「作成者 OR 担当者」は削除可
  const isCreatorOrAssignee =
    existing.userId === userId || existing.assigneeId === userId;
  const isAdmin = systemRole === 'admin';
  const isAdminModeration = isAdmin && existing.visibility === 'public';
  if (!isCreatorOrAssignee && !isAdminModeration) return false;

  // PR #89: 紐づく Attachment も同時に論理削除 (UI アクセス不可の孤児データ防止)
  const now = new Date();
  await prisma.$transaction([
    prisma.memo.update({
      where: { id: memoId },
      data: { deletedAt: now },
    }),
    prisma.attachment.updateMany({
      // 2026-05-12 severity-1 防御: tenantId 明示
      where: { tenantId: viewerTenantId, entityType: 'memo', entityId: memoId, deletedAt: null },
      data: { deletedAt: now },
    }),
  ]);

  // v1.3.0 資産導線機能: 削除されたメモに紐づく手動リンクの孤児を除去。
  //   asset_links はポリモーフィック (FK なし) のため cascade delete が効かない。
  await deleteAssetLinksForEntity('memo', memoId, viewerTenantId);

  // ADR-0025 (2026-05-29): Beginner プラン超過状態からの DELETE で容量キャッシュを即時更新。
  //   循環参照回避のため dynamic import。fail-safe で throw しない (= return true は維持)。
  const { maybeRecalcAfterBeginnerDelete } = await import('@/services/tenant-storage.service');
  await maybeRecalcAfterBeginnerDelete(viewerTenantId);
  return true;
}
