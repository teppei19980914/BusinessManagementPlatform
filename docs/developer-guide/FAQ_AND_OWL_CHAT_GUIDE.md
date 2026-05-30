# FAQ とたすきフクロウ AI チャット 開発者ガイド

本ドキュメントは「ヘルプ画面の FAQ コンテンツ」と「たすきフクロウ AI チャット (ヘルプ機能)」の **しくみ / FAQ を追加するときの注意点 / 回答精度・深みを上げるコツ** を集約する。新規参入者および FAQ 拡充を継続的に行うメンバーの参照用。

## 0. 前提と位置付け

- **目的**: 初めてたすきばを使うユーザの「何をすればよいかわからない」状態を解消する学習支援機能。
- **設計思想**: たすきフクロウは FAQ と使い方ガイドの内容を AI が読んで答える。**FAQ を充実させるほど回答精度・深みが直線的に向上する** (詳細は §4)。
- **対象機能**: `/help` (FAQ 画面) と `/guide` (使い方ガイド) 上部のチャット入力欄 + 全画面右下 FAB のチャットパネル内「ヘルプ・ガイド」タブ。
- **メモリ参照**: [[project_faq_drives_ai_accuracy]] / [[project_mascot_owl]]

### 0.1 ★コンセプト最重要★ フクロウ = 情報流出を防ぐ鍵

たすきフクロウは「**何でも知っているが、ユーザのロールに応じて開示してよい情報・してはいけない情報を厳密に分別する**」キャラクタです。これはたすきば全体のコンセプト ([[project_mascot_owl]]) でもあります。

**開示制御の原則**:
| ユーザロール | 開示できる FAQ |
|---|---|
| 一般メンバー | `visibleTo: 'all'` のみ (= 使い方・データ取扱い等の公開情報) |
| PM/PL ロール持ち | `visibleTo: 'all'` + `'project_pm'` (= 提案エンジン詳細・プロジェクト編集挙動) |
| テナント管理者 | `visibleTo: 'all'` + `'tenant_admin'` (= 料金体系・課金詳細・テナント運営) |
| 運営者 (super_admin) | 全 FAQ (= tenant_admin と同等以上) |

**具体例 (絶対に守るべき挙動)**:
- 一般メンバーが「いつ請求されますか?」と聞いたら → フクロウは「申し訳ありません、料金や運営の詳細はテナント管理者の方にお尋ねください」と返す
- 一般プロジェクトメンバーが「提案エンジン (参考タブ) には何が表示されますか?」と聞いたら → フクロウは「申し訳ありません、その機能の詳細は PM/PL ロールの方にお尋ねください」と返す
- これらは料金や PM 専用機能の詳細を「知らない人」に教えてはいけない情報のため

**実装の核**:
- `src/config/faq-content.ts` の `FaqEntry.visibleTo` でロール別に厳密に分類
- `/api/help/chat` route は **必ず** `getFaqEntriesForRole(viewer)` でフィルタ済 FAQ のみを AI に渡す
- `buildRoleGuardancePromptSection(viewer)` で AI に「許可外の質問には◯◯ロールへ誘導」を強制
- AI 出力の `sourceFaqIds[]` も viewer の権限スコープ内かを再検証 (defense-in-depth)

---

## 1. たすきフクロウ AI チャットのしくみ

### 1.1 全体アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│ ユーザ                                                       │
│   ↓ 質問入力 (例: 「いつ請求されますか?」)                    │
├─────────────────────────────────────────────────────────────┤
│ Client (React)                                               │
│   - /help / /guide 上部の HelpChatInput component             │
│   - 全画面 FAB の ChatPanel ヘルプタブ (同 component を再利用) │
│   - sessionStorage (tasukiba_help_chat_history_v1) で履歴保持 │
│   ↓ POST /api/help/chat { query }                            │
├─────────────────────────────────────────────────────────────┤
│ Server (Next.js Route Handler)                               │
│   - /api/help/chat route.ts                                   │
│   - Counter 月 100 回上限チェック (テナント単位)              │
│   - withMeteredLLM (featureUnit='help-chat', cost=0)         │
│   ↓ system prompt 構築                                       │
├─────────────────────────────────────────────────────────────┤
│ Claude Haiku (Anthropic API)                                 │
│   system prompt:                                             │
│     - フクロウの口調・キャラクタ定義                          │
│     - FAQ 全文 (faq-content.ts、~5K tokens)                  │
│     - 使い方ガイド全文 (guide-content.ts、~5K tokens)         │
│     - ハルシネーション対策 5 点 (§7 参照)                     │
│     - 出力スキーマ {answer, answerType, sourceFaqIds[]...}    │
│   ↓ JSON 構造化出力                                          │
├─────────────────────────────────────────────────────────────┤
│ Client が JSON を受信                                        │
│   - answer をフクロウバブルに表示                             │
│   - sourceFaqIds[] → アコーディオン deep link ボタン          │
│   - 上限到達 (429) なら入力欄 disable + アコーディオン誘導   │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 採用技術と理由

