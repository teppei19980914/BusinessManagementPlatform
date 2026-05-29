# ADR-0027: たすきフクロウ AI ヘルプチャット (FAQ コンシェルジュ) の導入

- **Status**: Accepted
- **Date**: 2026-05-29
- **Deciders**: tasukiba プロジェクト管理者
- **関連 PR**: feat/faq-pr5-ai-concierge-core (`251bf7fb`) / feat/faq-pr6-ai-ui-minimal (`405f3aef`) / 本 PR (feat/faq-pr7-docs-and-adr)

---

## Context (背景)

PR1-4 (feat/faq-pr1-urgent-billing-fix → PR4) で `/help` の FAQ を 30+ 件 (請求 / 容量 / アカウント / ロール / プロジェクト運用 / visibility / 通知 / ブラウザ / 利用規約) に大幅拡充し、`docs/public/account-setup-guide.md` 等の公式 docs とも同期させた。これによりユーザが「困った時に検索して答えに辿り着く」体験は強化された。

ただし、依然として **「初めてたすきばを使う人が何をすればよいかわからない」** 状態の解消には FAQ アコーディオン形式だけでは不十分という認識を持った。具体的には:

1. **検索性の限界**: ユーザは正しいキーワードを思いつかないと FAQ を見つけられない (「いつ請求」と「請求タイミング」「課金日」は別語彙)。
2. **逆引きが弱い**: 「ナレッジを綺麗にまとめたい」など目的駆動の質問に FAQ Q が直接マッチしない。
3. **使い方ガイド (`/guide`) との横断**: ヘルプと使い方ガイドが分離しており、ユーザは両方を行き来する必要がある。

ユーザの要件として整理された方向性:
- 「**たすきフクロウ**」(既存 `chat-semantic-search` のマスコット) と自然言語で会話できる UI を提供。
- 既存 FAQ + 使い方ガイドを AI の知識源とし、**FAQ を充実させるほどフクロウの回答精度が直線的に向上** する設計 ([[project_faq_drives_ai_accuracy]] / docs/developer-guide/FAQ_AND_OWL_CHAT_GUIDE.md)。
- フクロウは「情報流出を防ぐ鍵」のキャラクタとして、ユーザのロールに応じて開示できる情報を厳密に分別する ([[project_mascot_owl]] / ユーザ指示で確定したコンセプト)。

## Decision (採用した決定)

**E-3 ハイブリッド方式** で FAQ AI チャット (たすきフクロウ AI ヘルプチャット) を導入する。

### 1. UI 配置: ハイブリッド (HelpChatInput 共通 + 複数経路)

```
[/help ページ] 上部にチャット入力 + 下部にアコーディオン
[/guide ページ] 上部にチャット入力 + 下部にガイド本文
[全画面 FAB ChatPanel] (Phase 2) タブで [過去資産検索 | ヘルプ・ガイド] を切替、ヘルプタブで HelpChatInput を再利用
```

すべて同一 component `HelpChatInput` を 3 箇所で再利用 (DRY)、API は単一 `POST /api/help/chat`。

### 2. AI モデル: Claude Haiku + Full-context 方式 (RAG 不採用)

- **モデル**: `claude-haiku-4-5-20251001` (低コスト ~¥0.5/query、日本語品質十分、200K window)
- **方式**: FAQ 全文 + 使い方ガイド全文を毎回 system prompt に同梱 (current ~10K tokens、Haiku window の 5%)
- **RAG (Voyage embedding) 不採用理由**:
  - FAQ ~50 件規模では Voyage 課金 (¥0.036/query × 1+50) が full-context (~¥0.5) より高コスト
  - 検索精度も full-context が確実 (関連 FAQ を意味検索で取り逃すリスクがない)
  - 100K tokens (FAQ 600 件相当) を超えたら RAG 化検討、それまでは full-context 維持 (ADR-0028 で将来対応)

### 3. ★severity-1★ 権限分別: フクロウ = 情報流出を防ぐ鍵

`src/config/faq-content.ts` の `FaqEntry.visibleTo: 'all' | 'tenant_admin' | 'project_pm'` でロール別に開示範囲を厳密化:

