# 新規言語の追加手順

> 中国語 (zh-CN)・ベトナム語 (vi-VN)・韓国語 (ko-KR) などの新規言語を追加するときの開発者向け手順書。
>
> Phase 1+2 で構築した i18n 基盤 (next-intl + カタログ分割 + AppError + CI gate) に乗せることで、
> 主要な作業は **メッセージカタログの翻訳追加** だけで済みます。
>
> 関連:
> - [CONVENTIONS.md](./CONVENTIONS.md) — key 命名・分割方針
> - [GLOSSARY.md](./GLOSSARY.md) — 訳語正本 (新言語追加時は本ファイルにも訳語追加)
> - [HANDOFF_PHASE2.md](./HANDOFF_PHASE2.md) — i18n プロジェクト進捗

---

## サマリ: 6 ステップで言語追加完了

1. **メッセージカタログ複製**: `messages/<新ロケール>.json` + `messages/<新ロケール>/{email,help,guide,faq,superAdmin}.json` を作成
2. **翻訳作業**: ja.json → 新言語に翻訳 (~2000 key、構造は ja と完全一致)
3. **GLOSSARY.md 拡張**: 新言語列を追加して訳語正本を確立
4. **ロケール設定**: `src/config/i18n.ts` の `SUPPORTED_LOCALES` と `SELECTABLE_LOCALES` に追加
5. **request.ts ファイル名マッピング**: 必要に応じて `toMessagesFilename` を拡張
6. **catalog parity test 拡張**: `src/i18n/messages.test.ts` のテストケースに追加 (自動検証)

実装変更は **ほぼゼロ**。 翻訳作業が大半を占めます。

---

## Step 1: メッセージカタログ複製

例: 中国語 (簡体字) を追加する場合は `zh-CN` を使用。

```powershell
# 主カタログ
cp src/i18n/messages/ja.json src/i18n/messages/zh-CN.json

# サブカタログ (admin/help/guide/email/faq/superAdmin の 6 種)
mkdir src/i18n/messages/zh-CN
cp src/i18n/messages/ja/email.json src/i18n/messages/zh-CN/email.json
cp src/i18n/messages/ja/faq.json src/i18n/messages/zh-CN/faq.json
cp src/i18n/messages/ja/guide.json src/i18n/messages/zh-CN/guide.json
cp src/i18n/messages/ja/help.json src/i18n/messages/zh-CN/help.json
cp src/i18n/messages/ja/superAdmin.json src/i18n/messages/zh-CN/superAdmin.json
```

> **重要**: 主カタログとサブカタログの **両方が揃っていないと build エラー** になります。
> `src/i18n/load-messages.ts` の `MESSAGE_SUBFILES` で要求される sub-file 一覧が決まります。

---

## Step 2: 翻訳作業

### 2-1. 自動翻訳の活用 (ドラフト作成)

カタログは JSON で構造化されているため、Claude API / DeepL / Google Translate API で機械翻訳のドラフトを一括生成可能。

```ts
// scripts/translate-catalog.ts (例: Claude API 利用、運営者ローカル実行を想定)
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'node:fs';
const client = new Anthropic();
const ja = JSON.parse(readFileSync('src/i18n/messages/ja.json', 'utf8'));
const result = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 64_000,
  messages: [{
    role: 'user',
    content: `次の JSON 内の各文字列値を中国語 (簡体字) に翻訳してください。\n\n` +
             `制約:\n` +
             `- key (オブジェクトキー) は変更しない\n` +
             `- ICU placeholder {name} {count} 等は維持する\n` +
             `- HTML tag <strong></strong> 等は維持する\n` +
             `- 出力は同じ構造の JSON のみ\n\n${JSON.stringify(ja, null, 2)}`,
  }],
});
// 出力を zh-CN.json に保存
```

> **品質ノート**: 機械翻訳はドラフトにすぎません。本番投入前に **ネイティブ確認** が必須です。
> 特に以下は機械翻訳が苦手:
> - 業務用語 (タスク=Task / ナレッジ=Knowledge など、[GLOSSARY.md](./GLOSSARY.md) で統一)
> - メール文面 (`messages/<locale>/email.json` の Beginner プラン期限通知など、緊急度の高い文面)
> - 法的・契約文言 (利用規約抜粋など)

### 2-2. ICU placeholder の保持

翻訳時に `{name}` `{count, plural, one {...} other {...}}` などの ICU 構文は **そのまま残す**。

```json
// 良い例
{
  "stakeholderCount": "干系人 {count} 人"
}
// 悪い例 (placeholder が消えるとビルドは通るが表示が壊れる)
{
  "stakeholderCount": "干系人若干人"
}
```