| 技術選定 | 理由 |
|---|---|
| **Claude Haiku** | 低コスト (~¥0.5/query)、十分な日本語品質、200K window で FAQ 全文同梱可能 |
| **Full-context 方式** (RAG 不採用) | FAQ ~50 件規模では全文同梱で十分かつシンプル。RAG は Voyage 課金が増えるだけ。100K tokens 超えたら検討 |
| **JSON 構造化出力** (`response_format`) | 出典 sourceFaqIds 強制 (ハルシネーション対策) + answerType 別 UI 表示 |
| **withMeteredLLM 経由** | 既存課金基盤の流用、ApiCallLog 一元管理、drift 検知に乗る |
| **sessionStorage 履歴** | 既存 chat-semantic-search パターンと同一。タブ単位揮発、DB 容量を消費しない |

### 1.3 課金分類 (ADR-0027 / ADR-0028)

- featureUnit: `help-chat` (LLM 呼出) と `help-chat-embedding` (RAG embedding) の 2 つを使用
- 両方とも `LEARNING_FREE_FEATURE_UNITS` 分類で全プラン無料 (Beginner 含む、`EMBEDDING_BACKFILL_FEATURE_UNITS` と同じ ¥0 維持パターン)
- Counter: `currentMonthHelpChatCount` (Tenant カラム) で `help-chat` のみ月次カウント (embedding は cost=0 + Voyage 無料枠で実質ゼロ)
- 上限: テナント月 100 回 (= ¥50/月程度の運営コスト想定、LLM 呼出のみ判定)
- 上限到達時: HTTP 429 + `fallbackToAccordion: true` を返却 → UI が入力欄を disable してアコーディオン誘導

#### 1.3.1 ★重要★ なぜ `withMeteredLLM` を経由しないか

たすきフクロウ AI ヘルプチャットは **意図的に `withMeteredLLM` を経由しない独立経路** として設計されています。これは ADR-0027 で正当化された設計判断であり、`scripts/check-llm-billing-bypass.ts` の `ALLOWLIST_EXACT` に `src/app/api/help/chat/route.ts` を登録する形で CI ガードからも除外しています (KDD §5.X+189 参照)。

理由:

1. **cost=0 全プラン無料**: `withMeteredLLM` は cost > 0 を想定した課金ゲートウェイ (LLM 単価計算 / `currentMonthApiCallCount` increment / Stripe queue 投入)。help-chat は学習コストとして運営吸収するため、これらの処理がすべて noop で複雑性だけが増す。
2. **専用 Counter で月次回数を独自管理**: `Tenant.currentMonthHelpChatCount` (新規カラム) で help-chat 専用の月次カウントを保持。`BILLABLE_FEATURE_UNITS` 集計対象外なので invoice/billing-aggregation も汚染しない。
3. **代替の暴走防止機構を二重に持つ**:
   - `applyRateLimit({key: 'help-chat', max: 10, windowMs: 60_000})` (1 分 10 回 / IP)
   - テナント月 100 回上限 (`HELP_CHAT_MONTHLY_LIMIT_PER_TENANT`)
   - これにより `withMeteredLLM` の rate limit / Beginner 上限ロジックなしでも DoS / 課金枯渇を防げる。
4. **将来 LEARNING_FREE 機能を追加するときの参考設計**: 同じく cost=0 で運営が学習コストを吸収する機能 (例: 初心者向けチュートリアル AI) を追加する場合、本経路をテンプレートにすると安全。

新規 LLM 機能を追加する開発者は、上記設計判断を踏まえ:

- 課金対象 (Expert/Pro で課金が発生) → `withMeteredLLM` 経由のラッパー (`auto-tag.service.ts` / `suggestion-explanation.service.ts` 等) を使う
- LEARNING_FREE 等の意図的 cost=0 独立経路 → 本ガイドのパターンに従い、`check-llm-billing-bypass.ts` の ALLOWLIST に追記 + ADR で正当化

を選び分けてください。判断に迷ったら ADR-0019 と ADR-0027 を読み比べて、課金分類 4 階層 (LLM / EMBEDDING / STORAGE_OVERAGE / BACKFILL_FREE) のどれに該当するかを確認してください ([memory: 課金 4 階層分類](../../C:/Users/SF02512/.claude/projects/c--Users-SF02512-GitHub-Private-BusinessManagementPlatform/memory/feedback_billing_4layer_classification.md))。

