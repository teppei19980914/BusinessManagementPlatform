# i18n 規約 (Conventions)

> たすきば Knowledge Relay のメッセージカタログ / 翻訳キー / コード参照の **規約集**。
>
> 関連: [`GLOSSARY.md`](./GLOSSARY.md) は訳語の正本、本ファイルは仕組みの正本。

---

## 1. ロケール解決フロー

```
1. session.user.locale (User.locale カラム、設定画面で変更)
   ↓ 未設定なら
2. env APP_DEFAULT_LOCALE
   ↓ 未設定なら
3. ハードコードの FALLBACK_LOCALE = 'ja-JP'
```

実装:
- 共通: [`src/config/i18n.ts`](../../src/config/i18n.ts) の `resolveLocale()`
- next-intl: [`src/i18n/request.ts`](../../src/i18n/request.ts) の `getRequestConfig`
- Server Component: `import { getTranslations } from 'next-intl/server'`
- Client Component: `import { useTranslations } from 'next-intl'`

サポート対象は [`SUPPORTED_LOCALES`](../../src/config/i18n.ts) = `{ 'ja-JP': '日本語', 'en-US': 'English' }`。
UI で実際に **選択可能** かは `SELECTABLE_LOCALES` で別管理する。

---

## 2. messages/ ディレクトリ構造 (案 C: ハイブリッド分割)

```
src/i18n/messages/
├── ja.json              ← 主要カタログ (action / nav / 各 entity の中核 ~1200 key)
├── en-US.json
├── ja/
│   ├── admin.json       ← admin/super 配下の見出し・属性 (~250 key)
│   ├── help.json        ← help-client 用 (~150 key、FAQ 検索文言含む)
│   ├── guide.json       ← guide-client 用 (~80 key)
│   ├── email.json       ← メール件名・本文テンプレート (~80 key)
│   └── faq.json         ← FAQ コンテンツ本体 (将来分割対象、現状は faq-content.{en-US}.ts)
└── en-US/
    └── (同上)
```

### 分割基準

| ファイル | 入る | 入らない |
|---|---|---|
| `ja.json` / `en-US.json` | 横断的に使う key (action / nav / common) + 主要 entity (project / risk / wbs / knowledge 等) | 1 画面でしか使わない大物 |
| `ja/admin.json` 等 | 単一画面 (群) でのみ使う、かつ 50 key を超える領域 | 横断的な action / 共通定型 |
| `ja/email.json` | メール文面、長文テンプレート | UI 文言 |

### request.ts での merge

```ts
// src/i18n/request.ts (概念)
const main = (await import(`./messages/${locale}.json`)).default;
const admin = (await import(`./messages/${locale}/admin.json`)).default;
const help = (await import(`./messages/${locale}/help.json`)).default;
const guide = (await import(`./messages/${locale}/guide.json`)).default;
const email = (await import(`./messages/${locale}/email.json`)).default;

// shallow merge: top-level namespace 同士が衝突したら build error にする
const messages = mergeAndValidate({ main, admin, help, guide, email });
```

衝突検出: `mergeAndValidate()` 内で top-level namespace を Set で集約し、重複があれば throw。これにより `admin.json` が誤って `action.*` namespace を書いて主 catalog の同 namespace を上書きする事故を防ぐ。

---

## 3. キー命名規約

### 階層構造

```
<namespace>.<entity_or_scope>.<action_or_field>
```

例:
- `action.save` — 横断的なアクション
- `nav.allProjects` — グローバルナビ
- `project.detail.statusLabel` — プロジェクト詳細画面のステータスラベル
- `risk.bulkUpdate.success` — リスク一括更新の成功 toast
- `message.deleteConfirm` — 汎用削除確認 (上書き可能なら entity 別に分ける)
- `error.tenantNotFound` — AppError コード対応 (`error.<errorCode>` 形式)
- `email.beginnerExpiry.day60.subject` — メール件名 (深い階層は許容)
- `validation.required` — zod errorMap 共通
- `validation.url.invalidScheme` — 個別 validator メッセージ

### namespace 一覧 (主要)

