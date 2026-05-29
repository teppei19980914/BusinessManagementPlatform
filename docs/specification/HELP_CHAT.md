# たすきフクロウ AI ヘルプチャット 仕様書

ADR-0027 (2026-05-29) で導入された `/help` / `/guide` ページ上のたすきフクロウ AI チャット機能の画面仕様 / API 入出力 / コンテンツ取扱い / 課金分類を集約する。

## 1. 画面仕様

### 1.1 配置 (E-3 ハイブリッド)

| 配置 | 配置位置 | variant prop |
|---|---|---|
| `/help` ヘッダ直後 | 上部に HelpChatInput、下部に FAQ アコーディオン | `variant="page"` |
| `/guide` ヘッダ直後 | 上部に HelpChatInput (ロールベース挨拶)、下部にガイド本文 | `variant="page"` + `greeting` |
| 全画面 FAB (Phase 2) | 既存 ChatPanel にタブ [過去資産検索 \| ヘルプ・ガイド] を追加し、ヘルプタブで HelpChatInput を再利用 | `variant="panel"` |

すべて同一 component `src/components/help-chat/help-chat-input.tsx` を使用。

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
  isTenantAdmin: boolean;
  hasAnyProjectPmRole: boolean; // PR6 で動的解決、PR5 では false 固定
};
```

| visibleTo | 開示対象 | 例 |
|---|---|---|
| `all` | 全員 | 「リスクと課題の違い」「組織 ID を忘れた」 |
| `tenant_admin` | テナント管理者 / super_admin のみ | 「いつ請求」「DB 50MB 超過」「Pro→Beginner 戻せない」 |
| `project_pm` | PM/PL ロール保持者のみ | 「提案エンジン (参考タブ) の使い方」 |

API レイヤで 2 段階フィルタ (defense-in-depth):
1. AI prompt 構築時に `getFaqEntriesForRole(viewer)` でフィルタ
2. AI 出力の `sourceFaqIds` / `sourceGuideStepIds` を再フィルタ

## 4. featureUnit 定義

| featureUnit | 分類 | cost | counter | 月次上限 |
|---|---|---|---|---|
| `help-chat` | LEARNING_FREE | 0 (全プラン無料) | `Tenant.currentMonthHelpChatCount` | テナント 100 回 / 月 |

- `LEARNING_FREE_FEATURE_UNITS` array に登録 (`src/config/billing-feature-units.ts`)
- `BILLABLE_FEATURE_UNITS` union には含めない (= 課金集計対象外)
- `withMeteredLLM` 経由ではなく `/api/help/chat` route 内で直接 ApiCallLog INSERT
- 月次リセット (= 0) は `tenant-monthly-reset.service.ts` に PR6 後の別 PR で組み込む (TODO)

## 5. ハルシネーション対策 (5 点)

詳細は [KDD_PATTERNS.md §5.X+188](../knowledge/KDD_PATTERNS.md) 参照:

1. FAQ/ガイド全文を system prompt に同梱
2. 出典 ID (sourceFaqIds[]) を JSON 出力で必須化
3. FAQ/ガイドにない内容は推測禁止、固定文で誘導
4. 業務データ質問は chat-semantic-search に誘導
5. サーバ側で sourceFaqIds の権限再検証 (defense-in-depth)

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

- ADR: [ADR-0027](../adr/0027-help-ai-concierge.md)
- 開発者ガイド: [FAQ_AND_OWL_CHAT_GUIDE.md](../developer-guide/FAQ_AND_OWL_CHAT_GUIDE.md)
- 実装 (PR5): `src/config/faq-content.ts` / `src/config/guide-content.ts` / `src/app/api/help/chat/route.ts`
- 実装 (PR6): `src/components/help-chat/help-chat-input.tsx`
- 既存設計の参照: `src/components/chat-semantic-search/chat-panel.tsx`
- KDD: §5.X+188 (FAQ AI ハルシネーション対策 5 点)