### 1.4 ファイル構成

| ファイル | 役割 |
|---|---|
| `src/config/faq-content.ts` | FAQ を `{id, category, q, a}[]` の構造化データに集約。**FAQ 画面と AI prompt の単一信頼ソース** |
| `src/config/guide-content.ts` | 使い方ガイドの構造化データ |
| `src/config/billing-feature-units.ts` | `LEARNING_FREE_FEATURE_UNITS` に `help-chat` を追加 |
| `src/app/api/help/chat/route.ts` | Anthropic Claude Haiku を呼ぶ POST endpoint |
| `src/app/api/help/feedback/route.ts` | 👍👎 フィードバック保存 endpoint |
| `src/components/help-chat/help-chat-input.tsx` | 入力欄 + 回答カード + 出典ジャンプ + フィードバック UI |
| `src/components/help-chat/faq-accordion.tsx` | カテゴリタブ + 個別 FAQ 展開 + deep link |
| `src/app/(dashboard)/help/help-client.tsx` | 上部に HelpChatInput、下部に FaqAccordion |
| `src/app/(dashboard)/guide/guide-client.tsx` | 上部に HelpChatInput、下部にガイド本体 |
| `src/components/chat-semantic-search/chat-panel.tsx` | mode タブで HelpChatInput を再利用 |
| `prisma/schema.prisma` | Tenant に `currentMonthHelpChatCount` 追加、FaqFeedback model 追加 |

---

## 2. FAQ を追加するときの注意点

### 2.1 単一信頼ソースの原則

FAQ は **`src/config/faq-content.ts` の構造化データのみ** に書く。`help-client.tsx` はこのデータを read してレンダリングするだけ (表示専徵)。

```ts
// faq-content.ts
export const FAQ_ENTRIES = [
  {
    id: 'billing-cycle',
    category: 'billing', // 'service' | 'business' | 'billing' | 'data' | 'role' | 'account' | 'admin'
    q: 'いつ請求されますか？',
    a: '月末締め → 翌月 25 日 (固定) がお支払い期限です (土日祝に当たる場合は翌営業日)。請求書 PDF は締日の翌月 15 日までにご請求先メールアドレスへ送付されます。',
    visibleTo: 'all', // 'all' | 'tenant_admin'
  },
  // ...
] as const;
```

`help-client.tsx` の JSX 内に直接書かない (= AI が読めないため精度が上がらない)。

### 2.2 文言の品質基準 (4 点)

過去の事故事例 (KDD §5.X+187) から得た 4 つの基準:

1. **実装一致**: 数値・期間・上限値は必ず実装と一致させる。`src/config/*.ts` / ADR / service を grep して根拠を確認してから書く。
   - 悪い例: 「30 日間の Grace 期間を経て物理削除」(実装は 180 日ルール、6 ヶ月放置)
   - 良い例: 「Beginner: 組織作成から 90 日で読み取り専用、合計 180 日で自動的に削除」
2. **専門用語を避ける**: エンジニア用語は非エンジニア向けに言い換える。
   - 悪い例: 「embedding 生成」「縮退モード」「super_admin」「最上位の認可境界」
   - 良い例: 「検索用データの作成」「AI 機能の一時停止」「運営者」「他社のデータは見えない」
3. **数値の正確性**: 期間 (90 日 / 180 日 / 25 日)、金額 (¥10/¥15)、上限 (50MB / 50GB) は src/config と完全一致。
4. **矛盾回避**: 既存 FAQ と矛盾する記述は禁止。例えば「ダウングレード即時反映」と「Pro/Expert → Beginner 戻せない」は矛盾するため、後者の確定により前者は撤去 (A-3-4 で実施)。

### 2.3 矛盾チェック

新規 FAQ 追加時:
1. 関連キーワードで既存 FAQ を grep (`grep -i "請求" src/config/faq-content.ts`)
2. 同じトピックの既存 FAQ と内容を読み比べ、矛盾がないか確認
3. 矛盾がある場合は、既存 FAQ の修正と同時に行う (= 同一 PR 内で整合)

### 2.4 drift 検知テストの追加 (必須)

新規 FAQ 追加時は `src/app/(dashboard)/help/help-client.test.ts` に **3 種類のアサーション** を追加する:

```ts
it('新規 FAQ「いつ請求」の存在と正確な数値を含む', () => {
  // 1. Q 文言の存在 (検索性担保)
  expect(source).toMatch(/q="いつ請求されますか？"/);
  // 2. 重要数値の存在 (drift 検知)
  expect(source).toMatch(/翌月 25 日/);
  expect(source).toMatch(/土日祝に当たる場合は翌営業日/);
  // 3. 旧誤記の再混入防止 (regression 防止)
  expect(source).not.toMatch(/毎月 1 日/); // 仮の旧誤記例
});
```