| namespace | 用途 |
|---|---|
| `action` | UI 動詞 (保存/削除/編集等の単語) |
| `nav` | サイドバー / ヘッダー |
| `app` | アプリ全体 metadata (`metaTitle` 等) |
| `common` | 汎用文言 (loading, empty, etc.) |
| `message` | 汎用 toast / バナー |
| `error` | AppError コード → 文言 |
| `validation` | zod / validator メッセージ |
| `email` | メール件名・本文 |
| `notification` | DB Notification の titleKey 描画 |
| `project` / `task` / `risk` / `retro` / `knowledge` / `memo` / `customer` / `stakeholder` / `estimate` | エンティティ別 |
| `auth` / `setting` / `admin` / `superAdmin` | 機能領域別 |
| `help` / `guide` | チャット系画面 |

### 禁止事項

- **同義 key の重複**: `message.deleted` と `action.deleteSuccess` を別々に作らない。1 つに統一して両所で参照する
- **動的 namespace**: `t(`risk.${kind}`)` のような構築は **禁止**。type-safe でないため、静的な分岐 (`kind === 'risk' ? t('risk.delete') : t('issue.delete')`) を書く
- **生 toString のフォーマット**: `${date.toLocaleString()}` をメッセージ内に渡さない。ICU `{date, date, medium}` を使う
- **placeholder の片肺**: `ja` に `{count}` があるなら `en-US` も `{count}` を持つ (messages.test.ts で強制)

---

## 4. ICU MessageFormat 規約

### 数値・複数形

```json
{
  "linkedProjects.sectionTitle": "{count, plural, =0 {No linked projects} one {# linked project} other {# linked projects}}",
  "task.deletedSuccess": "{count, plural, one {Deleted # task} other {Deleted # tasks}}"
}
```

- **必ず `plural` を使う**: `{count} items` のような直書きは `1 items` を生む。ICU plural で `one`/`other` を分岐
- 日本語は `other` のみで OK (`{count, plural, other {#件}}`)
- 英語は最低 `one` + `other` を持つ

### 日付・時刻

```json
{
  "audit.executedAt": "{date, date, medium} at {date, time, short}"
}
```

- メッセージ内で `Intl.DateTimeFormat` を直接使わない (=ハードコード format になる)
- format ヘルパは [`src/lib/format.ts`](../../src/lib/format.ts) に集約 (日付/数値の表示は全て経由)

### 選択 (select)

```json
{
  "user.statusBadge": "{status, select, invited {Invited} active {Active} disabled {Disabled} other {Unknown}}"
}
```

---

## 5. AppError → error.* key 連携

[`src/lib/errors/app-error.ts`](../../src/lib/errors/app-error.ts) の `ErrorCode` union に新規コードを追加したら、必ず両 catalog の `error.<code>` に対応文言を追加する。

```ts
throw new AppError('TENANT_NOT_FOUND', { tenantId: id });
```
→ `error.TENANT_NOT_FOUND`: `"テナント (ID: {tenantId}) が見つかりません"` / `"Tenant (ID: {tenantId}) not found"`

route 側で `getTranslations('error')` 経由で翻訳。fallback コード `error.UNKNOWN` は両 catalog に必ず存在させる。

---

## 6. UI 側の実装パターン

### Server Component

```tsx
import { getTranslations } from 'next-intl/server';

export default async function Page() {
  const t = await getTranslations('project');
  return <h1>{t('detail.title')}</h1>;
}
```

### Client Component

```tsx
'use client';
import { useTranslations } from 'next-intl';

export function ProjectDetailClient() {
  const t = useTranslations('project');
  return <button>{t('detail.save')}</button>;
}
```

### Toast / Confirm

共通ラッパ ([`src/components/ui/toast`](../../src/components/ui/toast)) は **キーと params** を受け取る。コンポーネントは `useTranslations` を持たなくて良い。

```ts
showSuccess('project.saveSuccess');
showError('project.saveFailed');
showError('validation.required', { field: t('field.name') });
```

`window.confirm(t('project.deleteConfirm', { name }))` のような呼び方も OK。**直接 JP リテラルを渡さない**。

### `global-error.tsx` 等 Provider 不在経路

`NextIntlClientProvider` の外側で動くため `useTranslations` 使用不可。
[`src/lib/i18n/static-messages.ts`](../../src/lib/i18n/static-messages.ts) (P3-10 で新設予定) に **静的に事前読込んだ messages の subset** を持ち、cookie/JWT から locale を判定して文言を引く。

