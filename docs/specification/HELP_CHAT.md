# たすきフクロウ AI ヘルプチャット 仕様書

ADR-0027 (2026-05-29) で導入された `/help` / `/guide` ページ上のたすきフクロウ AI チャット機能の画面仕様 / API 入出力 / コンテンツ取扱い / 課金分類を集約する。

## 1. 画面仕様

### 1.1 配置 (E-3 ハイブリッド)

| 配置 | 配置位置 | variant prop |
|---|---|---|
| `/help` ヘッダ直後 | 上部に HelpChatInput、下部に FAQ アコーディオン | `variant="page"` |
| `/guide` ヘッダ直後 | 上部に HelpChatInput (ロールベース挨拶)、下部にガイド本文 | `variant="page"` + `greeting` |
| 全画面 FAB タブ (実装済 / PR #471) | 既存 ChatPanel に `PanelMode = 'search' \| 'help'` タブ [過去資産検索 \| ヘルプ・ガイド] を追加し、ヘルプタブで HelpChatInput を再利用 | `variant="panel"` + `hideHeader` |

3 箇所すべて同一 component `src/components/help-chat/help-chat-input.tsx` を再利用 ([help-chat-input.tsx](../../src/components/help-chat/help-chat-input.tsx))。panel variant では ChatPanel 側ヘッダで「アバター + たすきフクロウ + クリアボタン」を一元化するため `hideHeader=true` を渡し、自前ヘッダを suppress する ([chat-panel.tsx:159](../../src/components/chat-semantic-search/chat-panel.tsx) `PanelMode`、[help-chat-input.tsx:102](../../src/components/help-chat/help-chat-input.tsx) `hideHeader`)。タブ状態は sessionStorage に保存し、値破損時は `'search'` に fail-safe。

### 1.2 UI 要素

```
+--------------------------------------------------+
| 🦉 たすきフクロウ                  [🗑️ 履歴クリア] |
| FAQ・使い方ガイドからお答えします                  |
+--------------------------------------------------+
| 🦉 [初期挨拶]                                     |
| (会話履歴 = sessionStorage)                       |
| - User Bubble (右寄せ)                            |
| - Owl Bubble (左寄せ + アバター)                  |
|   - 回答本文                                      |
|   - 出典: [📖 FAQ: billing-cycle] [📘 ガイド: ...] |
+--------------------------------------------------+
| [⚠ 上限到達時のフォールバック表示]                  |
+--------------------------------------------------+
| [質問入力 textarea (Enter 送信)] [送信→]          |
+--------------------------------------------------+
```

### 1.3 操作仕様 (chat-semantic-search と統一)

- **Enter 送信** / Shift+Enter 改行 (`isComposing` チェック必須)
- **2000 字上限** (`MAX_QUERY_CHARS`)、超過時は警告 + 送信不可
- **AbortController** で連投時の前回 fetch を破棄
- **sessionStorage 履歴**: `tasukiba_help_chat_history_v1`、最大 50 ターン
- **ログアウト時 / ユーザ ID 変化時** に履歴を強制クリア ([[feedback_client_sessionstorage_user_isolation]])

## 2. API 仕様

### 2.1 POST /api/help/chat

**認証**: 必須 (`getAuthenticatedUser`)

**リクエスト**:
```json
{ "query": "いつ請求されますか?" }
```

**レスポンス成功 (200)**:
```json
{
  "data": {
    "answer": "月末締め → 翌月 25 日 (固定) がお支払い期限です…",
    "answerType": "faq",
    "sourceFaqIds": ["billing-cycle"],
    "sourceGuideStepIds": [],
    "suggestSemanticSearch": false,
    "requestId": "uuid"
  }
}
```

**answerType 一覧**:

| 値 | 意味 | UI 表示 |
|---|---|---|
| `faq` | FAQ から直接回答 | 平文カード + 出典 FAQ リンク |
| `guide-walkthrough` | ガイドの手順を案内 | 番号付きステップ + 「📘 使い方ガイドより」ラベル |
| `out-of-scope` | FAQ/ガイドにない質問 | 「💡 FAQ/ガイド外」ラベル + Discord 誘導 |
| `permission-denied` | ロール外質問 | 「🔒 開示制限」ラベル + 対応ロール誘導 |

**エラーレスポンス**:

| Status | code | 意味 | fallbackToAccordion |
|---|---|---|---|
| 401 | UNAUTHORIZED / SESSION_INVALIDATED | 未認証 / セッション失効 | - |
| 400 | INVALID_INPUT | query 空文字 / 2000 字超過 | - |
| 403 | TENANT_INACTIVE | テナント無効 | - |
| 404 | TENANT_NOT_FOUND | テナント不在 | - |
| 429 | HELP_CHAT_LIMIT_EXCEEDED | 月次上限到達 (テナント 100 回) | **true** |
| 503 | LLM_ERROR | LLM 一時障害 | **true** |

## 3. FAQ・ガイドコンテンツの取扱い

### 3.1 単一信頼ソース

- `src/config/faq-content.ts`: FAQ 構造化データ + 権限フィルタ関数
- `src/config/guide-content.ts`: 使い方ガイド構造化データ + 同権限フィルタ
- `help-client.tsx` / `guide-client.tsx` (Phase 2): 上記から read してレンダリング (PR5 では plain text のみ抽出、JSX 同期は PR6 後の別 PR)
- AI prompt 同梱: `buildFaqPromptSection(viewer)` / `buildGuidePromptSection(viewer)`

### 3.2 ★severity-1★ 権限分別 (FaqVisibleTo)

```ts
type FaqVisibleTo = 'all' | 'tenant_admin' | 'project_pm';
type ViewerRoles = {
  isTenantAdmin: boolean;       // viewer の systemRole から判定 (admin / super_admin)
  hasAnyProjectPmRole: boolean; // ProjectMembership から動的解決 (実装済)
};
```

> **実装済**: `hasAnyProjectPmRole` は route 内で `prisma.projectMember.findFirst` により「少なくとも 1 プロジェクトで PM/TL ロールを持つか」を動的解決する ([route.ts:297-308](../../src/app/api/help/chat/route.ts))。旧仕様の「PR5 では false 固定」は解消済。なお `src/config/faq-content.ts` のヘッダコメントには旧 Phase 注記が残るが、実装は動的解決済。

| visibleTo | 開示対象 | 例 |
|---|---|---|
| `all` | 全員 | 「リスクと課題の違い」「組織 ID を忘れた」 |
| `tenant_admin` | テナント管理者 / super_admin のみ | 「いつ請求」「DB 50MB 超過」「Pro→Beginner 戻せない」 |
| `project_pm` | PM/PL ロール保持者のみ | 「提案エンジン (参考タブ) の使い方」 |

API レイヤで 2 段階フィルタ (defense-in-depth):
1. AI prompt 構築時に `getFaqEntriesForRole(viewer)` でフィルタ
2. AI 出力の `sourceFaqIds` / `sourceGuideStepIds` を再フィルタ

## 4. featureUnit 定義 (ADR-0028 RAG 後)

| featureUnit | 分類 | cost | counter | 月次上限 |
|---|---|---|---|---|
| `help-chat` | LEARNING_FREE | 0 (全プラン無料) | `Tenant.currentMonthHelpChatCount` | テナント 100 回 / 月 (LLM 呼出のみ) |
| `help-chat-embedding` | LEARNING_FREE | 0 (全プラン無料) | カウントなし (Voyage 無料枠で実質ゼロ) | なし |

- `LEARNING_FREE_FEATURE_UNITS` array に登録 (`src/config/billing-feature-units.ts`)
- `BILLABLE_FEATURE_UNITS` union には含めない (= 課金集計対象外)
- `withMeteredLLM` 経由ではなく `/api/help/chat` route 内で直接 ApiCallLog INSERT (help-chat)
- RAG 用 query embedding は `embedding.service.ts:generateBatchEmbeddings` 経由で 1 ApiCallLog (help-chat-embedding)
- 月次リセット (= 0) は `tenant-monthly-reset.service.ts` で実装済

## 4.2 RAG 検索仕様 (ADR-0028 新設)

ADR-0027 の full-context 方式を撤回し、Voyage AI + pgvector による RAG 検索に移行 (2026-05-30)。

| 項目 | 値 |
|---|---|
| query embedding model | Voyage AI `voyage-4-lite` (1024 次元、inputType='query') |
| 検索対象 | `faq_embeddings` + `guide_embeddings` (テナント横断、共有データ) |
| 上位件数 | top-K = 5 (`HELP_SEARCH_DEFAULT_LIMIT`、FAQ + Guide 合算) |
| スコア計算 | pgvector Cosine: `1 - (("content_embedding" <=> query::vector) / 2)` |
| 権限フィルタ | SQL 層 (`requires_admin` / `requires_project_pm` denormalize flag) + TS 層 (`getFaqEntriesForRole(viewer)` で再検証) |
| 縮退時挙動 | embedding 失敗 / DB 障害時は hits=[] + LLM プロンプトに「該当 FAQ なし」を渡して fallback 応答 |
| FAQ embedding 生成 | `scripts/generate-faq-embeddings.ts` を deploy 後に実行 (★生命線★ developer-guide §7 参照) |
| drift 検知 | `scripts/check-faq-embeddings-sync.ts` が CI で構造健全性 + (オプション) DB との hash 突合 |

## 5. ハルシネーション対策 (5 点)

詳細は [KDD_PATTERNS.md §5.X+188](../knowledge/KDD_PATTERNS.md) 参照 (ADR-0028 RAG 化後も同じ 5 点が有効):

1. ~~FAQ/ガイド全文を system prompt に同梱~~ → ★ADR-0028★ RAG top-K のみ messages に注入 (PERSONA + 開示制限は system にキャッシュ)
2. 出典 ID (sourceFaqIds[]) を JSON 出力で必須化
3. FAQ/ガイドにない内容は推測禁止、固定文で誘導
4. 業務データ質問は chat-semantic-search に誘導
5. サーバ側で sourceFaqIds の権限再検証 (defense-in-depth)

権限フィルタは **3 層 defense-in-depth** で構成 (ADR-0028 §6):

- Layer 1: SQL 層で `requires_admin` / `requires_project_pm` denormalize flag で top-K を絞り込み
- Layer 2: TS 層で `getFaqEntriesForRole(viewer)` の id 集合と intersect (SQL 漏れ防御)
- Layer 3: LLM 応答の `sourceFaqIds` を allowedFaqIds と再フィルタ (hallucination 防御)

## 6. フィードバック保存 (Phase 2 / 後続 PR)

PR6 後の別 PR で `FaqFeedback` model + `/api/help/feedback` endpoint を追加予定:

```prisma
model FaqFeedback {
  id         String   @id @default(uuid()) @db.Uuid
  tenantId   String   @map("tenant_id") @db.Uuid
  sourceType String   @map("source_type")  // 'faq' | 'guide-step'
  sourceId   String   @map("source_id")    // FaqEntry.id or GuideStep.id
  helpful    Boolean  @map("helpful")
  createdAt  DateTime @default(now()) @map("created_at")
}
```

匿名で蓄積し、月次集計で:
- helpful 率が低い FAQ → 文言改善対象
- outOfScope 率の高い質問パターン → 新規 FAQ 追加候補

## 7. 関連

- ADR: [ADR-0028 (Current, RAG 版)](../adr/0028-help-chat-rag-migration.md) — full-context → RAG への移行設計
- ADR: [ADR-0027 (Superseded)](../adr/0027-help-ai-concierge.md) — 旧 full-context 設計、ADR-0028 で撤回
- 開発者ガイド: [FAQ_AND_OWL_CHAT_GUIDE.md](../operations/develop/FAQ_AND_OWL_CHAT_GUIDE.md) (特に §7 FAQ ライフサイクル SOP)
- 運用 SOP: [DEPLOYMENT.md](../operations/develop/DEPLOYMENT.md) (FAQ embedding 生成スクリプトの deploy 後実行)
- KDD: §5.X+188 (ハルシネーション対策) / §5.X+189 (LEARNING_FREE ALLOWLIST) / §5.X+190 (runtime='nodejs') / §5.X+191 (Prompt Caching) / §5.X+192 (ADR 撤回の判断ミス事例) / §5.X+193 (drift 検知 4 層防御)
- 実装: `src/config/faq-content.ts` / `src/config/guide-content.ts` / `src/services/help-search.service.ts` / `src/app/api/help/chat/route.ts` / `scripts/generate-faq-embeddings.ts` / `scripts/check-faq-embeddings-sync.ts`
- 実装 (PR6): `src/components/help-chat/help-chat-input.tsx`
- 既存設計の参照: `src/components/chat-semantic-search/chat-panel.tsx`
- KDD: §5.X+188 (FAQ AI ハルシネーション対策 5 点)