なぜ 3 種類か:
- 1 だけ: Q 文言を残したまま回答だけ間違っていても気づかない
- 1+2 だけ: リファクタで元の誤記に戻った時に検知できない
- 1+2+3 セット: drift と regression の両方を機械的に防ぐ (詳細は KDD §5.X+187)

### 2.5 docs/public/*.md との同期

FAQ で扱う情報は LP・公式 docs (account-setup-guide.md / chat-semantic-search-guide.md 等) にも記載されることが多い。4 軸 grep で同期確認:

| 軸 | 確認方法 |
|---|---|
| 数値 (90日/180日/¥15) | `grep -r "180 日" docs/ src/` |
| 表示文字列 (UI ラベル) | `grep -r "セルフ解約" docs/ src/i18n/` |
| 自然文 (本文) | `grep -r "戻せません" docs/` |
| アサーション (test) | `grep -r "180 日" src/**/*.test.ts` |

参考: [[feedback_localestring_grep_blindspot]]

---

## 3. たすきフクロウの口調・人格 (既存 chat-semantic-search と一貫)

### 3.1 基本キャラクタ

- 名前: **たすきフクロウ** (CHAT_PERSONA.name で固定、`src/config/chat-persona.ts`)
- アバター: `/mascot-owl-chat.png` (CHAT_PERSONA.avatarSrc)
- 性格: 知恵・記憶・夜でも見守る ([[project_mascot_owl]])

### 3.2 口調パターン (chat-semantic-search から流用、既存パターンと統一)

| シーン | フレーズ例 |
|---|---|
| 初期挨拶 | 「こんにちは、たすきフクロウです。」「お困りごとを教えてください。FAQ や使い方ガイドから一緒に探しますね。」 |
| 検索中 | 「⏳ ちょっと待ってくださいね、FAQ と使い方ガイドを探しています…」 |
| 回答 (FAQ ヒット) | 「💡 こちらが参考になりそうです:」 「(回答本文)」 「📖 出典: ◯◯ (ジャンプ)」 |
| 回答 (ガイド手順) | 「📘 こちらの手順をご案内します:」 「(番号付きステップ)」 |
| FAQ/ガイド外 | 「うーん、その内容は FAQ や使い方ガイドにまだありません…Discord で開発者に聞いてみてください。」 |
| 業務質問判定 | 「📊 そのご質問は『過去資産の意味検索』機能の方が得意です。画面右下の検索チャットをお試しください。」 |
| 上限到達 | 「💡 ごめんなさい、本月のチャット利用上限に達しました。下記の FAQ 一覧から探してみてください (来月 1 日に再開します)。」 |
| エラー | 「🙏 申し訳ありません、AI が一時的に応答できないようです。下記の FAQ から探していただくか、Discord でご質問ください。」 |

### 3.3 守るべき口調ルール

- **「ですね」「ますね」「お〜ください」**: 丁寧かつ柔らかい表現
- **困った時は「ごめんなさい」「うーん」**: 親しみやすさ、機械感を出さない
- **絵文字は控えめに 1 メッセージ 1〜2 個**: 💡 ⏳ 📖 📘 🙏 📊 を場面別に
- **「私 (フクロウ) が〜」と一人称**: 既存 chat-semantic-search で多用
- **専門用語をユーザに返さない**: 内部用語 (embedding / featureUnit / draft) は出力に含めない (system prompt で明示)

### 3.4 既存 chat-semantic-search との設計流用ポイント

| 流用要素 | 既存実装 | help-chat への適用 |
|---|---|---|
| sessionStorage 履歴 | `tasukiba_chat_history_v1` (50 turn 上限) | `tasukiba_help_chat_history_v1` (同上限) |
| ログアウト / ユーザ切替時の clear | `useEffect` で `isUnauthenticated` 監視 + `viewerUserId` 変化監視 ([[feedback_client_sessionstorage_user_isolation]] severity-1) | 同パターンを完全コピー |
| UserBubble / AssistantBubble | `chat-panel.tsx:541-577` 右寄せ user / 左寄せ assistant + アバター | 同コンポーネントを export して再利用 |
| AbortController による race 解消 | `inFlightAbortRef` で連投時の前回 fetch を破棄 | 同パターン |
| Enter 送信 / Shift+Enter 改行 | `handleKeyDown` で `isComposing` チェック | 同パターン |
| ペルソナアバター + 名前ヘッダ | `CHAT_PERSONA` から取得 | 同 const を import |