---

## 7. Server / Service 側の実装パターン

### Service 層

**生 JP リテラルでの throw は禁止**。`AppError(code, params)` を投げる。

```ts
// NG
throw new Error('テナントが見つかりません');

// OK
throw new AppError('TENANT_NOT_FOUND', { tenantId });
```

### API route

```ts
import { handleApiError } from '@/lib/api-error-handler';

export async function POST(req: NextRequest) {
  try {
    const data = await someService.doIt();
    return NextResponse.json(data);
  } catch (e) {
    return handleApiError(e); // AppError なら翻訳して JSON 返却、それ以外は 500
  }
}
```

route 内で zod を inline で書かない。`src/lib/validators/` に schema を集約し、`setErrorMap` 済の状態で `parse()` する。

---

## 8. メール / 通知 / エクスポート

### メール

テンプレートは `messages/<locale>/email.json` を正本とする。

```ts
const t = await getTranslations({ locale: user.locale, namespace: 'email' });
await sendMail({
  to: user.email,
  subject: t('emailVerification.subject'),
  html: t('emailVerification.html', { url, expiryHours: 24 }),
  text: t('emailVerification.text', { url, expiryHours: 24 }),
});
```

### Notification

DB `Notification` テーブルには **`titleKey` (string) + `paramsJson` (Json)** を保存し、UI 描画時に `t(titleKey, params)` で展開する。
旧 `title` カラムは削除せず fallback として保持 (段階移行)。

### Data Export

`data-export.service.ts` の README ビルダーは `locale` を引数で受け、`messages/<locale>/email.json` の `export.readme.*` (or 専用カタログ) を引いて組み立てる。

---

## 9. テスト戦略

### Unit test (vitest)

- UI text を `toContainText('保存')` で assert しない
- 代わりに `data-testid` + role + 翻訳キー (`screen.getByText(t('action.save'))` 相当) で assert
- ErrorCode を期待する場合は `expect(err.code).toBe('TENANT_NOT_FOUND')` で型レベル検証

### E2E (playwright)

- `loginAs(user, { locale: 'en-US' })` helper で言語を切替えてシナリオを 2 言語で回す
- 主要 smoke spec は `i18n-ja-smoke.spec.ts` / `i18n-en-smoke.spec.ts` 両方を必須化
- Visual baseline は ja / en-US 両系統で `[gen-visual]` 空 commit ルール ([`feedback_visual_baseline_gen`](../knowledge/KDD_PATTERNS.md)) に従い再生成

### messages.test.ts

以下を必須検証:
1. **key parity**: ja と en-US の flatten key set が完全一致
2. **placeholder consistency**: 各 key の `{var}` placeholder set が両 locale で一致
3. **未使用 key 検出**: コード grep で 1 度も参照されていない key を warn
4. **ICU 構文の妥当性**: 全 value を ICU parser で validate

---

## 10. PR review checklist (必須項目)

- [ ] 新規 JP 文字列リテラル / JSX text を追加していない (CI gate `check-no-hardcoded-jp` も検証)
- [ ] 新規 message key を追加した場合、ja / en-US 両 catalog に反映済
- [ ] 新規訳語を使った場合、[`GLOSSARY.md`](./GLOSSARY.md) に追加済
- [ ] `throw new Error('JP')` / `toast('JP')` / `confirm('JP')` 直書きが残っていない
- [ ] ICU placeholder が両 locale で一致 (count, name, date 等)
- [ ] 用語ドリフト無し (例: "Login" を `t()` 経由で出していない → `signIn` に統一)
- [ ] テスト assert を JP 文字列に依存させていない (testid / key 主体)

---

## 11. 化石原則 (Fossilization)

一度カタログに入った key は **既存利用箇所がある限り削除しない**。リネームしたい場合は:
1. 新 key を追加 (同じ value)
2. 利用箇所を一括置換
3. 旧 key を deprecate コメント付きで一定期間保持
4. 半年後に grep で 0 件であることを確認し削除

これにより「リネーム途中の PR が merge され、未対応箇所が UI から消える」事故を防ぐ。