`messages.test.ts` の placeholder consistency 検証で、置換漏れは自動検出されます。

### 2-3. HTML/Markdown 構文の保持

`tenantDeleteWarningBody` などには `<strong>...</strong>` が含まれます。これらタグも温存。

```json
// ja
"tenantSuspendWarningBody": "停止前に <strong>テナント代表者 (請求先メール) へ停止予告メールを送信</strong> し、..."

// zh-CN (タグ位置を維持)
"tenantSuspendWarningBody": "停止前请 <strong>向租户负责人（计费邮箱）发送停用预告邮件</strong> 并..."
```

---

## Step 3: GLOSSARY.md 拡張

[GLOSSARY.md](./GLOSSARY.md) は訳語正本です。新言語列を追加します。

```markdown
| 日本語 | English | 中文 (簡体) | 内部識別子 |
|---|---|---|---|
| プロジェクト | Project | 项目 | `project` |
| タスク | Task | 任务 | `task` |
| ナレッジ | Knowledge | 知识 | `knowledge` |
...
```

訳語ドリフト (同じ概念が複数の訳語で揺れる) を防ぐため、PR レビュー時に必ず GLOSSARY を参照します。

---

## Step 4: ロケール設定

[`src/config/i18n.ts`](../../src/config/i18n.ts) を編集:

```ts
export const SUPPORTED_LOCALES = {
  'ja-JP': '日本語',
  'en-US': 'English',
  'zh-CN': '简体中文',  // 追加
} as const;

export const SELECTABLE_LOCALES: Readonly<Record<SupportedLocale, boolean>> = {
  'ja-JP': true,
  'en-US': true,
  'zh-CN': true,  // 追加 (翻訳品質レビュー完了後に true へ)
} as const;
```

> **段階的リリース**: `SELECTABLE_LOCALES` を `false` のまま deploy すると、API/UI 側で 400 拒否される一方、コード資産と翻訳テストは整います。ネイティブ確認完了後に `true` に切り替えるのが安全です。

---

## Step 5: request.ts ファイル名マッピング

[`src/i18n/request.ts`](../../src/i18n/request.ts) の `SUPPORTED_LOCALES` 配列とファイル名解決:

```ts
export const SUPPORTED_LOCALES = ['ja', 'en-US', 'zh-CN'] as const;  // 追加
export type Locale = (typeof SUPPORTED_LOCALES)[number];

function toMessagesFilename(bcp47: string): Locale {
  if (bcp47 === 'en-US') return 'en-US';
  if (bcp47 === 'zh-CN') return 'zh-CN';  // 追加
  return 'ja';
}
```

> `ja-JP` は `messages/ja.json` (短縮形)、`en-US` `zh-CN` は BCP 47 と同名 — の慣習に従います。

---

## Step 6: catalog parity test 拡張

[`src/i18n/messages.test.ts`](../../src/i18n/messages.test.ts) は **ja ↔ en-US の key 一致** を機械的に検証しています。新言語を追加した場合、テストも 3 言語比較に拡張します。

```ts
import zhMessages from './messages/zh-CN.json';
import zhEmail from './messages/zh-CN/email.json';
// ... 他の sub-file も同様に import

describe('messages catalog — 3-locale parity (ja / en-US / zh-CN)', () => {
  const zhFull = mergeMessagesStrict([
    { source: 'zh-CN.json', messages: zhMessages as AnyObject },
    { source: 'zh-CN/email.json', messages: zhEmail as AnyObject },
    // ...
  ]);
  const zhFlat = flatten(zhFull);

  it('zh-CN key set matches ja key set', () => {
    expect(new Set(Object.keys(zhFlat))).toEqual(new Set(Object.keys(jaFlat)));
  });

  it('zh-CN placeholder names match ja per key', () => {
    // jaFlat と同じ placeholder を持つことを確認
  });
});
```

カタログ parity 違反 (key 不足 / placeholder 不一致) は CI で fail します。

---

## Step 7 (推奨): 言語固有のデータ整備

### 7-1. FAQ/Guide コンテンツ並列カタログ

`src/config/faq-content.ts` `src/config/guide-content.ts` は **チャット (たすきフクロウ AI) の知識源** です。
新言語ユーザに対しても賢い応答をするには、faq-content.<locale>.ts を新規作成し、Voyage Embedding を再生成します。

```powershell
# 例: 中国語 FAQ カタログ作成
cp src/config/faq-content.ts src/config/faq-content.zh-CN.ts
# 翻訳して内容を置換
# Embedding 再生成 (locale ごと)
pnpm tsx scripts/generate-faq-embeddings.ts --locale=zh-CN
```