実装時はまず `chat-panel.tsx` を読んで、上記要素を **新規実装せず再利用** する。

---

## 4. 回答精度・深みを上げるコツ

### 4.1 最重要: FAQ を充実させる (経路は full-context、効果は直線的)

たすきフクロウは API 呼び出し時に **FAQ 全文を system prompt として受け取る**。つまり:

```
FAQ 1 件追加 → faq-content.ts に entry 追加 → 次回 API 呼び出しから AI が答えられる
```

**「FAQ 拡充 = 回答可能範囲の拡大 + 回答内容の正確化」** が成立する。

充実させる方向性 (優先順位):
1. **初心者がつまずきやすい場面** (現状 PR1-4 で大幅対応済)
2. **逆引き形式** (「ナレッジを綺麗にまとめたい」「初回の組織設定で何をすべきか」)
3. **エラーメッセージ別の対処法** (「○○エラーが出た」)
4. **業界別ユースケース** (建設業 / IT サービス業 / コンサル業 など)
5. **ベストプラクティス** (「振り返りはいつやるべき?」「リスク登録のコツ」)

### 4.2 ガイドコンテンツの拡充 (`guide-content.ts`)

FAQ が「困った時の Q&A」なら、ガイドは「使い方の体系的説明」。両方が AI に渡るため、**手順系の質問にはガイドが、即答系の質問には FAQ が** マッチしやすい。

### 4.3 system プロンプトの改善 (`/api/help/chat/route.ts` 内)

プロンプトを改善することで、AI の振る舞いが変わる:

- **回答の長さ**: 「2-3 文以内で答えてください」「ステップは番号付きで」など指示
- **誘導**: 「業務データの質問は chat-semantic-search を案内」「FAQ にない内容は Discord に誘導」
- **トーン**: 「丁寧かつ親しみやすく」「専門用語を使わない」(§3.3 のルール再掲)

プロンプト変更時は **snapshot テスト**で出力品質を担保する。

### 4.4 フィードバック (👍 / 👎) の分析

`FaqFeedback` テーブルに匿名で蓄積される:
```
- sourceFaqId
- helpful: boolean
- timestamp
- tenantId (集計用)
```

月次で集計し:
- **helpful 率が低い FAQ** → 文言改善対象
- **outOfScope=true の頻出質問** → 新規 FAQ 追加候補
- **「ガイドへ」誘導が多い質問** → ガイド側に詳細を追加

`docs/operations/MONITORING.md` の help-chat 監視項目を参照。

### 4.5 質問ログ分析 (将来)

`ApiCallLog` の `featureUnit='help-chat'` 行を月次で抽出し、頻出キーワードを分析する。FAQ にない質問が頻出していたら追加すべき。

### 4.6 矛盾チェックの自動化

`help-client.test.ts` の drift 検知テストに加え、`faq-content.ts` の重複・矛盾を CI でチェックする lint ルール (例: 同じカテゴリで矛盾する数値が含まれていないか) を将来追加予定。

---

## 5. トークン上限とコスト最適化 (ADR-0028 RAG 版)

> **2026-05-30 更新**: ADR-0027 の full-context 方式を廃止し、ADR-0028 で RAG 方式に移行しました。本節は RAG 版での再試算です。

### 5.1 現状の容量 (RAG 後)

| 項目 | tokens 推定 |
|---|---|
| system prompt (PERSONA + 開示制限のみ、★キャッシュ対象★) | ~1,000 |
| messages: RAG 結果 (top-K=5、各 ~600 tokens) | ~3,000 |
| messages: 質問文 + 出力スキーマ説明 | ~600 |
| **合計** | **~4,600** |
| Haiku 200K window | 2.3% 使用 |

`top-K=5` は `src/services/help-search.service.ts:HELP_SEARCH_DEFAULT_LIMIT` で集中管理。

### 5.2 拡張余地

RAG 化により FAQ 件数が **何件増えても 1 query のトークン数は固定** です。これが ADR-0028 移行の最大のメリット:

| FAQ 規模 | 1 query のトークン数 | 1 query のコスト (cache hit) |
|---|---|---|
| 50 件 | ~4,600 | ¥0.5 |
| 300 件 | ~4,600 | ¥0.5 |
| 1,000 件 | ~4,600 | ¥0.5 |

> 参考: 旧 full-context 方式では 300 件で ¥4.8、600 件で ¥9.5 と線形増大していました。

### 5.3 RAG 追加コスト

RAG の追加コストは **Voyage embedding 生成** のみ:

