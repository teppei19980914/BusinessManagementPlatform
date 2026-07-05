# アイデア出し機能 設計ドキュメント (v1.5.0)

本ドキュメントはアイデア出し機能の **実装設計・セキュリティ方針・ライフサイクル** をまとめた設計書です。

ユーザ向けの使い方は [docs/public/idea-features-guide.md](../public/idea-features-guide.md) を参照。API 一覧は [API_DESIGN.md §7.2 アイデア出し節](./API_DESIGN.md#アイデア出し-idea--15-route-v150) を参照。

---

## 目次

1. [機能概要](#1-機能概要)
2. [データモデル](#2-データモデル)
3. [権限設計](#3-権限設計)
4. [匿名化方針](#4-匿名化方針)
5. [セッションライフサイクル](#5-セッションライフサイクル)
6. [アイデア-資産間リンク](#6-アイデア-資産間リンク)
7. [ファイル構成](#7-ファイル構成)
8. [フィルタ設計 (v1.5.0)](#8-フィルタ設計-v150-追加)
9. [セマンティック検索 (v1.5.0)](#9-セマンティック検索-v150-追加)
10. [クローズプロジェクトでの挙動 (v1.5.0)](#10-クローズプロジェクトでの挙動-v150)

---

## 1. 機能概要

| ツール | 説明 |
|---|---|
| **投票 (Voting)** | バイナリ (二択＋理由) / ドット (配点) の 2 方式。セッション中は匿名、クローズ後に集計公開。 |
| **ホワイトボード (Whiteboard)** | 付箋形式の匿名アイデア投稿。クローズ後に全員分を俯瞰。 |
| **匿名 Q&A** | セッション不要の常時投稿型スレッド。いいね + ソート対応。 |
| **アイデア-資産間リンク** | 3 ツールの任意セッション/スレッドから 5 資産への手動リンク。資産詳細ダイアログで逆引き表示。 |

---

## 2. データモデル

### 投票 (10 テーブル → §8.47〜§8.50)

```
idea_voting_sessions      投票セッション (kind: live|pre, voteType: binary|dot)
idea_voting_options       選択肢 (binary: 2 件固定, dot: 2〜10 件)
idea_voting_submissions   投票提出 (1 人 1 セッション UNIQUE)
idea_voting_allocations   票配分 (binary: votes=1 固定, dot: votes≧1)
```

### ホワイトボード (§8.51〜§8.52)

```
idea_whiteboard_sessions  セッション (status: active|closed)
idea_whiteboard_notes     付箋 (submittedBy は匿名化)
```

### Q&A (§8.53〜§8.55)

```
idea_qa_threads   スレッド (answerCount/upvoteCount 非正規化, status: open|closed)
idea_qa_answers   回答
idea_qa_upvotes   いいね (threadId + userId で UNIQUE)
```

### 資産間リンク (§8.56)

```
idea_asset_links  ポリモーフィック (sourceType/sourceId → targetType/targetId)
                  sourceType: voting_session | whiteboard_session | qa_thread
                  targetType: task | risk | issue | knowledge | retrospective
```

**FK 方針**: ポリモーフィック FK は持たない (既存の `asset_links` と同方針)。孤立リンクはアプリ層でクリーンアップ (→ §6)。

---

## 3. 権限設計

`src/lib/permissions/check-permission.ts` で定義:

| アクション | 付与ロール |
|---|---|
| `idea:read` | viewer 以上 (全プロジェクトメンバー) |
| `idea:submit` | member 以上 (実 ProjectMember 必須) |
| `idea:manage` | member 以上 + サービス層で creator-only チェック |

**Admin の扱い**: `checkProjectPermission` が admin を PM 相当として扱うため、テナント管理者は全プロジェクトで `idea:manage` を持つ。ただし `requireActualProjectMember` を合わせて呼ぶ route では、admin は非メンバーとして弾かれる (管理者でも未参加プロジェクトへの投票・付箋投稿はできない)。

---

## 4. 匿名化方針

### 投票

- `submittedBy` は DB (`idea_voting_submissions`) に保存するが、**いかなる API レスポンスにも含めない**。
- **アクティブ中**: 自分の提出のみ返す (`where submittedBy = userId`)。`totalRespondents` カウントのみ全員に公開。
- **クローズ後**: 全提出を返す。各 Submission に `isOwnSubmission` フラグを付与 (本人識別に限定使用)。投票者 ID は返さない。

### ホワイトボード

- `submittedBy` は DB に保存するが、API レスポンスには含めない。
- **アクティブ中**: `where submittedBy = userId` で自分の付箋のみ返す。
- **クローズ後**: 全員の付箋を返す。投稿者 ID は返さない。

### Q&A

- `submittedBy` は DB に保存するが API レスポンスに含めない。
- クローズ権限チェック (投稿者本人のみ) に内部利用するだけ。

---

## 5. セッションライフサイクル

```
active → closed
```

**手動クローズ**: 作成者 (`createdBy`) のみ実行可。API: `POST /idea/voting/[id]/close` 等。

**自動クローズ (Lazy Evaluation)**:
- `endsAt < now()` のセッションは、次回リクエスト到達時に `updateMany` でステータスを `closed` に更新。
- 一覧取得 (`listVotingSessions`) では `needsClose` を `Promise.all` 相当でまとめて更新。
- cron は使用しない (コストを避けるため Lazy で十分)。

**カスケードクローズ (v1.5.0)**:
- プロジェクトが `closed` に遷移した瞬間、以下を `Promise.all` で一括実行する。
  - `ideaVotingSession.updateMany({ where: { status: 'active', deletedAt: null }, data: { status: 'closed', closedAt: now } })`
  - `ideaWhiteboardSession.updateMany({ where: { status: 'active', deletedAt: null }, data: { status: 'closed', closedAt: now } })`
  - `ideaQaThread.updateMany({ where: { status: 'open', deletedAt: null }, data: { status: 'closed' } })`
- **実行箇所**: UI の主経路である `updateProject()` と、旧 `/status` 経路の `changeProjectStatus()` の **両方** に実装する。
  - `updateProject()` (project.service.ts) — `PATCH /api/projects/[id]` 経由で UI 編集フォームから status を 'closed' に変更した場合に実行される（メインパス）。
  - `changeProjectStatus()` (project.service.ts) — 旧 `PATCH /api/projects/[id]/status` 経由（新 UI では未使用・dormant）。
- **背景**: `closed` プロジェクトでは API レベルで書き込みが禁止されるため、`active` のまま残ったセッションは手動クローズできなくなる。Lazy auto-close も個別アクセス時のみ動作するため、プロジェクトクローズ時に一括クローズしてデータの一貫性を保証する。

---

## 6. アイデア-資産間リンク

### 追加

`POST /api/projects/[projectId]/idea/links` → `idea_asset_link.service.ts#createIdeaAssetLink`

- `(sourceType, sourceId, targetType, targetId)` で UNIQUE。重複時は既存を返す (409 を出さない)。
- 作成者 (`createdBy`) 記録、クリーンアップ時の参照に使用。

### 削除 (リンク単体)

`DELETE /api/projects/[projectId]/idea/links/[linkId]` → `deleteIdeaAssetLink`

作成者本人のみ削除可。

### 孤立リンクのクリーンアップ

アイデアセッション/スレッドが DELETE された場合は、その場で `deleteIdeaAssetLinksForSource` を呼び出して関連リンクを削除する。

```
DELETE /idea/voting/[sessionId]     → deleteIdeaAssetLinksForSource('voting_session', sessionId, tenantId)
DELETE /idea/whiteboard/[sessionId] → deleteIdeaAssetLinksForSource('whiteboard_session', sessionId, tenantId)
DELETE /idea/qa/[threadId]          → deleteIdeaAssetLinksForSource('qa_thread', threadId, tenantId)
```

資産側 (タスク・リスクなど) が削除された場合の孤立リンクは Prisma Cascade に頼らないため残存するが、UI では `targetId` で資産を取得して存在チェックするため実害はない (表示時に自然消滅)。

### 逆引き表示

`GET /api/projects/[projectId]/idea/links?targetType=&targetId=` → `IdeaAssetLinkSection` コンポーネントが各資産ダイアログで fetch。

---

## 7. ファイル構成

```
src/
  app/(dashboard)/projects/[projectId]/
    idea/                          # フロントエンド: アイデアタブ
      idea-tab-client.tsx          # タブ切替 + 子コンポーネント呼び出し
      voting/
        idea-voting-client.tsx     # 投票 UI
      whiteboard/
        idea-whiteboard-client.tsx # ホワイトボード UI
      qa/
        idea-qa-client.tsx         # Q&A UI
    project-detail-client.tsx      # アイデアタブを追加 (v1.5.0)

  app/api/projects/[projectId]/idea/
    voting/route.ts                # GET list, POST create
    voting/[sessionId]/route.ts    # GET, DELETE
    voting/[sessionId]/close/route.ts   # POST
    voting/[sessionId]/submit/route.ts  # POST (UPSERT)
    whiteboard/route.ts
    whiteboard/[sessionId]/route.ts
    whiteboard/[sessionId]/close/route.ts
    whiteboard/[sessionId]/notes/route.ts      # GET, POST
    whiteboard/[sessionId]/notes/[noteId]/route.ts  # DELETE
    qa/route.ts
    qa/[threadId]/route.ts
    qa/[threadId]/close/route.ts
    qa/[threadId]/answers/route.ts
    qa/[threadId]/upvote/route.ts  # POST, DELETE
    links/route.ts                 # GET (逆引き), POST
    links/[linkId]/route.ts        # DELETE

  app/api/projects/[projectId]/chat/
    search/route.ts                # POST PJ内フクロウ検索 (v1.5.0)

  services/
    idea-voting.service.ts
    idea-whiteboard.service.ts
    idea-qa.service.ts
    idea-asset-link.service.ts
    project-chat-search.service.ts # PJ内フクロウ検索 (v1.5.0)

  components/
    chat-semantic-search/
      chat-panel.tsx               # 3本目「PJ内から探す」タブ (v1.5.0)
      result-card.tsx              # ProjectChatSearchResultCard (v1.5.0)
    common/
      idea-asset-link-section.tsx  # 資産詳細ダイアログ用 逆引き表示コンポーネント

  lib/validators/
    idea-session.ts                # Zod バリデータ

  scripts/
    backfill-idea-embeddings.ts    # 既存クローズ済みデータへの backfill (v1.5.0)

prisma/schema.prisma               # §8.47〜§8.56 (10 models) + content_embedding 列 (v1.5.0)
```

---

## 8. フィルタ設計 (v1.5.0 追加)

### 8.1 キーワード検索

各ツール一覧の `q` パラメータ (GET クエリ文字列) で、DB 側 ILIKE 検索を行う。

| ツール | 検索フィールド | Prisma 条件 |
|---|---|---|
| 投票 | `title` | `{ contains: q, mode: 'insensitive' }` |
| ホワイトボード | `title` | 同上 |
| 匿名Q&A | `question` | 同上 |

### 8.2 ステータスフィルタ

投票・ホワイトボードの `status` パラメータ (`active` / `closed`) で WHERE 条件を追加。

- 値が未指定 or 不正値の場合: フィルタ無し (全件)。
- バリデーション: `IDEA_SESSION_STATUSES` (`['active', 'closed']`) に含まれる値のみ受け入れる。

### 8.3 UI デバウンス

`idea-*-client.tsx` のキーワード入力は **400ms デバウンス** 後に `q` state を更新し、`load()` を再発火する。

```
searchInput state (onChange 即反映) → 400ms debounce → q state → load() → API ?q=...
```

`useRef<ReturnType<typeof setTimeout>>` でタイマーを管理し、クリーンアップで clearTimeout を呼ぶ。

---

## 9. セマンティック検索 (v1.5.0 追加)

### 9.1 Embedding 生成タイミング

クローズ時の hook として各サービスに `generateEmbedding` を組み込む (Lazy 評価、追記コストゼロ)。

| ツール | トリガー | 対象テキスト | featureUnit |
|---|---|---|---|
| 投票 | `closeVotingSession` | `title + description + 選択肢ラベル` | `idea-voting-embedding` |
| ホワイトボード | `closeWhiteboardSession` | `title + 全付箋 content` | `idea-whiteboard-embedding` |
| 匿名Q&A | `closeQaThread` | `question + 全回答 content` | `idea-qa-embedding` |

Embedding は pgvector (`content_embedding` カラム) に保存し、クローズ失敗時も Embedding 生成失敗は握り潰してクローズ自体は成功させる。

### 9.2 PJ スコープ検索 (project-chat-search)

`src/services/project-chat-search.service.ts` が以下の 6 テーブルを pgvector 並列検索する。

```
Promise.all([
  knowledge,        (cosine similarity)
  riskIssue,
  retrospective,
  ideaQaThread,     (status = 'closed' のみ)
  ideaWhiteboardSession,
  ideaVotingSession,
])
```

結果は `score` 降順で統合し、`ChatSearchKind` に `qa_thread / whiteboard_session / voting_session` を追加して result-card.tsx でレンダリングする。

### 9.3 Backfill

`scripts/backfill-idea-embeddings.ts` で既存クローズ済みセッション/スレッドの `content_embedding` を一括生成。`EMBEDDING_BACKFILL` featureUnit を使い cost = 0 で実行。

---

## 10. クローズプロジェクトでの挙動 (v1.5.0)

### 10.1 API レベルの書き込みガード

`src/lib/permissions/check-permission.ts` の `STATE_RESTRICTIONS.closed` が、`closed` プロジェクトに対して `idea:submit`・`idea:manage` を拒否する。すべてのアイデア書き込みルートは `checkProjectPermission` を通じてこの制約を受け、**クライアント制限に依存せず API 単体でも書き込みを拒否する**。

| アクション | closed プロジェクトでの可否 |
|---|---|
| `idea:read` (閲覧) | ✅ 許可 |
| `idea:submit` (投票・付箋・Q&A 投稿・いいね) | ❌ 403 |
| `idea:manage` (セッション作成・クローズ・削除・リンク作成削除) | ❌ 403 |

### 10.2 カスケードクローズ

プロジェクトが `closed` に遷移した瞬間に、`updateProject()` と `changeProjectStatus()` (project.service.ts) がアイデアツールの全 active/open レコードを一括クローズする (§5 参照)。UI からの通常操作は `updateProject()` 経由であることに注意。

### 10.3 クローズ後の閲覧

- ツールタブは引き続き表示される (タブトリガーに権限制限なし)。
- 既存の投票集計・ホワイトボード付箋・Q&A 回答は `idea:read` で閲覧可能。
- クローズ後は結果の閲覧専用となる。