| visibleTo | 開示対象ユーザ |
|---|---|
| `all` | 全員 (使い方・データ取扱い・コンセプト系) |
| `tenant_admin` | テナント管理者 / super_admin のみ (料金体系・課金詳細・テナント運営) |
| `project_pm` | 少なくとも 1 プロジェクトで PM/PL ロールを持つユーザのみ (提案エンジン詳細・プロジェクト編集挙動) |

これは **たすきば全体のコンセプトの中核** で、AI チャットを介した情報漏洩を構造的に防ぐ。`/api/help/chat` route で 2 段階防御:

1. AI に渡す FAQ を `getFaqEntriesForRole(viewer)` でフィルタ
2. AI 出力の `sourceFaqIds` / `sourceGuideStepIds` を再度フィルタ (defense-in-depth、AI hallucination 対策)

また system prompt に `buildRoleGuardancePromptSection(viewer)` で「ロール外質問は◯◯ロールへ誘導」を強制。

### 4. 課金分類: LEARNING_FREE (全プラン無料)

`featureUnit='help-chat'` を `LEARNING_FREE_FEATURE_UNITS` 新設 array に登録:
- cost = 0 (全プラン無料、学習コストとして運営吸収)
- `BILLABLE_FEATURE_UNITS` / `EMBEDDING_BILLABLE_FEATURE_UNITS` いずれにも含めない (= 集計対象外)
- `withMeteredLLM` 経由ではなく `/api/help/chat` route 内で直接 ApiCallLog INSERT
- Tenant に専用カラム `currentMonthHelpChatCount` を追加し、月次回数を独自管理

これは ADR-0022 で確立した「ユーザ非起動処理 (cron リカバリ) は不当請求になるため明示的 free」と同種の判断 ([[feedback_unjust_billing_risk_cron]])。初心者の学習を有料機能にすると Beginner ユーザが質問を躊躇い、たすきば全体の活用が阻害される。

### 5. テナント月 100 回上限 (HELP_CHAT_MONTHLY_LIMIT_PER_TENANT)

¥0.5/query × 100 回 = ¥50/月/テナント の運営コスト想定 (β / 初期商用 10 テナントなら月 ¥500 程度)。
上限到達時は HTTP 429 + `fallbackToAccordion: true` を返却し、UI は入力欄を disable + アコーディオン誘導。月初リセットは `tenant-monthly-reset.service.ts` に PR6 以降で組み込む (PR5/PR6 時点では未実装、TODO)。

### 6. ハルシネーション対策 5 点セット (KDD §5.X+188 参照)

1. **FAQ/ガイド全文を system prompt に同梱**: 「下記の許可された内容のみを根拠に回答」を明示
2. **回答に出典 ID を強制**: JSON 出力で `sourceFaqIds[]` または `sourceGuideStepIds[]` を必須化
3. **FAQ/ガイドにない内容は推測禁止**: 固定文「うーん、その内容は FAQ や使い方ガイドにまだありません…Discord で開発者にお尋ねください」
4. **業務データ質問は誘導**: 「プロジェクト X の進捗は?」等は `suggestSemanticSearch=true` + chat-semantic-search 誘導
5. **権限再検証 (defense-in-depth)**: AI 出力の sourceFaqIds を viewer 権限スコープ内かサーバ側で再フィルタ

## Consequences (影響)

### Positive

- **学習支援の質的改善**: 初心者が自然言語で質問できるため、検索キーワードを知らなくても答えに辿り着ける
- **FAQ 拡充の投資効果が直線的**: FAQ 1 件追加 = AI 回答可能範囲 1 件拡大 ([[project_faq_drives_ai_accuracy]])
- **既存資産の最大活用**: chat-semantic-search の sessionStorage / 口調 / アバター / UI パターンを完全に流用 (実装コスト最小化)
- **情報セキュリティの構造的担保**: 「フクロウ = 情報流出を防ぐ鍵」を ViewerRoles + 2 段階フィルタで実装、フクロウのキャラクタとコンセプトが一致

### Negative / Trade-off