| 操作 | 頻度 | コスト (Voyage) |
|---|---|---|
| query embedding (1 query) | 質問のたび | ~¥0.04 (200M tokens/月 無料枠内では事実上 ¥0) |
| FAQ embedding (1 件追加・更新) | deploy 後 1 回 | ~¥0.001 |
| FAQ embedding 全件再生成 | 通常起こらない | ~¥0.05 (FAQ 100 件想定) |

Voyage の無料枠 (200M tokens/月) があれば、テナント月 100 回 × 全テナント × 数百件規模でも超過は事実上発生しない見込み。

### 5.4 月間コスト試算 (RAG 版)

- テナント数: 10 社想定 (β / 初期商用フェーズ)
- 平均利用: 30 回/月/テナント (~ 上限 100 回の 30%)
- 1 query コスト: ¥0.5 (Haiku + ~4.6K tokens 固定、cache hit 時)
- Voyage embedding: 無料枠内 = ¥0
- **月間運営コスト: ¥150 (10 社 × 30 回 × ¥0.5)** ← FAQ 何件でも同じ

### 5.5 ★重要★ Anthropic Prompt Caching の役割 (RAG 後)

RAG 後も Prompt Caching は引き続き有効で、より明確な役割分担を持ちます:

| キャッシュ対象 | 内容 | 変更頻度 |
|---|---|---|
| system プロンプト | PERSONA + 開示制限 (viewer ロール別に固定) | viewer のロール変化時のみ |
| messages | RAG 結果 + 質問文 (query 毎に変化) | 毎 query |

system プロンプトは **viewer 単位で固定** のため、5 分以内に同じユーザが続けて質問すれば 90% off の cache hit が効きます。

#### コスト単価 (Claude Haiku 4.5、2026 年時点)

| 種別 | 単価 (USD / 1M tokens) | 日本円換算 (¥/1M) |
|---|---|---|
| Input (cache miss、毎回課金) | $1.00 | ~¥150 |
| **Input (cache hit、5 分以内の再アクセス)** | **$0.10 (90% off)** | **~¥15** |
| Input (cache write、初回登録) | $1.25 (25% premium) | ~¥190 |
| Output | $5.00 | ~¥750 |

#### 実装上のポイント (`src/app/api/help/chat/route.ts`)

```ts
system: [
  {
    type: 'text' as const,
    text: systemPrompt,           // PERSONA + 開示制限 (~1K tokens、viewer 別に固定)
    cache_control: { type: 'ephemeral' as const },  // ★必須★ 5 分 TTL の prompt cache
  },
],
messages: [
  {
    role: 'user',
    content: `${ragPromptSection}\n...\n${userQuery}\n...\n${outputInstruction}`,
    // RAG 結果 + 質問文 + 出力指示 (query 毎に変化、キャッシュ不可)
  },
],
```

`cache_control` を **付け忘れると cache が効かず、毎回 input tokens 全額課金** となります。新規 LLM 機能を追加するときは既存実装 (`auto-tag.service.ts:251-256` / `suggestion-explanation.service.ts:248-253`) と同じパターンを必ず踏襲してください (KDD §5.X+191 参照)。

#### ユーザ料金への影響

**ゼロ**。たすきフクロウは全プラン無料 (LEARNING_FREE) で、コストは運営が学習コストとして吸収します ([ADR-0028 §6](../adr/0028-help-chat-rag-migration.md))。

- LLM 呼出: `featureUnit='help-chat'` (LEARNING_FREE、cost=0)
- query embedding: `featureUnit='help-chat-embedding'` (LEARNING_FREE、cost=0)
- テナント月 100 回上限: `HELP_CHAT_MONTHLY_LIMIT_PER_TENANT = 100` (LLM 呼出のみカウント)
- RAG 移行により 1 query コストが FAQ 件数に依存せず固定化、運営コストが予測可能

---

## 6. ハルシネーション対策 (5 点セット)

詳細は KDD §5.X+188 (PR7 で記載予定) を参照。要点のみ:

1. **FAQ / ガイド全文をシステムプロンプトに同梱**: 「下記の FAQ とガイドの内容のみを根拠に答えてください」と明示
2. **回答に出典 ID を強制**: JSON 出力で `sourceFaqIds[]` または `sourceGuideStepIds[]` を必須化、空ならエラー
3. **FAQ にない内容は推測禁止**: 「分かりません / Discord で聞いてください」固定文を強制
4. **業務データ質問は誘導**: 「プロジェクト X の進捗は?」等は「画面右下の検索チャットをお試しください」と返す
5. **回答カードから出典 FAQ へジャンプ**: ユーザが原文を確認できる経路を必ず提供

---

## 7. FAQ 追加チェックリスト (実務手順)

### 7.0 ★最重要★ FAQ ライフサイクル SOP (ADR-0028 RAG 版) — ★たすきば存続の生命線★