> Phase 2 P6 で `scripts/generate-faq-embeddings.ts` を locale 対応化予定 (未実装)。

### 7-2. master-data ラベル

`src/config/master-data.ts` のステータス名・カテゴリ名は現在 JP 直書き。
Phase 2 P6-1 で「key 参照型」に移行すれば、新言語追加時は何もする必要がなくなります (= 翻訳カタログだけで完結)。

### 7-3. メールテンプレート (大物)

`messages/<locale>/email.json` には **送信者向け本文** が含まれます。特に:

- `email.beginnerExpiry.day60/75/90/150/170.{subject,html,text}` — 5 種 × 3 形式 = 15 entry
- `email.passwordReset.*` — リセット案内
- `email.emailVerification.*` — 招待・MFA 設定

これらは **法的・操作的に重要** なため、翻訳品質を最も慎重にチェックすべきセクションです。

---

## チェックリスト (PR 作成前)

- [ ] `messages/<新ロケール>.json` と `messages/<新ロケール>/*.json` 6 ファイルが揃っている
- [ ] `pnpm test src/i18n/messages.test.ts` が通る (key parity + placeholder)
- [ ] `pnpm tsc --noEmit` がクリーン
- [ ] [GLOSSARY.md](./GLOSSARY.md) に新言語列を追加
- [ ] `src/config/i18n.ts` の `SUPPORTED_LOCALES` / `SELECTABLE_LOCALES` 更新
- [ ] `src/i18n/request.ts` の `SUPPORTED_LOCALES` + `toMessagesFilename` 更新
- [ ] `src/i18n/messages.test.ts` の parity test を 3 言語以上対応化
- [ ] **ネイティブ確認** 完了 (機械翻訳のみは本番投入禁止)
- [ ] (推奨) FAQ/Guide コンテンツの新言語版作成
- [ ] (推奨) 主要画面の手動 smoke (新言語切替でレイアウト崩れ・文字溢れの確認)

---

## トラブルシューティング

### catalog parity test が fail する

```
keys present in ja but missing in zh-CN:
  superAdmin.tenantsListTitle
  superAdmin.tenantsColPlan
  ...
```

→ `messages/zh-CN.json` / `messages/zh-CN/superAdmin.json` に該当 key を追加します。
JSON 構造は ja と完全に同じであるべきです。

### placeholder drift

```
placeholder drift:
  stakeholderCount: ja=[count] zh-CN=[]
```

→ 翻訳時に `{count}` placeholder を消してしまった可能性。元の値を確認して placeholder を復活させます。

### `pnpm build` で next-intl エラー

```
Error: Messages file "zh-CN.json" not found
```

→ `messages/<新ロケール>.json` が存在しないか、`SUPPORTED_LOCALES` 設定と不一致。
Step 1 と Step 5 を再確認します。

### 言語切替後に一部画面が日本語のまま

→ そのファイルがまだ Phase 2 の i18n 化未着手の可能性。
`pnpm check:no-hardcoded-jp:report` で残ハードコード箇所を確認できます。

---

## 文化的考慮

新言語ロケールが日本以外を想定する場合、以下の検討も必要:

| 項目 | 注意 |
|---|---|
| 日付フォーマット | 中: YYYY年MM月DD日 / 韓: YYYY.MM.DD / ベト: DD/MM/YYYY が一般的 (ICU `{date, date, long}` で自動対応可) |
| 数値フォーマット | 1,000 区切り (西欧) vs 万単位 (中・日) (ICU `{value, number}` で自動対応) |
| 通貨 | 現在 ¥ JPY 固定。USD・CNY 対応は別途 currency config が必要 |
| タイムゾーン | テナント設定で TZ 切替可能 (`Asia/Shanghai`, `Asia/Ho_Chi_Minh` 等は `Intl.supportedValuesOf` でサポート済) |
| 曜日開始 | 日: 日曜始まり / 中: 月曜始まり (現状 sun/mon を選べる UI なし、要拡張) |
| アイコン・絵文字 | 文化圏で意味が異なる場合あり (👍 / 🙏 など)、業務系では Lucide icon が安全 |

---

## まとめ

i18n 基盤が整っているため、新言語追加は **「翻訳作業 95%、コード変更 5%」** で完了します。
コードに変更を入れる箇所は `src/config/i18n.ts` + `src/i18n/request.ts` + `src/i18n/messages.test.ts` の 3 ファイルのみで、
それ以外は **カタログの JSON ファイル翻訳** が中心です。

将来言語が増えても、`src/i18n/load-messages.ts` の `MESSAGE_SUBFILES` を増やすだけで構造的拡張も可能です。