- **運営コスト**: 1 テナント月 100 回 × ¥0.5 = ¥50/月、10 社で ¥500/月 (β フェーズで吸収可)
- **新規 DB カラム**: `Tenant.currentMonthHelpChatCount` (1 カラム、migration 1 ファイル) で勘定系への波及はないが、tenant-monthly-reset への組み込み忘れ防止が必要
- **AI ハルシネーションリスク**: 5 点対策でも残存。長期的に 👍👎 フィードバック収集 + 質問ログ分析で監視 (FaqFeedback model は PR6 後の別 PR で対応)
- **トークン使用増**: system prompt 同梱で 1 query ~10K tokens、FAQ 拡充で線形に増加 (100K 超で RAG 化検討)

### Risk / 留意事項

- **権限フィルタ漏れ**: 新規 FaqEntry 追加時に `visibleTo` 設定を忘れると一般メンバーに料金 FAQ が漏洩する。`faq-content.test.ts` の権限フィルタ test で機械的に防ぐ (PR5 で 14 ケース実装済)。
- **AI 口調の一貫性**: chat-semantic-search との文体差が出ると UX 劣化。共通のキャラクタ定義 (`CHAT_PERSONA`) と口調パターン (developer-guide §3) を維持。
- **FaqFeedback と月次リセットの未実装**: PR6 後の別 PR で対応必須 (TODO 残し)。

## Alternatives Considered (検討した代替案)

1. **検索バーのみ (全文検索 / no AI)**: ユーザ提案で却下 (検索キーワードの正確性に依存し精度が低い)
2. **FAQ AI チャット中心 (アコーディオン廃止)**: SEO / Discord 誘導 / 静的ブラウズの価値が失われる
3. **別 FAB を追加 (`?` アイコン)**: マスコット一貫性が崩れ、右下が窮屈
4. **RAG 付き FAQ チャット (Voyage embedding)**: 50 件規模では over-engineering、コストも高い
5. **使い方ガイドはチャット化しない**: ユーザ要望と乖離 (「何していいか分からない」状態の解消に直接効く)
6. **使い方ガイドを「次のアクション提案」エージェント化**: 設計複雑、初心者は「○○がしたい」が多く agent 型は不要

## 関連

- 実装 (PR5): `src/config/faq-content.ts` / `src/config/guide-content.ts` / `src/config/billing-feature-units.ts` (LEARNING_FREE 追加) / `src/app/api/help/chat/route.ts` / `prisma/migrations/20260603_add_tenant_help_chat_count/`
- 実装 (PR6): `src/components/help-chat/help-chat-input.tsx` / `src/app/(dashboard)/help/help-client.tsx` / `src/app/(dashboard)/guide/guide-client.tsx`
- 開発者ガイド: [docs/developer-guide/FAQ_AND_OWL_CHAT_GUIDE.md](../developer-guide/FAQ_AND_OWL_CHAT_GUIDE.md)
- 仕様書: [docs/specification/HELP_CHAT.md](../specification/HELP_CHAT.md)
- 関連 ADR:
  - [ADR-0019](./0019-billable-feature-units-and-free-tier-expansion.md) (BILLABLE_FEATURE_UNITS の定義、本 ADR で LEARNING_FREE を追加)
  - [ADR-0022](./0022-embedding-usage-based-billing.md) (EMBEDDING_BACKFILL の不当請求回避設計、本 ADR と同種の判断)
  - [ADR-0025](./0025-beginner-write-guard.md) (Beginner プラン write block、本 ADR と無料機能設計を比較)
  - [ADR-0026](./0026-embedding-async-generation.md) (embedding 非同期化、本 ADR で「保存後数秒タイムラグ」を FAQ 経由で説明)
- KDD パターン: §5.X+187 (FAQ drift 検知) / §5.X+188 (FAQ AI ハルシネーション対策 5 点、PR7 で記載)
- メモリ: [[project_mascot_owl]] / [[project_faq_drives_ai_accuracy]] / [[feedback_unjust_billing_risk_cron]] / [[feedback_billing_4layer_classification]] / [[feedback_client_sessionstorage_user_isolation]]