> ADR-0027 の full-context 方式から **ADR-0028 RAG 方式へ移行** しました (2026-05-30)。
> 旧版の「Embedding 生成は不要」記述は撤回されています。
>
> **本節の手順を守らないと「DB の FAQ embedding が古い → 新 FAQ の質問にフクロウが答えられない」現象が発生し、ヘルプチャット品質が静かに劣化します**。FAQ/使い方ガイドの追加・更新・削除を行う開発者は **必ず** 本節を読んでください。

#### 7.0.1 全体フロー

```
[開発者] faq-content.ts / guide-content.ts を編集
   ↓ commit + push
[CI] pnpm check:faq-embeddings-sync で構造健全性チェック (DB アクセスなし)
   ↓
[CI/CD] main マージ → Netlify deploy
   ↓
[★必須★ deploy 後] pnpm generate:faq-embeddings (1 回だけ実行)
   ↓
[ユーザ] /help でチャット質問
   ↓
[/api/help/chat] searchHelpContent → faq_embeddings から top-K
   ↓
[Claude Haiku] RAG 結果のみを参照して回答生成
```

#### 7.0.2 4 層防御

| 層 | 守る仕組み | 失敗時 |
|---|---|---|
| 1. CI 構造ガード | `pnpm check:faq-embeddings-sync` が PR CI で実行され、`faq-content.ts` の構造異常 (id 重複 / 文字数超過 / visibleTo 不正) を検知 | PR が red になりマージ不可 |
| 2. CI drift ガード (オプション) | `DATABASE_URL` を渡せば DB と config の hash 突合を行う | drift があれば fail、deploy SOP の実行を促す |
| 3. 手動 SOP | 本節 §7.0.3 / §7.0.4 の手順 | 開発者が忘れると 4 層目で吸収 |
| 4. DEPLOYMENT.md SOP | [docs/operations/DEPLOYMENT.md](../operations/DEPLOYMENT.md) の Netlify deploy checklist に明記 | reviewer が deploy PR に対し generate 実行を確認 |

#### 7.0.3 generate-faq-embeddings.ts の役割

`scripts/generate-faq-embeddings.ts` は以下を 1 つの冪等処理で行います:

| ケース | DB の状態 | 本 script の動作 |
|---|---|---|
| 新規 FAQ 追加 | config に entry 増、DB に行なし | Voyage embedding 生成 + INSERT |
| 既存 FAQ 更新 | config 側の hash 変化 | Voyage embedding 再生成 + UPDATE |
| FAQ 削除 | config から entry 消、DB に orphan 行 | DELETE |
| 変更なし | hash 一致 | skip (Voyage API 呼出ゼロ) |

判定基準は `composeFaqContentText(entry)` の SHA-256 hash。`src/services/help-search.service.ts` で定義された compose 関数が **DB 書込側 / RAG 検索側 / drift 検知側で共通** のため、hash の不一致は config の実体変更と等価です。

#### 7.0.4 新規 FAQ / Guide を追加するときの checklist

**ローカル開発フェーズ**:

- [ ] `src/config/faq-content.ts` (または `guide-content.ts`) に新規 entry 追加 (id は kebab-case、150 字以内)
- [ ] 既存 FAQ と矛盾しないかキーワード grep で確認
- [ ] 数値・期間・上限は src/config / ADR / service と一致するか grep で verify (`[[feedback_design_comment_vs_impl_drift]]`)
- [ ] 専門用語 (embedding / draft / super_admin 等) を平易語に置換
- [ ] composed text が Voyage の MAX_INPUT_CHARS (8000) を超えないか確認
- [ ] `pnpm check:faq-embeddings-sync` で構造健全性 PASS
- [ ] `pnpm test src/config/faq-content.test.ts src/services/help-search.service.test.ts` で権限 + RAG ロジックのテスト PASS
- [ ] `pnpm lint && pnpm tsc --noEmit && pnpm build` で品質ゲート PASS

**PR + deploy フェーズ**:

