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

### 1.3 課金分類

- featureUnit: `help-chat`
- 分類: 全プラン無料 (Beginner 含む、`EMBEDDING_BACKFILL_FEATURE_UNITS` と同じ ¥0 維持パターン)
- Counter: `currentMonthHelpChatCount` (Tenant カラム新設) で月次カウント
- 上限: テナント月 100 回 (= ¥50/月程度の運営コスト想定)
- 上限到達時: HTTP 429 + `fallbackToAccordion: true` を返却 → UI が入力欄を disable してアコーディオン誘導

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

## 5. トークン上限とコスト最適化

### 5.1 現状の容量

| 項目 | tokens 推定 |
|---|---|
| system prompt (キャラクタ + ハルシネーション対策) | ~500 |
| FAQ 全文 (50 件) | ~5,000 |
| 使い方ガイド全文 | ~5,000 |
| 出力スキーマ説明 | ~300 |
| **合計** | **~10,800** |
| Haiku 200K window | 5.4% 使用 |

### 5.2 拡張余地

FAQ を **300 件まで増やしても** 50K tokens 程度に収まり、Haiku window の 25% 使用に留まる。1 query あたりのコスト増は ¥0.5 → ¥1 程度 (許容範囲)。

### 5.3 上限到達時の対応 (RAG 移行)

100K tokens を超えたら、Voyage embedding で関連 FAQ だけ抽出する RAG 化を検討する。設計案:

```
ユーザ質問
  ↓ Voyage embedding (~¥0.036)
faq-content.ts の各 FAQ も embedding 済み
  ↓ コサイン類似度 top-K 抽出 (K=10)
Haiku に「関連 FAQ 10 件のみ」を渡す
  ↓ 回答
```

RAG 移行は ADR-0028 (将来) で正式に決定する。

### 5.4 月間コスト試算

- テナント数: 10 社想定 (β / 初期商用フェーズ)
- 平均利用: 30 回/月/テナント (~ 上限 100 回の 30%)
- 1 query コスト: ¥0.5 (Haiku + ~10K tokens system + ~500 output)
- **月間運営コスト: ¥150 (10 社 × 30 回 × ¥0.5)**

全プラン無料で吸収。Beginner プランの無料試用機能としても無理がない範囲。

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

新規 FAQ を追加する時の checklist:

- [ ] `src/config/faq-content.ts` に新規 entry 追加 (id / category / q / a / visibleTo)
- [ ] 既存 FAQ と矛盾しないかキーワード grep で確認
- [ ] 数値・期間・上限は src/config / ADR / service と一致するか grep で verify
- [ ] 専門用語 (embedding / draft / super_admin 等) を平易語に置換
- [ ] `help-client.test.ts` に 3 種類アサーション追加 (Q 文言 / 重要数値 / 旧誤記再混入防止)
- [ ] docs/public/*.md (account-setup-guide / chat-semantic-search-guide 等) に同じ情報があれば同期
- [ ] LP (HomePage repo) に同じ情報があれば別 PR で同期
- [ ] `pnpm test src/app/\(dashboard\)/help/` で全 assertion PASS
- [ ] `pnpm lint && pnpm tsc --noEmit && pnpm build` で品質ゲート PASS

---

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