- [ ] PR 説明に「★FAQ/Guide 編集を含む。deploy 後に `pnpm generate:faq-embeddings` を実行★」と明記
- [ ] PR がマージされ Netlify deploy が完了するまで待つ
- [ ] **★必須★** ローカル `.env.local` に **本番 (または staging)** の `DATABASE_URL` と `VOYAGE_API_KEY` を設定し、`pnpm generate:faq-embeddings` を実行
- [ ] 出力で「+N 追加 / ~N 更新 / -N 削除」が想定どおりであることを確認
- [ ] (任意) `pnpm check:faq-embeddings-sync` を本番 DATABASE_URL で再実行し drift ゼロを確認
- [ ] docs/public/*.md (account-setup-guide / chat-semantic-search-guide 等) に同じ情報があれば同期
- [ ] LP (HomePage repo) に同じ情報があれば別 PR で同期

#### 7.0.5 トラブルシューティング

| 症状 | 想定原因 | 対処 |
|---|---|---|
| 新 FAQ について質問してもフクロウが「該当する FAQ がありません」と答える | deploy 後の generate スクリプト未実行 | `pnpm generate:faq-embeddings` 実行 |
| generate スクリプトが Voyage API エラーで失敗 | `VOYAGE_API_KEY` 未設定 / 失効 | `.env.local` の API キーを確認 |
| `pnpm check:faq-embeddings-sync` が drift エラー | config 変更後 generate を忘れた | `pnpm generate:faq-embeddings` 実行 |
| 旧 FAQ id の質問にも答えられる (削除したのに) | DB の orphan 行が残っている | `pnpm generate:faq-embeddings` 実行 (DELETE 経路も自動) |
| structure エラー: id が 150 字超 | 長すぎる id | kebab-case で短く |
| structure エラー: 本文が MAX_INPUT_CHARS=8000 超 | FAQ 本文が長すぎる | 本文を分割して複数 FAQ に分ける |

---

## 7.5 環境変数 (本機能で使用)

| 変数名 | 必須 | 役割 | 未設定時の挙動 |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | 本番のみ | Claude Haiku を呼ぶための API キー | 開発: 未設定でも動作可 (graceful degradation)。route が 503 + `fallbackToAccordion: true` を返し、UI が下部 FAQ アコーディオン誘導に切替 |
| `VOYAGE_API_KEY` | 本番のみ | (本機能は不使用、関連: chat-semantic-search 用) | チャット意味検索が pg_trgm fallback で縮退動作 |

**本番環境**:
- Anthropic Console ([console.anthropic.com](https://console.anthropic.com/)) で API キー取得 → Netlify ダッシュボードに `ANTHROPIC_API_KEY` を設定
- 未設定のまま deploy すると、たすきフクロウ AI ヘルプチャットが永続的に 503 fallback (アコーディオン誘導のみ) になり初心者離脱率が上がるため、リリース前に必ず設定すること

**ローカル開発**:
- `.env.local` に `ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxx` を設定 (検証時は Anthropic の無料 credit でも OK)
- 未設定でも UI レイアウト確認は可能 (送信時に「AI が一時的に応答できません」エラー表示)

`HELP_CHAT_MONTHLY_LIMIT_PER_TENANT` (テナント月 100 回上限) は `src/config/billing-feature-units.ts` でハードコード固定 (ADR-0027 で 100 を確定。環境変数化は将来検討)。

## 8. 関連ドキュメント

- **設計判断**: [ADR-0027 (FAQ AI Concierge)](../adr/0027-help-ai-concierge.md) — チャット導入の根拠
- **画面仕様**: [HELP_CHAT.md](../specification/HELP_CHAT.md) — UI 詳細仕様
- **運用監視**: [MONITORING.md](../operations/MONITORING.md) — help-chat 利用量監視
- **関連 ADR**: [ADR-0019 (BILLABLE_FEATURE_UNITS)](../adr/0019-billable-feature-units-and-free-tier-expansion.md) / [ADR-0022 (Embedding 課金)](../adr/0022-embedding-usage-based-billing.md) / [ADR-0026 (Embedding 非同期化)](../adr/0026-embedding-async-generation.md)
- **KDD パターン**: §5.X+187 (FAQ drift 検知) / §5.X+188 (FAQ AI ハルシネーション対策 5 点)
- **メモリ**: [[project_faq_drives_ai_accuracy]] / [[project_mascot_owl]] / [[feedback_client_sessionstorage_user_isolation]]
- **既存実装の参考**: `src/components/chat-semantic-search/chat-panel.tsx` (UI / sessionStorage / 口調)
- **公式ガイド**: [docs/public/account-setup-guide.md](../public/account-setup-guide.md) (利用者向け FAQ と整合)

---

## 9. 改訂履歴

| 日付 | 改訂内容 |
|---|---|
| 2026-05-29 | 初版 (feat/faq-pr5-ai-concierge-core で AI チャット導入時に同時作成) |
| 2026-05-29 | PR7 で関連 doc (ADR-0027 / HELP_CHAT.md / KDD §5.X+188) を作成しリンク更新 |
| 2026-05-30 | ★大改訂★ ADR-0028 で full-context → RAG に移行。§5 (コスト) / §7 (FAQ ライフサイクル SOP) を全面書換、§1.3 (課金分類) に `help-chat-embedding` 追加、§7.0 で旧「Embedding 不要」記述を撤回し新 SOP を明示 |
