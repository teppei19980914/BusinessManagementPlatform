# 開発者ガイド (DEVELOPER_GUIDE.md)

> 本書はプログラムの**改修 / 機能追加 / 機能削除**を実施する人向けの実務手順書です。
> 「どこを触れば何が起きるか」を具体的なファイル単位で示し、AI に頼らず一人で
> 作業できることを目的とします。
>
> 関連:
> - [README.md](../../README.md) — プロジェクト概要・初回セットアップ
> - [docs/administrator/OPERATION.md](../administrator/OPERATION.md) — デプロイ・運用・障害対応
> - [docs/developer/DESIGN.md](./DESIGN.md) — 詳細設計 (情報源)
> - [docs/developer/SPECIFICATION.md](./SPECIFICATION.md) — 機能仕様

---

## 目次

1. [src/config/ ディレクトリ案内](#1-srcconfig-ディレクトリ案内)
2. [テーマカラーの追加・変更手順](#2-テーマカラーの追加変更手順)
3. [マスタデータ列挙 (ステータス等) の追加手順](#3-マスタデータ列挙-ステータス等-の追加手順)
4. [新しい画面・機能の追加手順](#4-新しい画面機能の追加手順)
5. [既存機能の改修手順](#5-既存機能の改修手順)
6. [機能削除の手順](#6-機能削除の手順)
7. [DB スキーマ変更手順](#7-db-スキーマ変更手順)
8. [UI ラベルの追加手順 (i18n)](#8-ui-ラベルの追加手順-i18n)
9. [テスト・lint・build の実行](#9-テストlintbuild-の実行)
10. [コミットとデプロイ](#10-コミットとデプロイ)
11. [後続対応 (TODO) 一覧](#11-後続対応-todo-一覧-pr-122-で追加) (PR #122 追加)

---

## 1. `src/config/` ディレクトリ案内

> **設計原則**: 業務的意味を持つ値はプログラム内にハードコードせず、すべて `src/config/` に集約する (DESIGN.md §21.4 ゼロハードコーディング原則)。

### 1.1 ファイル一覧

| ファイル | 役割 | 主な定数・関数 |
|---|---|---|
| `master-data.ts` | 業務概念の列挙 | `TASK_STATUSES` / `VISIBILITIES` / `PRIORITIES` / `RISK_NATURES` / `SYSTEM_ROLES` / `PROJECT_ROLES` 等 |
| `themes.ts` | テーマカタログ | `THEMES` (10 種) / `toSafeThemeId()` |
| `theme-definitions.ts` | テーマ色定義 | `THEME_DEFINITIONS` (CSS 色トークン) / `THEME_COLOR_SCHEMES` (light/dark) |
| `security.ts` | 認証・セキュリティ定数 | `BCRYPT_COST` / `LOGIN_FAILURE_MAX` / `PASSWORD_MIN_LENGTH` / 各トークン期限 |
| `routes.ts` | 認可判定用パス | `PUBLIC_PATHS` / `MFA_PENDING_PATHS` / `LOGIN_PATH` |
| `app-routes.ts` | 画面遷移パス | `PROJECTS_ROUTE` / `MY_TASKS_ROUTE` / `projectDetail(id)` 等 |
| `suggestion.ts` | 提案型サービス調整値 | `SUGGESTION_TAG_WEIGHT` / `SUGGESTION_SCORE_THRESHOLD` |
| `validation.ts` | 入力上限値 | `TITLE_MAX_LENGTH` / `MEDIUM_TEXT_MAX_LENGTH` / `TAGS_MAX_COUNT` |
| `index.ts` | 公開エントリ | 上記すべてを再エクスポート (`import { X } from '@/config'`) |

### 1.2 値を変更したいとき

ほとんどの場合、`src/config/` 配下の該当ファイル 1 行を編集すれば、
プログラム全体に反映されます。例:

| やりたいこと | 編集するファイル |
|---|---|
| ログイン失敗ロック回数を 3 回に変更 | `security.ts` の `LOGIN_FAILURE_MAX` |
| プロジェクト名の最大文字数を 50 に変更 | `validation.ts` の `NAME_MAX_LENGTH` |
| 提案サービスの閾値を 0.1 に変更 | `suggestion.ts` の `SUGGESTION_SCORE_THRESHOLD` |
| ダークテーマの背景を真っ黒に変更 | `theme-definitions.ts` の `dark.background` |
| ログイン画面の URL を `/signin` に変更 | `routes.ts` の `LOGIN_PATH` + `app-routes.ts` の `LOGIN_ROUTE` |

---

## 2. テーマカラーの追加・変更手順

### 2.1 既存テーマの色を変更したい場合

1. `src/config/theme-definitions.ts` を開く
2. 対象テーマ (例: `dark`) の `extend({...})` 内で変更したい token を編集
   ```ts
   dark: extend({
     background: 'oklch(0.10 0 0)',   // ← この値を変更
     foreground: 'oklch(0.99 0 0)',
     ...
   }),
   ```
3. テスト実行 (`pnpm test`) で `theme-definitions.test.ts` が pass するか確認
4. `pnpm dev` で起動して目視確認 (設定画面 → 画面テーマ → dark に切替)

### 2.2 新しいテーマを追加したい場合

例: `'cyber-pink'` という新テーマを追加するケース。

#### Step 1: テーマカタログに登録

`src/config/themes.ts`:
```ts
export const THEMES = {
  light: 'ライトテーマ（デフォルト）',
  dark: 'ダークテーマ',
  // ... 既存 ...
  'cyber-pink': 'サイバーピンク',  // ← 追加
} as const;
```

#### Step 2: 色トークンを定義

`src/config/theme-definitions.ts` の `THEME_DEFINITIONS` に追加:
```ts
'cyber-pink': extend({
  background: 'oklch(0.95 0.08 350)',
  primary: 'oklch(0.55 0.20 350)',
  primaryForeground: 'oklch(0.99 0 0)',
  // ... 必要な差分のみ。指定しない token は LIGHT から継承
}),
```

> **重要**: `satisfies Record<ThemeId, ThemeTokens>` 制約により、追加漏れがあれば `pnpm build` がエラーになります。

#### Step 3: color-scheme を指定

同じファイルの `THEME_COLOR_SCHEMES` にも追加:
```ts
export const THEME_COLOR_SCHEMES = {
  // ... 既存 ...
  'cyber-pink': 'light',  // 背景が明るいので 'light'
} as const satisfies Record<ThemeId, 'light' | 'dark'>;
```

#### Step 4: 動作確認

```bash
pnpm test     # theme-definitions.test.ts が新テーマを検証
pnpm build    # 型エラーがないか
pnpm dev      # 設定画面で切替
```

---

## 3. マスタデータ列挙 (ステータス等) の追加手順

例: `TASK_STATUSES` に `'review'` (レビュー中) を追加するケース。

### Step 1: 定義に追加

`src/config/master-data.ts`:
```ts
export const TASK_STATUSES = {
  not_started: '未着手',
  in_progress: '進行中',
  review: 'レビュー中',  // ← 追加
  completed: '完了',
  on_hold: '保留',
} as const;
```

### Step 2: DB バリデーションを更新

`src/lib/validators/task.ts` 等で `z.enum(...)` を使っている箇所があれば、
新しい値を追加します。

### Step 3: ロジック影響を確認

新ステータスがあることで業務ロジックに影響が出るか検討:
- 進捗率との整合性 (`task.service.ts` の `normalizeProgressForStatus`)
- WP の状態自動判定 (`aggregateWpFromChildren`)
- フィルタ UI のデフォルト選択肢

### Step 4: マイグレーション (DB に既存値で投入されている場合)

新しい値を既存レコードに使いたい場合は migration を作成:
```bash
npx prisma migrate dev --name add_task_status_review
```

---

## 4. 新しい画面・機能の追加手順

例: 「コメント機能を全エンティティに追加する」のような大型機能追加の場合。

### Step 1: 設計書に章を追加

`docs/DESIGN.md` に新セクションを追加し、以下を明記:
- なぜ必要か (背景)
- データモデル (テーブル定義 / マイグレーション計画)
- API 仕様
- 画面仕様 (UI モック・遷移)
- 認可ルール
- セキュリティ考慮事項

### Step 2: DB マイグレーション作成

```bash
# prisma/schema.prisma を編集してテーブル追加
npx prisma migrate dev --name add_comments
```

詳細は本書 §7 (DB スキーマ変更手順)。

### Step 3: 型 + バリデータ作成

| ファイル | 内容 |
|---|---|
| `src/lib/validators/comment.ts` | Zod スキーマ (`createCommentSchema` 等) |
| 新規型 (DTO) は service ファイル内で `export type CommentDTO` として宣言 |

### Step 4: サービス層実装

`src/services/comment.service.ts` を作成:
- ファイル先頭に **必ず docblock** を書く (役割 / 設計判断 / 認可 / 関連設計書)
  → 既存の `memo.service.ts` 等を参考に
- CRUD 関数: `listComments` / `getComment` / `createComment` / `updateComment` / `deleteComment`
- 認可は呼び出し元 API ルートに任せる方針

### Step 5: API ルート実装

`src/app/api/comments/route.ts` 等を作成:
- ファイル先頭に **必ず docblock** を書く (HTTP メソッド / 認可 / 監査 / 関連設計書)
- 認可: `getAuthenticatedUser` + `checkProjectPermission` または `requireAdmin`
- 監査: 変更系操作は `recordAuditLog` を呼ぶ

### Step 6: UI 実装

| ファイル | 内容 |
|---|---|
| `src/app/(dashboard)/.../comments/page.tsx` | サーバコンポーネント (auth 確認 + 初期データ取得) |
| `src/app/(dashboard)/.../comments/comments-client.tsx` | クライアントコンポーネント |
| ファイル先頭に **必ず docblock** を書く (役割 / 設計 / 認可 / API / 関連) |

### Step 7: i18n ラベル追加 (必要なら)

新画面で使うラベルを `src/i18n/messages/ja.json` に追加 (詳細は §8)。

### Step 8: テスト

- サービスの単体テスト: `src/services/comment.service.test.ts`
- バリデータの単体テスト: `src/lib/validators/comment.test.ts`
- メッセージカタログテストが新キーを検出: `src/i18n/messages.test.ts` 内の `REQUIRED_*_KEYS` に追加

### Step 9: ドキュメント更新

- `docs/DESIGN.md` の該当章
- `docs/SPECIFICATION.md` の機能仕様
- `README.md` の機能一覧 (大型機能の場合)

### Step 10: lint / test / build → コミット → PR

詳細は §9, §10。

---

## 5. 既存機能の改修手順

### 5.1 バリデーション値 (文字数上限等) を変える

`src/config/validation.ts` の該当定数を編集するだけ。Zod / JSX 両方の参照が
自動で追従します。例: ナレッジ本文を 3000 → 5000 文字に増やす:
```ts
export const KNOWLEDGE_CONTENT_MAX_LENGTH = 5000;  // ← この行のみ
```

### 5.2 認可ルールを変える

`src/lib/permissions.ts` の `checkPermission` (Action × ProjectRole の許可マトリクス)
を編集します。詳細は `DESIGN.md §8.3`。

### 5.3 状態遷移ルールを変える

`src/services/state-machine.ts` の `canTransition` を編集します。
プロジェクト状態の遷移制約はここに集約されています。

### 5.4 UI レイアウトを変える

該当する `*-client.tsx` を編集します。レイアウト用の Tailwind utility class
(`flex` / `gap-4` / `p-3` 等) は通常通り JSX に書きます (DESIGN.md §21.4 対象外)。

### 5.5 色を変える

DESIGN.md §29.4 の通り、`src/config/theme-definitions.ts` の token 値を編集
します。生コード上で `bg-gray-50` 等のパレット色は使わず、必ず semantic token
(`bg-muted` / `text-foreground` 等) を使ってください (PR #76 で全置換済み)。

### 5.8 Select と SearchableSelect の使い分け (PR #126 で追加)

選択肢の種別により 2 種類のコンポーネントを使い分ける:

| コンポーネント | 対象 | 根拠 |
|---|---|---|
| **`<Select>` (既存)** / ネイティブ `<select>` | 項目数が固定少数 (5〜10 件以下) のマスタデータ系 | 例: 状態 / 優先度 / ロール / ロケール / テーマ。既存挙動で十分 |
| **`<SearchableSelect>` (PR #126 新設)** | 件数が**増える可能性**のあるエンティティ系 | 例: ユーザ / 顧客 / プロジェクト / 担当者選択。Viewport 比でスクロール必要と判断したときのみ検索欄を表示 (通常時は普通の Select 体験) |

**使い方**:

```tsx
import { SearchableSelect } from '@/components/ui/searchable-select';

<SearchableSelect
  value={userId}
  onValueChange={setUserId}
  options={users.map((u) => ({ value: u.id, label: `${u.name}（${u.email}）` }))}
  placeholder="ユーザを選択..."
  aria-label="ユーザ選択"
/>
```

**セキュリティ設計** (採用時の注意):
- フィルタ文字列は `String.prototype.includes()` (ReDoS 回避)
- label は JSX テキストノード (React 自動エスケープで XSS 耐性)
- ユーザ入力を regex / eval / HTML 展開に渡さない

判断に迷ったら: 「将来この一覧が 50 件を超える可能性があるか」で判断。Yes なら SearchableSelect。

### 5.7 ダイアログサイズ・スクロール規約 (PR #112 で統一)

**背景**: 基底 `DialogContent` は以前 `sm:max-w-sm` (= 24rem = 384px) のみ指定で、
max-height / overflow 未指定だった。これにより:
- 縦長コンテンツ (危険な操作セクション等を含む編集画面) は viewport より高くなると
  **下部が見切れて削除ボタンが操作不能**になる (admin/users 編集で実害発生)。
- 既定 24rem は大画面で余白過剰になりやすく、各画面が個別に
  `max-w-[min(90vw,XXrem)]` を上書きしていたが統一感がなかった。

**PR #112 方針**:

1. **基底で scroll 対応** (`src/components/ui/dialog.tsx`)
   - `max-h-[calc(100vh-4rem)]` + `overflow-y-auto` を default に追加
   - **caller 側で `max-h` / `overflow` を書く必要はなくなった** (既存の指定は残しても可)
   - 既定 `sm:max-w-sm` → `sm:max-w-[min(90vw,36rem)]` に引き上げ

2. **ダイアログサイズの 3 段階標準** (caller 側で className 上書き時の目安):

   | 想定用途 | 推奨 className | 実寸 (≥1024px) |
   |---|---|---|
   | シンプル (確認 / 1-2 項目フォーム / CSV インポート) | `max-w-[min(90vw,32rem)]` | 512px |
   | admin 系フォーム (5-7 項目、lg で拡大したい) | `max-w-[min(90vw,32rem)] lg:max-w-[min(70vw,44rem)]` | lg: 704px |
   | リッチフォーム (grid-cols-2 + DateFieldWithActions + 添付等) | `max-w-[min(90vw,42rem)]` | 672px |

3. **「画面余白が広すぎる」と感じたら**:
   - lg: breakpoint で `max-w-[min(70vw,44rem)]` 以上を許容する方針。
   - `min(XXvw, YYrem)` で **`vw` / `rem` どちらが先に効くか** を意識する:
     - 狭い viewport では `XXvw` が勝って viewport に追従
     - 広い viewport では `YYrem` が勝ってダイアログ幅が固定される
   - 幅を本当に viewport 追従させたい場合のみ `vw` 比率を上げる (過剰に上げると
     1920px 等で異常に大きくなるので注意)。

### 5.6 編集ダイアログの state 初期化ルール (PR #88 で統一)

**原則**: 編集ダイアログは**開くたびに DB の最新データ (props 経由) を初期表示**する。
編集途中で閉じて再度同じエンティティを開いた場合も、途中編集値ではなく DB データに
リセットする。

**実装パターン** (React の Derived State を活用):

```tsx
const [prevId, setPrevId] = useState<string | null>(null);  // ← null で初期化
if (entity && entity.id !== prevId) {
  setPrevId(entity.id);
  setForm({ /* entity から初期化 */ });
  setError('');
}
// 閉じた時 (entity=null) に prev をリセットしないと、
// 同一 ID 再オープン時に `'A' !== 'A'` で同期が走らず stale state が残る
if (!entity && prevId !== null) {
  setPrevId(null);
}
```

**インライン編集の場合** (tasks-client / project-detail-client 等):
onOpenChange で `o=true` 分岐に entity → form のセット処理を書く。例:

```tsx
const openEditDialog = () => {
  setForm({ /* entity prop から再初期化 */ });
  setError('');
  setIsOpen(true);
};
```

**useEffect を使わない理由**:
- `react-hooks/set-state-in-effect` lint ルールに抵触する
- Derived State は React 公式推奨パターン (https://react.dev/learn/you-might-not-need-an-effect)

### 5.9 レスポンシブ実装パターン (PR #128 で整理)

**設計原則** (ユーザ要件、変更禁止):
- **PC UX は絶対に落とさない** (メイン作業環境)
- **スマホ UX を最大限向上** (PC UX を損なわない範囲で)
- タブレットは最低優先 (現状の responsive で許容)

**対象 breakpoint**:

| 範囲 | 対応 |
|---|---|
| 〜639px (縦向きスマホ) | 🔴 最優先対応 |
| 640〜767px (`sm:` 横向きスマホ) | 🟡 中 |
| 768〜1023px (`md:` タブレット) | 🟢 低 |
| 1024px+ (`lg:` PC) | ✅ **既存維持** |

**必須パターン**:

| パターン | 適用箇所 | 例 |
|---|---|---|
| **固定幅の `min-w-[Xpx]` / `w-[Xpx]`** で X > 380px | ポップオーバー / カード / モーダル | `max-w-[min(90vw,Xpx)]` に変更 |
| **多列テーブル** (≥5 列) | 横断一覧画面 | `<ResponsiveTable>` を使用 (md: で table、未満でカード) |
| **Dialog** | 全モーダル | `max-w-[min(90vw,Xrem)]` (既に全適用済、PR #112) |
| **Grid** | カラム配置 | `grid-cols-1 md:grid-cols-2` / `md:grid-cols-3` 等 breakpoint 明示 |

**`<ResponsiveTable>` の使い方** (PR #128 新設):

```tsx
import { ResponsiveTable } from '@/components/ui/responsive-table';

<ResponsiveTable
  items={risks}
  getRowKey={(r) => r.id}
  onRowClick={(r) => openDialog(r)}
  columns={[
    { key: 'title', label: '件名', primary: true, render: (r) => r.title },
    { key: 'assignee', label: '担当者', render: (r) => r.assigneeName },
    { key: 'status', label: 'ステータス', render: (r) => <Badge>{r.status}</Badge> },
  ]}
  emptyText="データがありません"
  aria-label="リスク一覧"
/>
```

- `primary: true` の列: カードモードのタイトル位置に太字で表示 (1 列のみ推奨)
- `hiddenOnCard: true`: テーブルには表示、カードには非表示 (詳細列の省略用)
- PC (md:+) は従来通り `<table>` レンダ、スマホは各行が `<Card>` に変換される
- SSR で両 DOM を出力、CSS (`hidden md:block` / `md:hidden`) で切替 → CLS ゼロ、チラつきなし

**禁止事項**:
- `window.innerWidth` で JS 判定しない (SSR mismatch の原因、CLS も発生)
- PC UX を犠牲にするスマホ最適化 (「PC では使いにくいがスマホには便利」は NG)

**段階的 PR 計画** (`docs/developer/RESPONSIVE_AUDIT.md` 参照):
- PR #128 (本 PR): 監査 + 基盤 (`ResponsiveTable`) + 即時修正 1 件 + Playwright mobile project
- PR #128a: P1 テーブル (`/projects`, `/projects/[id]/tasks`)
- PR #128b: P2 横断一覧 (`/risks`, `/issues`, `/retrospectives`, `/knowledge`)
- PR #128c: P3 admin / 低優先 (`/all-memos`, `/admin/*`, `/customers`)
- PR #128d: fine-tune (text-xs / padding / タップ領域)

### 5.10 フォーム送信前の事前バリデーション (エラー情報最小化方針) (fix/project-create-customer-validation で整理)

**背景 (本サービスの設計原則)**:
このサービスは「**ユーザ/攻撃者に内部情報を与えない**」方針で、エラーは
サーバ側ログに記録しブラウザ側には最小限の UI メッセージしか出さない。
しかし HTTP 400 レスポンス自体はブラウザの Network/Console が自動で表示するため、
**validation で 400 を返すたびにエラー情報が意図せず Console に出力** される。

**原因パターン**:

1. HTML5 `<input required>` で拾えないフィールド (Combobox / SearchableSelect /
   カスタム Select 等) で必須入力チェックが抜ける
2. 空文字や無効値のまま `fetch()` で POST が飛ぶ
3. サーバ Zod schema で UUID / enum / min(1) 等が弾き 400 を返す
4. ブラウザが 400 を Console に出力 → 「エラー情報を出さない」方針違反

**修正パターン**: `async function handleCreate/handleAdd/handleSubmit(...)` の
**先頭でクライアント側事前バリデーション** を行い、該当時は `setError(...)` + `return`
で POST を抑止する。

```tsx
async function handleCreate(e: React.FormEvent) {
  e.preventDefault();
  setError('');

  // HTML5 required で拾えない SearchableSelect 用の事前バリデーション。
  // 空のまま POST すると API が 400 を返し、ブラウザ Console にエラーが出てしまう。
  if (!form.customerId) {
    setError('顧客を選択してください');
    return;
  }

  const res = await fetch('/api/projects', { method: 'POST', body: JSON.stringify(payload) });
  // ...
}
```

**対象となるコントロール (2026-04-24 時点)**:

| コントロール | HTML5 required 有効 | 事前 validation 必要 |
|---|---|---|
| `<Input required>` / `<textarea required>` | ✅ 自動 | 不要 |
| `<select required>` (native) | ✅ 自動 | 不要 (default 値がある場合は特に) |
| `SearchableSelect` (Base UI Combobox 基盤) | ❌ HTML5 非対応 | **必須** |
| `DateFieldWithActions` (required prop) | 🟡 内部 input で有効、ただし UI 文言は独自 | 通常不要、場合により |
| `Select` (shadcn/ui / Radix) | ❌ HTML5 非対応 | 必須 (required にしたい場合) |

**先例 (既存コードに埋まっている参考実装)**:

- [members-client.tsx `handleAdd`](../../src/app/(dashboard)/projects/[projectId]/members-client.tsx) :
  `if (!addForm.userId) { setAddError('ユーザを選択してください'); return; }`
- [projects-client.tsx `handleCreate`](../../src/app/(dashboard)/projects/projects-client.tsx) :
  `if (!form.customerId) { setError('顧客を選択してください'); return; }` (本 fix)

**汎化ルール**:

1. **SearchableSelect / Base UI Combobox / カスタム Select を「必須項目」として
   扱う場合は必ず `handleXxx` 先頭で事前 validation を書く**。
2. **UI メッセージ文言は サーバ Zod schema の `message` と揃える** (一致していれば
   ユーザにとって「Cloud/ローカルどちらで検証されても同じ文言」になり体験が破綻しない)。
3. **E2E 回帰テストで POST が飛ばないことまで assert する**
   (`page.on('request', ...)` でカウント、空 validation 後に `expect(counter).toBe(false)`)。
4. **新しい必須コントロールを採用したら本表と §5.10 本文の対象表を更新する**。

### 5.10.1 Base UI Combobox で `{ value, label }` オブジェクトを items に渡す際の罠 (fix/project-create-customer-validation で発覚)

`SearchableSelect` の中身は `@base-ui/react/combobox`。 Combobox.Root の `items` に
`{ value: string; label: string }[]` を渡すと、Base UI は以下の挙動になる:

- **表示**: `itemToStringLabel` 自動検出により `label` が input に表示される (OK)
- **submission**: `itemToStringValue` 自動検出により `value` がフォーム送信値になる (OK)
- **`onValueChange` の引数**: **オブジェクト全体 (`{ value, label }`) が渡る** (注意)

つまり `Combobox.Root.onValueChange={(v) => ...}` の `v` は string ではなく object である。
旧実装の `if (typeof v === 'string') onValueChange(v)` では object が弾かれて
parent state が更新されず、**ユーザがクリックしても選択状態にならない** 症状になる。
併せて `value` prop も string ではなく `items` と同じ shape (object) を渡す必要があり、
親コンポーネントが string id で state 管理したい場合は options から逆引きする
(`options.find((o) => o.value === value) ?? null`) のが正しい。

```tsx
// NG (旧実装): object を弾いてしまうため選択イベントが伝播しない
onValueChange={(v) => {
  if (typeof v === 'string') onValueChange(v);
}}

// OK: object / string / null (clear) を網羅
onValueChange={(v) => {
  if (v === null || v === undefined) return onValueChange('');
  if (typeof v === 'string') return onValueChange(v);
  if (typeof v === 'object' && 'value' in v && typeof v.value === 'string') {
    return onValueChange(v.value);
  }
}}
```

一次ソース: [@base-ui/react ComboboxRoot.d.ts L34-L42](../../node_modules/@base-ui/react/combobox/root/ComboboxRoot.d.ts) の
`itemToStringLabel` / `itemToStringValue` JSDoc。Value 型の推論から onValueChange は
`Value` (= object) で emit されるため、auto-detect は **表示/submission 用のヘルパであり
onValueChange の型までは変換しない**。

### 5.10.1.5 `<Label>` と `<Input>` の `htmlFor`/`id` ペア必須 (a11y + E2E の両立、fix/project-create-customer-validation 補足)

shadcn/ui の `<Label>` は内部で `<label>` を素の形で描画する (FormField 等の文脈提供は無し)。
**`htmlFor` 無しの `<Label>` は `<Input>` / `<textarea>` / `<select>` と ARIA 関連付けされず**、
以下の 2 つが同時に壊れる:

1. **スクリーンリーダー読み上げ**: fieldset 名 / フィールド名が読まれない
2. **Playwright `getByLabel`**: input 要素に辿り着けず 10s timeout

既知の罠 §4.3 「`getByLabel` は ARIA リンクが無いと動かない」の再発であり、
projects-client の `顧客` (PR #111-2 で htmlFor 付与) 以外のフィールドがすべて未対応だった
ため E2E Step 6b の `getByLabel('プロジェクト名').fill(...)` が timeout していた。

**規約**: 新規フォームで `<Label>` を使う場合、**必ず htmlFor + id のペアを付与** する。
id の naming convention は `{screen}-{action}-{field}` (例: `project-create-name`)。

```tsx
// NG: 見た目は同じだが a11y も E2E も壊れる
<Label>プロジェクト名</Label>
<Input value={form.name} ... />

// OK
<Label htmlFor="project-create-name">プロジェクト名</Label>
<Input id="project-create-name" value={form.name} ... />
```

※ shadcn/ui が FormField パターンを入れていない理由は単純に未導入なだけ。将来的に
`react-hook-form` + shadcn FormField 導入時は自動関連付けされるため、この規約は
手動レイヤでの代替策。

### 5.10.2 タグ入力区切り: 全角読点「、」も受容する (fix/project-create-customer-validation)

`業務ドメインタグ` / `技術スタックタグ` / `工程タグ` 等のフリーテキスト入力は
`@/lib/parse-tags.ts#parseTagsInput` で正規化する。受容する区切り文字:

- `,` (U+002C, 半角カンマ)
- `、` (U+3001, 読点 / Japanese ideographic comma)
- 前後空白は trim、空要素は除去

日本語入力モードのまま `基幹、会計` と読点区切りで入れるのが自然なため、半角カンマ
限定だと実質「タグ 1 件」扱いになる UX 破綻が起きていた (提案精度に直結)。
意図的に対象外とした区切り:

- `;` / `/` / `\n` — 単語内に含まれる可能性 (例: `React 18.3/Next 16`) があり誤分割リスク

placeholder 文言も「カンマ区切り」→「カンマ or 読点「、」で区切り」に更新済。

---

## 6. 機能削除の手順

### Step 1: 影響範囲の確認

```bash
# 削除対象の関数 / API ルートが使われている箇所を網羅
grep -rn "deleteFunctionName" src
```

### Step 2: 順序立てた削除

1. **UI 側**: 削除対象機能を呼び出している画面を修正 (リンク削除 / ボタン非表示)
2. **API ルート**: `src/app/api/.../route.ts` を削除
3. **サービス層**: 該当関数を削除
4. **バリデータ / 型**: 該当スキーマと型を削除
5. **DB マイグレーション** (テーブル / カラム削除を伴う場合): 別 migration
   ```bash
   npx prisma migrate dev --name drop_xxx
   ```
6. **テスト**: 削除した関数のテストを削除
7. **ドキュメント**: DESIGN.md / SPECIFICATION.md から該当記述を削除

### Step 3: 監査ログの保護

ユーザの過去操作の監査ログ (`audit_logs.entityType` 等) で該当エンティティが
参照されている可能性があります。**監査記録は削除しない**でください
(将来トレース不能になるため)。

---

## 7. DB スキーマ変更手順

詳細は [docs/administrator/OPERATION.md](../administrator/OPERATION.md) §3 (DB マイグレーション手順) を参照。

要点:

1. ローカルで `prisma/schema.prisma` を編集
2. `npx prisma migrate dev --name xxx` で migration ファイル生成 + ローカル適用
3. PR を作成
4. **本番デプロイ前**に Supabase ダッシュボードの SQL Editor で migration SQL を
   手動実行する (Vercel ビルドでは自動適用されない設計)
5. 本番 DB 更新後に PR をマージ → Vercel が自動デプロイ

---

## 8. UI ラベルの追加手順 (i18n)

### 8.1 既存カテゴリへの追加 (Phase A/B/C 範囲)

`src/i18n/messages/ja.json` に追加:
```json
{
  "action": {
    "save": "保存",
    "submit": "送信"  // ← 追加
  }
}
```

`src/i18n/messages.test.ts` の `REQUIRED_*_KEYS` 配列にもキーを追加して、
将来の追加漏れを CI で検出できるようにします。

JSX 側の使い方:
```tsx
'use client';
import { useTranslations } from 'next-intl';

function MyComponent() {
  const t = useTranslations('action');
  return <Button>{t('submit')}</Button>;
}
```

### 8.2 サーバコンポーネントでの使い方

```tsx
import { getTranslations } from 'next-intl/server';

export default async function Page() {
  const t = await getTranslations('action');
  return <h1>{t('submit')}</h1>;
}
```

### 8.3 移行ステータス

| Phase | 範囲 | 状態 |
|---|---|---|
| A | アクション動詞 9 語 (保存/削除/キャンセル等) | ✅ 完了 (PR #77) |
| B | フォームラベル (件名/内容/担当者等) | 🟡 カタログ完備、JSX 移行は段階的 (PR #81 で 1 サンプル実施) |
| C | 共通メッセージ (saveSuccess/deleteConfirm 等) | 🟡 カタログ完備、JSX 移行は使用機会のあるたびに段階移行 |
| D | 画面固有文言 | 多言語化が必要になった段階で一括抽出予定 |

---

## 9. テスト・lint・build の実行

```bash
# 単体テスト (vitest)
pnpm test

# テストをウォッチモードで
pnpm test:watch

# 単体テスト + カバレッジ計測 (PR #83 で追加)
#   coverage/coverage-summary.json / lcov.info / HTML レポート (coverage/lcov-report/index.html)
#   を出力する。HTML を開けば行単位で未到達箇所を確認可能。
pnpm test --coverage

# Lint (eslint)
pnpm lint

# ビルド検証 (型エラー / Next.js ビルドエラーを検出)
pnpm build
```

**コミット前に最低限すべて通ること**。Stop hook で自動検査されます。

### 9.1 CI のカバレッジレポート (PR #83)

GitHub Actions CI は `pnpm test --coverage` を実行し、`davelosert/vitest-coverage-report-action@v2`
経由で **PR コメントにカバレッジ要約・変更ファイル別カバレッジ・変更行カバレッジ** を
自動投稿する。外部サービス (Codecov 等) 連携なしで GitHub 完結。

- 対象計測範囲: `src/lib/**` / `src/services/**` (`vitest.config.ts` の `coverage.include` で指定)
- レポーター: `text` / `lcov` / `json` / `json-summary` (action 必須の 2 つを含む)
- CI 実行は `main` への push / PR でトリガー (PR コメントは PR 時のみ)

### 9.2 カバレッジ閾値 80% (PR #84)

`vitest.config.ts` の `thresholds` で **Lines / Statements / Functions: 80%**、
**Branches: 70%** を常時強制する。これを下回る変更は CI (`pnpm test`) が失敗し
マージできない。

**計測対象外 (coverage.exclude)** — 単体テストで検証するのが困難なため除外:

| ファイル | 除外理由 |
|---|---|
| `src/lib/auth.config.ts` / `src/lib/auth.ts` | next-auth provider 配線 (integration test 領域) |
| `src/lib/use-lazy-fetch.ts` / `src/lib/use-session-state.ts` | React クライアントフック (要 RTL) |
| `src/lib/db.ts` | PrismaClient のインスタンス化のみ |
| `src/lib/search/pg-trgm-provider.ts` | 実 PostgreSQL (pg_trgm 拡張) 接続が必要 |
| `src/lib/mail/resend-provider.ts` | 外部メール送信 API アダプタ (本物の Resend 必要) |
| `**/*.test.ts`, `**/*.d.ts` | テスト本体・型定義 |

**閾値を下げたい場合**の運用:
1. 原則として **テストを追加して充足させる** (除外を増やさない)
2. どうしても単体テストで検証不可能なファイルが増えた場合のみ `coverage.exclude` に
   追加し、Why をコメントで残す
3. `thresholds.branches` を 70% 未満にする変更は事前に DESIGN.md で合意を取る

### 9.3 Security Workflow 攻撃種別マトリクス (PR #84)

[.github/workflows/security.yml](../../.github/workflows/security.yml) の最後に
`attack-matrix` job があり、GitHub Actions の **Job Summary** に以下のような
攻撃種別マトリクスを日本語で自動出力する:

| 状況 | 攻撃種別 (Attack) | 主な検証手段 |
|:---:|---|---|
| ✅ | 機密情報漏洩 (Secrets Exposure, CWE-798) | gitleaks |
| ✅ | SQL インジェクション (SQL Injection, CWE-89) | Semgrep / CodeQL + Prisma ORM |
| ✅ | 認可バイパス / IDOR (Authorization Bypass, CWE-639) | CodeQL + checkProjectPermission |
| ... | ... | ... |

- テンプレートは [.github/attack-matrix-summary.md](../../.github/attack-matrix-summary.md)
- ワークフロー側で `sed` による `@@FOO@@` プレースホルダ置換で実スキャン結果を埋め込む
- **行を追加/編集したいとき**: `.github/attack-matrix-summary.md` を直接編集する。
  `to_mark` / `or_mark` で使えるステータストークン (`@@GITLEAKS@@` / `@@AUDIT@@` /
  `@@SAST@@` / `@@CODEQL@@`) は security.yml の `sed` で定義済み。新しい検証手段を
  増やす場合は security.yml にも変数を追加する。

### 9.3.5 E2E 実装で得られた知見 (PR #90 以降累積)

新しい E2E spec を書く前 / CI で E2E が赤になった時は、まず
**[docs/E2E_LESSONS_LEARNED.md](./E2E_LESSONS_LEARNED.md)** を一読する。
PR #90 以降の hotfix から得た **25 個の罠パターン** (§4.1〜§4.25) と
**アサーション戦略**が集約されている。

### 9.4 E2E テスト (PR #90 で導入)

```bash
# ローカル実行 (Next.js dev 起動済みが前提)
pnpm dev &
pnpm test:e2e                       # 全 specs + visual を実行
pnpm test:e2e:ui                    # UI モードで対話的に実行
pnpm test:e2e:update-snapshots      # 視覚回帰 baseline を更新

# カバレッジ一覧の gap 検出
pnpm e2e:coverage-check
```

#### 「何のテストをしているか」の確認方法 (PR #93 hotfix 2 で整備)

1. **`e2e/README.md`** — 各 spec のシナリオを日本語で一覧化。コードを読まなくても
   全シナリオが把握できる。新しい spec を追加したら必ず更新する。
2. **Playwright HTML レポート** — CI の Artifact `playwright-report-<run_id>.zip` を
   解凍し `index.html` を開く。各 test の trace viewer で各 action 毎の
   DOM snapshot + スクリーンショット + ビデオを視覚的に追える。
3. **節目スクリーンショット** — `test-results/steps/` 配下 (Artifact
   `playwright-test-results-<run_id>.zip`) にラベル付きで保存される。
   各 spec が `await snapshotStep(page, 'step-N-what-happened')` で
   意味のある瞬間をキャプチャしている。
4. **UI モード (ローカル)** — `pnpm test:e2e:ui` で Playwright の対話モードが起動。
   time travel デバッガで任意時点の DOM を検査でき、成功したテストも
   action 単位で追える。人間による目視確認に最適。

PR #93 hotfix 2 で `playwright.config.ts` の `trace` / `screenshot` / `video` を
全て `'on'` に変更し、成功・失敗を問わず記録する方針にした (Artifact 肥大化は
14 日保持で吸収)。

### 9.5 新機能追加時の E2E カバレッジ横展開 (必須)

**新しい `page.tsx` や `route.ts` を追加したら、必ず `docs/developer/E2E_COVERAGE.md` を更新**してください。
更新がないと `ci.yml` の `e2e:coverage-check` ステップが fail し、マージできません。

更新パターン:
```markdown
# 完全に E2E カバー済
- [x] `/new-feature` — e2e/specs/04-new-feature.spec.ts

# 同一 PR 内ではカバーせず、後続 PR で追加予定
- [ ] `/new-feature` — skip: PR #XX で追加予定

# 意図的にカバー対象外
- [ ] `/admin/legacy-report` — skip: read-only / 優先度低
```

#### 9.5.1 漏れた場合の CI 連鎖 fail パターン (PR #115 で得た知見)

`E2E coverage manifest check` が fail すると、**後続の `Test (vitest + coverage)` ステップが
skip され、`coverage/coverage-summary.json` が生成されない**。その結果
`Report coverage (PR comment)` ステップが `if: always()` で走るものの、
`coverage-summary.json` が不在で ENOENT エラーとなり **2 ステップが赤で表示される**。

見かけの症状:
- Actions 一覧で `E2E coverage manifest check` と `Report coverage` の 2 ステップが ✗
- `Report coverage` の log に `Error: ENOENT: no such file or directory, open '.../coverage-summary.json'`

**真因は 1 つ**: `E2E_COVERAGE.md` に新規 `route.ts` / `page.tsx` の記載漏れ。
manifest を修正するだけで 2 つの赤ランプが同時に解消する (Report coverage は副次症状)。

デバッグ時のコツ:
1. **まず Actions 一覧の最初の ✗ を見る** — 後続の fail は大体その連鎖症状
2. `pnpm e2e:coverage-check` をローカルで実行して同じエラーが出るか確認
3. `script/check-e2e-coverage.ts` の出力にある「未記載の機能」を手動で `E2E_COVERAGE.md`
   に追記 (`[x]` / `[ ] skip: <理由>` のどちらかを選ぶ)

### 9.6 視覚回帰のベースライン運用 (PR #90 合意 → PR #96 で自動化)

視覚回帰テスト (`e2e/visual/*.spec.ts`) の baseline PNG は `e2e/**__screenshots__/` に
commit されています。**PR 中に baseline 更新を許容**する方針です (前提: リビジョンが
git 履歴に残るため監査可能)。

**baseline 生成は Linux CI 環境で自動実行** (Windows / macOS ローカルではフォント差異で
別 PNG になるため使わない):

#### トリガ方法 A: commit message タグ (PR 中の初回推奨)

`workflow_dispatch` は GitHub 仕様で **default branch (main) にファイルが存在する**
必要があり、workflow 自体を新規追加する PR では UI に表示されません。回避策として、
commit message に `[gen-visual]` タグを付けた push で自動発火します:

```bash
git commit --allow-empty -m "chore: generate visual baselines [gen-visual]"
git push
```

→ GitHub Actions で "E2E Visual Baseline" ジョブが自動起動、PNG を同 branch に
auto-commit する。push に `[gen-visual]` が無い限り発火しないので誤トリガしない。

#### トリガ方法 B: Actions UI 手動実行 (workflow 本体が main にマージ済の場合)

1. GitHub Actions UI → **"E2E Visual Baseline" workflow** を開く
2. "Run workflow" → 対象 branch を選んで実行
3. 完了後、同 branch に `Update visual baselines (workflow)` commit が auto-commit

---

いずれの方法でも、完了後 E2E ワークフローが push をトリガに自動再実行されて green になります。

**⚠️ 「CI を rerun する」だけでは baseline は生成されません**。
baseline workflow の実行 → 自動 commit → (それをトリガに) E2E CI が自動再実行、
という 2 段階の手順が必要です。

baseline を上げずに fail したままマージすると main が red になり続けるので、
**PR マージ前に必ず緑化**してください。

#### ⚠️ 罠: `GITHUB_TOKEN` による auto-commit は次の workflow を起動しない (PR #119 で遭遇)

baseline workflow の auto-commit (`Update visual baselines (workflow)` コミット)
は既定の `GITHUB_TOKEN` で push されるため、**GitHub 仕様により後続 workflow を
トリガしない** (無限ループ防止の仕様。[公式ドキュメント](https://docs.github.com/en/actions/security-guides/automatic-token-authentication#using-the-github_token-in-a-workflow)):

> When you use the repository's GITHUB_TOKEN to perform tasks, events triggered
> by the GITHUB_TOKEN will not create a new workflow run.

**症状**: PR UI の required checks が延々と "Expected — Waiting for status to
be reported" のまま変化しない。`gh run list --commit <auto-commit-SHA>` が空配列を返す。

##### 手動対処手順 (確定版、PR #120 まで毎回必要)

`[gen-visual]` push → baseline workflow が走り auto-commit された **後** に、
開発者の credentials (GITHUB_TOKEN ではない) で空コミットを push して CI を再起動する:

```bash
# 1. baseline workflow の完了を待つ (gh run watch でも可)
gh run list --branch $(git branch --show-current) --limit 5

# 2. baseline auto-commit をローカルに取り込む
git pull --ff-only

# 3. 開発者 credentials で空コミット → push → CI 起動
git commit --allow-empty -m "chore: retrigger CI after baseline update"
git push

# 4. 再起動された CI の状況確認
gh run list --commit $(git rev-parse HEAD) --limit 5
```

**検出方法** (CI が止まっているか判断):

```bash
# 最新コミットに対する workflow run が 0 件なら GITHUB_TOKEN の罠に該当
gh run list --commit $(git rev-parse origin/$(git branch --show-current)) --limit 5
```

空配列 (`[]`) が返ったら手動再起動が必要。1 件以上返れば正常に実行中 or 完了済。

##### 恒久対策: PAT fallback 構文 (PR #121 で実装済み)

PR #121 で `.github/workflows/e2e-visual-baseline.yml` に以下の fallback 構文を採用:

```yaml
token: ${{ secrets.CI_TRIGGER_PAT || secrets.GITHUB_TOKEN }}
```

- `CI_TRIGGER_PAT` が secrets に **登録されていれば** → PAT で push → **後続 CI が自動再起動** (GITHUB_TOKEN の罠回避)
- 未登録なら → 空文字列扱いで `||` により `GITHUB_TOKEN` にフォールバック → 従来動作維持 (手動再起動が必要)

**PAT 登録手順** (ユーザ側で 1 回のみ):

1. GitHub → Settings → Developer settings → **Personal access tokens → Fine-grained tokens → Generate new token**
2. 設定:
   - Repository access: `teppei19980914/BusinessManagementPlatform` のみ
   - Permissions: **Contents: Read and write**
   - Expiration: 最長 1 年 (fine-grained の上限)
3. Repo → Settings → Secrets and variables → Actions → Repository secrets → **`CI_TRIGGER_PAT`** として登録
4. 次回以降の `[gen-visual]` push で自動再起動される

**期限管理**: PAT の expiration 30 日前を目安に再発行 + secret 上書き。失効したら fallback で GITHUB_TOKEN に戻るだけ (壊れない)。

**検討済の他選択肢** (PR #121 時点で不採用):

| 選択肢 | 状態 | 理由 |
|---|---|---|
| **B. workflow_dispatch 連鎖** | 不採用 | workflow_dispatch 起動の check run が PR の required checks に紐付くか実運用検証リスクあり |
| **C. GitHub App** | 将来検討 | 個人非依存だがセットアップ工数大。MVP 段階では PAT で十分 |
| **D. 現状維持** | 不採用 (旧案) | baseline 更新ごとに手動再起動。PR #119 / #120 で 2 回連続発生 |

IDE 警告 `Context access might be invalid: CI_TRIGGER_PAT` は secrets 未登録時に出るが、
fallback 構文で保護されているため **実害なし**。登録すれば警告も消える。

#### mask テクニック (PR #96)

動的に変化するコンテンツ (RUN_ID 付きのテストデータ名等) を視覚回帰対象外にするには
`mask` オプションを使う:

```ts
await expect(page).toHaveScreenshot('projects-light.png', {
  fullPage: true,
  mask: [page.locator('tbody tr')],  // テーブル内容は RUN_ID 依存で毎回変わる
});
```

mask 対象は画像上でグレーに塗りつぶされ、pixel 比較から除外される。構造比較に集中できる。

**ただし mask の限界** (PR #96 hotfix 3 教訓 / LESSONS §4.15): 並列テスト環境で
他 spec のデータが DB に残り行数が変わると mask 領域自体が baseline とズレる。
動的データは mask ではなく **固定値で seed** するほうが確実。

#### 今後の視覚回帰運用 (PR #96 定着後)

視覚回帰はユーザ体感 UI の「見栄え回帰検知」を担うので、以下の運用サイクルで保つ。

**(1) 日常開発 (通常の PR)**

- UI に手を入れない PR → 視覚回帰は既存 baseline と比較、green で通る
- UI に手を入れた PR → 意図通りの変更なら `[gen-visual]` コミットで baseline 再生成
- 意図せぬ崩れ → コード側を修正して CI 緑化

**(2) 判断フロー (PR に視覚回帰 fail が出たとき)**

```
差分 PNG を Artifact でダウンロード → 確認
  ↓
Q1. UI 変更は PR のスコープに含まれているか?
  YES → Q2
  NO  → 回帰バグ (コード側を修正)
  ↓
Q2. 変更は意図通り (仕様を満たす) か?
  YES → [gen-visual] コミットで baseline 更新 + レビュアに PR diff で見せる
  NO  → コード側を修正
```

**(3) baseline 更新時のレビュー観点**

- diff 画像 (Actual / Expected / Diff) の 3 面が Artifact `playwright-report/` に入る
- レビュアは **「変更予告された部分だけが差分か」** を確認
- 予告外の領域に差分が出ていたら **副作用** なので差戻し

**(4) 定期メンテナンス (月 1 程度)**

- 全 baseline が最新の main の UI と一致しているか: CI 定期 run (schedule: daily) で検知
- フォント/レンダリングライブラリの更新は CI image の更新で影響が出うる
- baseline は git に残るので履歴から崩れ始めた時点を特定可能

**(5) 大規模 UI リファクタ時**

- shadcn/ui のバージョンアップや Tailwind 設定変更などで **全テーマの配色が微ズレ** する場合あり
- `[gen-visual]` で一括再生成 → PR diff で全 PNG の差分をレビュアが一通り確認
- 事前に事前共有 (スクショを Slack 等で) しておくとレビュー負担が軽い

### 9.7 E2E テスト失敗の調査手順 (PR #90 運用メモ)

E2E が CI で失敗したとき、**ログの切り抜き画像だけでは原因を特定しにくい**ことが
多々あります (minify されたスタックトレース、同時実行中のテストが出すノイズログ等)。
以下の手順で切り分けると効率的です。

#### 調査で集める情報

1. **失敗テストと成功テストの対比** ← 最も強力な情報
   - 類似シナリオの中で **一部だけ成功している** 場合、ページ自体は動作している
   - 例: PR #90 hotfix 5 のケースでは以下で真因特定できた:
     - test 6「不正メールでログイン失敗」 ✅ PASS (912ms)
     - test 3「ログイン画面が表示される」 ❌ FAIL (5.7s)
     - → 両方 `/login` を使う。test 6 が通る = ページは正常 = 原因は test 3 の
       アサーション側 (`getByRole('heading')` が `<div>` を拾えない)

2. **Playwright HTML レポートの Artifact ダウンロード** ← 画像証拠
   - PR のチェック欄 → Actions タブ → Playwright E2E の失敗 run → Artifacts
   - `playwright-report-<run_id>.zip` をダウンロード
   - 解凍 → `index.html` をブラウザで開く
   - 各テストで:
     - 実際にキャプチャされたスクリーンショット (ページが 500 か、正常レンダリングか)
     - trace viewer (タイムラインでどの操作で stuck したか)
     - video (ブラウザ画面の録画、再現性確認)

3. **テキストベースのログ全量**
   - Actions UI の右上 **歯車 → View raw logs** で生ログ取得 (画像より情報多い)
   - 画像切り抜きでは下部の詳細や前後のコンテキストが欠落しがち

#### 原因切り分けで誤解しやすいログ

| ログ | 意味 | 実際の原因かどうか |
|---|---|---|
| `[auth][error] CredentialsSignin` | next-auth `authorize()` が null を返したときの正常な内部ログ | ❌ 多くの場合ノイズ (意図的にログイン失敗を確認するテストで毎回出る) |
| `"next start" does not work with "output: standalone"` | 警告 | ⚠️ 実害あり (`node .next/standalone/server.js` を使う必要) |
| `Cannot find module ./messages/xxx.json` | next-intl 動的 import の標準トレース漏れ | ✅ 真因 (outputFileTracingIncludes で対応) |
| `Type error: Expected N arguments, but got M` | TypeScript コンパイル失敗 | ✅ 真因 |
| `waiting for getByRole...` タイムアウト | セレクタ不一致 | ✅ アサーション実装か UI 実装どちらかを直す |
| `ReferenceError: exports is not defined in ES module scope` | Playwright の TS ローダが ESM の generated コード (例: Prisma client の `import.meta.url`) を CJS として扱って衝突 | ✅ 真因。E2E fixture から **Prisma client を直接 import しない**。DB 操作は `pg` の生 SQL で書く (PR #92 初回 CI 失敗の事例) |
| `page.goto: net::ERR_ABORTED at http://localhost:3000/<path>` | 直前の navigation (特に 302 リダイレクトチェーン) が完了する前に次の `goto` / 別ナビゲーションが始まり、ブラウザが前者を abort | ✅ 真因。`waitForURL` の正規表現が中間 URL (例: ログイン後の `/` → `redirect('/projects')` 中の `/`) にマッチしていないか確認。対策: URL を glob 完全一致で待つ + `waitForLoadState('networkidle')` を加える (PR #92 hotfix 4、`waitForProjectsReady` ヘルパー参照) |
| `locator.fill: Timeout Nms exceeded. waiting for ...getByLabel(...)` | **`<Label>` に `htmlFor` が無く `<Input>` に `id` が無い** 等で ARIA のラベル-入力リンクが欠落、`getByLabel` が辿れない。または全角/半角括弧の Unicode 不一致 (例: UI が `（確認）` U+FF08/FF09 なのにテストが `(確認)` U+0028/0029) | ✅ 真因 (a11y 欠陥も兼ねる)。**フォーム要素には `<Label htmlFor="x">` + `<Input id="x">` を必ずペアで付ける** (スクリーンリーダ対応と E2E 両立)。括弧は UI と Unicode 完全一致で書く (PR #92 hotfix 5 事例)。|
| `locator.click: Timeout Nms exceeded. waiting for getByRole('button', ...)` が `/login` ページで発生 | **Playwright は既定で test ごとに新しい BrowserContext を作る**ため、前 test のログイン cookie が失われ、次 test で middleware が `/login` にリダイレクトする。該当ボタンは `/login` に存在しないためタイムアウト | ✅ 真因。`test.describe.serial()` だけでは context 共有されない。`beforeAll` で `browser.newContext() + context.newPage()` を作って describe 全体で共有し、各 test 内で `const page = sharedPage;` と明示する。意図的ログアウトは `sharedContext.clearCookies()` (PR #92 hotfix 6 事例)。|
| `toBeVisible() failed` / `element(s) not found` on `getByRole('heading', { name: ... })` | shadcn/ui の `CardTitle` は `<div>` として描画され heading role を持たない。`<h1>`/`<h2>` 以外の「見出し風テキスト」はこのケースに該当 | ✅ 真因。`getByText('...', { exact: true })` に置換する。UI 側で heading 化するのはアクセシビリティ改善だが **別 PR 相当** (shadcn/ui の広範囲変更になる)。PR #90 hotfix 5 / PR #92 hotfix 7 で再発した既知パターン |
| `strict mode violation: getByText(...) resolved to 2 elements` | 同一テキストを含む要素が hydration 過渡や状態バッジ近傍、**一覧テーブルの `<a>` prefetch** で 2 つ以上一致する。片方が `visibility:hidden` でも strict mode は fail する | ✅ locator スコープを具体化する。`<h2>` なら `page.locator('h2').filter({ hasText: X }).first()`、**一覧の行内文言なら `page.locator('tbody tr').filter({ hasText: X }).first()`**。`waitForLoadState('networkidle')` で過渡状態の待機も追加 (PR #93 hotfix 1 / PR #95 hotfix 1 / LESSONS_LEARNED §4.11) |
| WBS 等のツリー UI で子行が `element(s) not found` | 親 WP が collapsed 状態だと子 ACT を **DOM に描画しない** (`{!isCollapsed && children.map(...)}`)。可視/不可視ではなく存在そのものが無い | ✅ 子を検証する前に親の展開トグルをクリックする。展開状態は useSessionStringSet 等で永続化される場合が多いので 1 度展開すれば後続 test でも保持 (PR #96 hotfix / LESSONS §4.13) |
| `getByRole('button', { name: /...title-text.../ })` が見つからない | button に visible text (アイコン文字等) があると accessible name は **text content が優先**、`title` 属性は無視される (ARIA 仕様) | ✅ `aria-label` が無い title-only ボタン (展開トグル等) は **`getByTitle(...)`** を使う。`aria-label` がある場合は `getByRole` で OK (PR #96 hotfix / LESSONS §4.16) |
| `toContainText` が **状態変化の前後どちらでも pass** する | 同じ行内に「確定ボタン」と「確定バッジ」両方に `確定` 文字がある等、**文字が複数要素に重複**する UI では text match で状態判定できない | ✅ `toContainText` ではなく **要素単位の存在/消失** (`toHaveCount(0)` / `toBeVisible`) で状態遷移を判定。消失すべき文字の `not.toContainText` も併用 (PR #96 hotfix / LESSONS §4.17) |
| click 直後の `waitForLoadState('networkidle')` が 0ms で解決、その後のアサーションが reload 前に走って fail | Next.js `router.refresh()` は fire-and-forget。onClick が Promise を await しないため、Playwright の click() が返った時点では fetch/refresh は背景タスクで未 flight | ✅ click **前** に `page.waitForResponse(...)` を Promise として予約 → click 後に await し API 完了を確証。その後 `waitForLoadState('networkidle')` で補助 (PR #96 hotfix / LESSONS §4.18) |
| MFA 検証等「click → API → session update → location.href → middleware → /projects」系 長いチェーンで `waitForURL` が 15s timeout | 並列 CI 下で各段階が数百ms〜数秒かかり合計で timeout 超過。click は event dispatch で即返るため、全チェーンを 1 つの timeout に吸収させると脆弱 | ✅ 最初の API (verify) のレスポンスを click 前に予約 → click 後に await → その後 `waitForURL` で残り部分のみ待機。チェーンを 2 段階に分割 (PR #96 hotfix / LESSONS §4.19) |
| `waitForResponse + waitForLoadState('networkidle')` を組んでも確定/編集系の UI 検証が間欠的に fail | `router.refresh()` の RSC fetch は microtask の更に後 tick で発火することがあり、networkidle を呼んだ瞬間は「まだ発火していない」→ 0ms で即解決して race | ✅ 同一 URL で部分更新する操作 (router.refresh 依存) は `page.reload({ waitUntil: 'networkidle' })` で DB 真状態を強制取得する。ナビゲーション系 click は §4.19 の 2 段階待機で OK (PR #97 hotfix / LESSONS §4.20) |
| `apiRequestContext.post: read ECONNRESET` 等 transient network error | 並列 CI で Next.js サーバ resource 逼迫 / TCP 接続プール枯渇 / Supabase 接続プール伝播等の infra flakiness。139ms 程度の極短時間で fail する点が特徴 | ✅ API ヘルパーに **transient error 限定 retry** (1s × 最大 3 回) を実装。4xx/5xx response は retry せず即 throw (本物のバグを隠蔽しない) (PR #97 hotfix / LESSONS §4.21) |
| 視覚回帰テストで **pixel 差分 98% 等 大規模差** (Diff 画像が全面赤) | テーマ変更等 **Server Component 再取得に依存する動的 state** で、client state (`aria-checked` 等) は即時更新されるが SSR 属性 (`<html data-theme>` 等) は router.refresh 完了後に更新される。screenshot が中間状態 (client 更新済 / SSR 未更新) を captured | ✅ 状態変更 → **page.reload** → SSR 決定属性を assert で確証 → screenshot の順に並べる。client state (`aria-checked` 等) は race するので SSR が書く属性を見る (PR #97 hotfix / LESSONS §4.22) |
| §4.22 を適用したのに `data-theme` 等 SSR 属性が 10s タイムアウトで前の値のまま | `page.reload` が JWT cookie 未更新の状態で走り、`layout.tsx` が古い session からテーマを SSR する。**原因は click → `updateSession()` (POST /api/auth/session) が独立 API であり、PATCH のみを `waitForResponse` していても JWT 更新を待てない** | ✅ click 対象のハンドラが next-auth の `useSession().update()` を呼んでいる場合、`waitForResponse(/api/auth/session POST)` **も click 前に予約して click 後に await** する。SSR が session を読む属性 (data-theme / lang / ロール等) は全て同じ race を抱える (PR #97 hotfix / LESSONS §4.23) |
| MFA verify 後に `waitForURL('**/projects', { timeout: 15_000 })` が timeout し URL が `/login/mfa` から動かない | MfaForm は verify API の後に **独立した `await update({ mfaVerified: true })` (POST /api/auth/session)** を呼んで JWT を再発行し、その後 `window.location.href` で遷移する。verify API だけ `waitForResponse` しても session 更新の時間が 15s budget を食い尽くす | ✅ verify API **と** `/api/auth/session` POST の **両方** を click 前に並行予約し、両方 await してから `waitForURL` に入る。§4.23 と同根の race で、click 後の挙動が「reload」か「別 URL 遷移」かで待ち方が変わるだけ (PR #98 hotfix / LESSONS §4.24) |
| `page.goto` 直後の `getByText` / `getByRole` が strict mode violation (同一 CardTitle 等が 2 要素) | Next.js 16 / React 19 の Suspense streaming 過渡期で、hydration 完了前に一瞬 DOM が二重化して観測される。`page.goto` は "load" までしか待たず hydration 完了は待たない | ✅ `page.waitForLoadState('networkidle')` を assertion 前に挟んで hydration を完了させる。safety net として text locator に `.first()` を付ける。Suspense / loading.tsx / parallel routes を含むページでは全般的に必要 (PR #98 hotfix / LESSONS §4.25) |
| `page.once('dialog', ...)` を使う削除テストが CI で intermittent に `toHaveCount(0)` 10s timeout (networkidle が 1ms で即解決しているログが決定打) | click → confirm 承諾 → fetch DELETE → `router.refresh()` という **dialog 非同期 + fire-and-forget 連鎖** を `waitForLoadState('networkidle')` 単独では待てない。1 ms で idle 判定 → 古い DOM を 10s 観測し続けて fail | ✅ click 前に **`waitForResponse(DELETE)` + `page.once('dialog')`** を予約 → click → DELETE await → **`page.reload({ waitUntil: 'networkidle' })`** で DB 真状態を強制同期 → `toHaveCount(0)` で消失確認、の 5 ステップを全削除テストに横展開する。`page.once('dialog')` が grep でヒットする全 spec で揃える必要あり (PR #106 hotfix / LESSONS §4.26) |
| CI の Playwright build step で `cp: cannot stat 'public': No such file or directory` (exit 1) — `next build` は成功しているのに standalone 組み立てで fail | アセット整理 PR で `public/` 配下のファイルを **全削除** して空ディレクトリになったが、**git は空ディレクトリを tracked しない** ため CI clone 時に `public/` 自体が存在しない。workflow の `cp -r public .next/standalone/` が標的ディレクトリ欠落で fail | ✅ 空になるアセットディレクトリには **`touch <dir>/.gitkeep`** を同時 commit する (本プロジェクトでは `public/.gitkeep`)。代替策として workflow を `[ -d public ] && cp ...` と defensive にする方法もあるが、silent failure の温床になるため本プロジェクトでは採用せず (PR #100 hotfix / LESSONS §4.27) |
| MFA verify API が CI で intermittent に 400 を返す (ローカルでは通る) — `expect(mfaRes.ok()).toBeTruthy()` で Received: false | `otplib.verifySync({ token, secret })` を **`epochTolerance` 未指定** (既定 0) で呼んでおり、TOTP コード生成時刻と検証時刻が同一 30 秒 period 内になければ拒否される。CI 負荷 + Step 累積で period 境界を跨ぐと fail。テスト件数増加 (646 → 671 等) で顕在化する flaky | ✅ サーバ側で `verifyTotp` / `enableMfa` / `verifyInitialTotpSecret` すべてに **`epochTolerance: 30`** (±30 秒許容) を付与。RFC 6238 §5.2 推奨で業界標準。ブルートフォース耐性はロック機構 (5 回失敗で一時、3 回目で恒久) で十分確保 (PR #110 hotfix / LESSONS §4.28) |
| 合成ラベルのボタンが `getByText('ラベル', { exact: true })` で見つからない | `<Button>{label}: {state}</Button>` の形式 (例: MultiSelectFilter) で実テキストは「担当者: 全員」等。label 単独では exact 一致しない | ✅ 正規表現で prefix match する: `page.getByRole('button', { name: /^担当者[::]/ })` (半角/全角コロン両対応) (PR #96 hotfix / LESSONS §4.14) |
| 視覚回帰 mask ありでも `N pixels different` | 並列テスト環境で他 spec のデータが DB に残り行数が baseline 時と不一致。mask 境界は DOM 撮影時に動的決定なので、mask 範囲そのものが baseline とズレる | ✅ 動的データを mask で吸収するのは不確実。代わりに (a) 対象を視覚回帰から外す、(b) 固定値 (日付・名前) でデータ seed、(c) 画面を固定構造要素に絞る のいずれか (PR #96 hotfix / LESSONS §4.15) |
| MFA 有効化後に `強制有効化 (解除不可)` バッジが 10s 待っても出ない | `router.refresh()` + Server Component 再取得のラウンドトリップが並列 CI で延びると expected visible が timeout する。API レスポンス自体は OK でも UI 反映が遅れる | ✅ `page.waitForResponse(r => r.url().includes('/api/auth/mfa/enable'))` で API 完了を明示的に待ち、続いて `waitForLoadState('networkidle')` で再レンダも待機。元ボタン (`MFA を有効化する`) の消失 (`toHaveCount(0)`) も補強アサーションとして加える (PR #93 hotfix 1) |
| Tab アサーション `toHaveAttribute('data-state', 'active')` が timeout、Received `""` | 本プロジェクトは **Base UI** (`@base-ui/react/tabs`) で、Radix UI の `data-state="active"` とは異なる `data-active=""` + `aria-selected="true"` を使う | ✅ ライブラリ非依存の **W3C ARIA 標準** `aria-selected="true"` でアサーションする。`toHaveAttribute('aria-selected', 'true')` (PR #93 hotfix 3 事例)。UI ライブラリを識別するには `src/components/ui/*.tsx` の import 元を確認 |

#### 修正方針の判断ルール

E2E が fail したら、以下のどちらの原因かを見極める:

1. **UI/実装に不具合がある** → ソースコードを修正
2. **アサーションが UI 実装とズレている** → テスト側を実装に合わせる (仕様上許容される範囲で)

判断基準:
- 既存ユーザの体験として不備があるか → あれば実装修正、なければテスト修正
- 例: `<div>` で見出し風に描画しているところに `getByRole('heading')` を当てるのは
  アクセシビリティ観点で改善の余地はあるが、**本 E2E test の責務外** (別タスク化)

### 9.8 E2E で招待メールと MFA を扱う (PR #92)

Steps 1-6 のように、**招待メールのトークン抽出**や **TOTP コード生成**を含むテストを
書く場合は、以下の E2E fixture を使う。

#### 招待メールの捕捉 (inbox provider)

CI 環境では `MAIL_PROVIDER=inbox` で `InboxMailProvider` が起動し、送信内容を
`INBOX_DIR` 配下に 1 通 1 JSON ファイルとして書き出す。Playwright 側はこの
ディレクトリを polling して受信を待つ。

```ts
import { waitForMail, extractSetupPasswordUrl } from '../fixtures/inbox';

const mail = await waitForMail('user@example.com', { after: testStartedAt });
const setupUrl = extractSetupPasswordUrl(mail);
await page.goto(setupUrl);
```

- `after` を渡すと、それ以前のメール (他テストの残骸) を無視できる
- タイムアウト既定 10 秒 / 250ms 間隔 polling
- 本番環境では `MAIL_PROVIDER` を `brevo` / `resend` / `console` にする (inbox は E2E 専用)

#### TOTP コード生成

アプリ本体と同じ `otplib` (`generateSync`) で生成する。**時刻跨ぎのズレを
避けるため、呼び出し直前で生成して即 fill** する。

```ts
import { generateTotpCode } from '../fixtures/totp';
await page.getByLabel('認証コード').fill(generateTotpCode(mfaSecret));
```

MFA シークレットは `/settings` 画面の「手動入力用のシークレットキー」詳細から読み取るか、
初期セットアップフローで setup-password レスポンスの `otpauthUri` から抽出する。

#### 初期 admin シード + クリーンアップ

`e2e/fixtures/db.ts` の `ensureInitialAdmin(email, password)` を `beforeAll` で
呼ぶと、UPSERT で対象 email のユーザ状態を初期化する
(`forcePasswordChange=true` / `mfaEnabled=false` / `isActive=true` /
`failed_login_count=0` 等にリセット)。既存レコードがあっても `user.id` を保持したまま
状態だけ洗い替えるため、users からの RESTRICT な FK (audit_logs 等) に抵触しない。

`e2e/fixtures/run-id.ts` の `withRunId('label')` で実行ごとに一意な文字列が得られる。
ユーザ email / プロジェクト名等に付与し、`afterAll` の `cleanupByRunId()` で
prefix 一括削除するとローカル実行時の残存を防げる (CI は Postgres コンテナ破棄で完全消去)。

#### ⚠️ 重要: Prisma 生成クライアントを E2E から直接 import しない

`src/generated/prisma/client.ts` は `import.meta.url` を使う ESM で、Playwright の
TypeScript ローダ (CJS デフォルト) から直接 import すると:

```
ReferenceError: exports is not defined in ES module scope
at ../src/generated/prisma/client.ts:3
```

で落ちる (PR #92 の初回 CI 失敗事例)。対策:

- **E2E の DB 操作は `pg` の生 SQL で書く** (`e2e/fixtures/db.ts` 参照)
- 列名は `prisma/schema.prisma` の `@map()` 名 (snake_case) を参照
- `@updatedAt` は DB デフォルト無しなので INSERT 時に明示的に `NOW()` を入れる
- Prisma の型情報が必要なら服務ロジック層 (`src/services/`) へ寄せ、E2E からは HTTP API 経由で呼ぶ

#### E2E スペックを書くときの注意点 (PR #92 連続 hotfix で得た知見)

以下は CI 失敗を繰り返して学んだチェックリスト。新しい spec を書くとき / 既存 spec を
書き換えるときは必ず再確認する:

1. **ログイン後は `waitForProjectsReady(page)` ヘルパーを使う** (hotfix 4)
   - `waitForURL(/\/projects|\/$/)` 等の緩い正規表現は 302 中間 URL にマッチして
     `net::ERR_ABORTED` を起こす
   - `**/projects` glob 完全一致 + `networkidle` で待つ

2. **UI 実装の文字コードと完全一致させる** (hotfix 5 / hotfix 7)
   - 全角括弧 `（）` U+FF08/U+FF09 と半角括弧 `()` U+0028/U+0029 は別文字
   - `getByLabel('...(確認)')` と `getByLabel('...（確認）')` は別物
   - rewrite のたびに混入しやすいので、疑わしければ `node` 等で文字コード確認

3. **shadcn/ui の `CardTitle` は `<div>` で描画される** (hotfix 7, 既知 PR #90 hotfix 5 の再発)
   - `getByRole('heading', { name: '...' })` では拾えない
   - `getByText('...', { exact: true })` を使う
   - 対象: `/login` / `/setup-password` / `/login/mfa` 等、Card ベースの画面
   - 真の heading (`<h1>`/`<h2>` 等) は対象外 (例: `/settings` の `<h2>設定</h2>`)

4. **フォーム要素は `<Label htmlFor="x">` + `<Input id="x">` を必ずペアで付ける** (hotfix 5)
   - 欠けていると `getByLabel` が辿れない + スクリーンリーダーも壊れる
   - a11y 改善と E2E 対応が両立する

5. **`test.describe.serial()` だけでは BrowserContext は共有されない** (hotfix 6)
   - 既定で test ごとに新しい context が作られセッション cookie が失われる
   - セッションを引き継ぐ場合は `beforeAll` で `browser.newContext()` + `newPage()`
     を作って describe 全体で共有する
   - 意図的ログアウトは `sharedContext.clearCookies()`

#### pg 生 SQL を使う際のセキュリティ/パフォーマンス規約 (PR #92 hotfix 2)

E2E は CI で隔離実行されるが、`cleanupByRunId` のようにユーザ提供文字列を
`LIKE` パターンに組み込む場合は以下を徹底する:

1. **入力検証**: ユーザ/呼び出し元から渡る値は正規表現で許容文字集合を制限
   (`assertRunIdFormat` の例: `/^[A-Za-z0-9-]{6,64}$/`)。LIKE の wildcard 文字
   (`%` / `_`) やクオート/セミコロンが混入した時点で即 throw。
2. **Prepared statement のみ**: 値連結 (`` `... ${x} ...` ``) は絶対に使わず、
   必ず `$1` / `ANY($1)` プレースホルダ経由で渡す。
3. **並列化**: 相互独立な DELETE (FK 先テーブル群) は `Promise.all` で束ねて
   ラウンドトリップを削減する。
4. **Transaction**: 2 段階削除 (FK 先 → 親) は `BEGIN..COMMIT` でアトミック化し、
   失敗時は `ROLLBACK` + warn ログ (best-effort クリーンアップの一貫性保持)。

これらは CLAUDE.md のコミット前チェック (2. セキュリティ / 3. パフォーマンス) に
該当するため、E2E fixture に生 SQL を追加するたびに再確認する。

---

## 10. コミットとデプロイ

### 10.1 ブランチ運用

- `main` ブランチへの直接コミット禁止
- 機能改修は `feat/...` / `docs/...` / `fix/...` ブランチで作業
- 当日ブランチ `dev/YYYY-MM-DD` は SessionStart hook が自動切替

### 10.2 コミット作成

```bash
git add <changed files>
git commit -m "変更内容を端的に記述"
```

> Stop hook が自動で secret scan / 静的解析 / テストを実行し、テスト成功時のみ
> 自動 commit & push を行う設定もあります (`.claude/.git-automation-config`)。

### 10.3 PR 作成

```bash
gh pr create --title "..." --body "..."
```

PR 本文には以下を含めると後の引き継ぎがスムーズです:
- Summary (変更の目的と概要)
- 変更したファイルと内容
- Test plan (動作確認の手順)
- 関連 PR / 設計書セクション

### 10.4 マージとデプロイ

1. GitHub 上で PR をマージ (手動)
2. **DB スキーマ変更を含む場合**: マージ前に Supabase で migration を手動実行
   (詳細: OPERATION.md §3)
3. Vercel が `main` ブランチを自動デプロイ
4. 本番 URL で動作確認

### 10.5 並行 PR でコンフリクトが出た場合の解消手順 (PR #115 で得た知見)

複数 PR が同時進行中に **同一ファイルを触る** と、先にマージされた PR の内容が
後続 PR ベースに存在せず GitHub UI で "This branch has conflicts" 表示が出る。
本プロジェクトでは daily branch + feature PR 並走運用のため発生しやすい。

#### 典型パターン (PR #115 実例)

- PR #114 (security hardening) がマージされた後、PR #115 (error log 基盤) が
  コンフリクト表示。衝突したファイル:
  1. `src/app/api/cron/cleanup-accounts/route.ts` — PR #114 が修正、PR #115 が削除 (modify/delete conflict)
  2. `src/app/api/projects/[projectId]/tasks/import/route.ts` — 両 PR が同一 catch 句を編集 (content conflict)
  3. `docs/developer/DESIGN.md` — 両 PR が §9.8 配下に新サブ節追加 (隣接挿入で誤検知)

#### 解消手順 (CLI で実施)

```bash
# 1. PR ブランチに戻り、最新 main を取得
git checkout feat/pr-xxx-...
git fetch origin main

# 2. main をマージ (rebase でも可)
git merge origin/main
# → CONFLICT (content) や CONFLICT (modify/delete) が出る

# 3. 各ファイルの解消方針を決める
#    - content conflict (<<<<<< / ====== / >>>>>>): エディタで手動統合
#      → 「先行 PR の意図」と「本 PR の意図」を両方活かす (両方 keep が基本)
#    - modify/delete conflict: ファイル自体の存続を決める
#      → git rm <path> で削除側確定、または戻して修正版を残す

# 4. 解消したら add → commit (merge commit)
git add <解決済ファイル>
git commit -m "Merge main into feat/pr-xxx: 先行 PR #NNN とのコンフリクト解消"

# 5. lint / test / build で回帰確認
pnpm lint && pnpm test --run && pnpm build

# 6. push
git push
```

#### 解消時の判断基準

| 衝突パターン | 判断 |
|---|---|
| 同じバグ修正を両 PR で実装 (意図同じ) | **後続 PR (上位互換) の実装を採用**、先行 PR 実装は削除 |
| 別々の機能追加 (隣接挿入) | **両方 keep**、マーカーだけ除去 |
| 片方が削除、もう片方が修正 | **削除側が意図的なら削除確定** (git rm)、そうでないなら復元 + 修正統合 |
| ドキュメントの表/セクション追加 | **両方 keep**、章番号は時系列順で整理 |

#### 予防策

- PR を小さく保つ (1 PR = 1 コンセプト)
- 長期 PR は定期的に `git merge origin/main` で main 追従
- 同じファイルを複数 PR で触る場合は PR の先後を事前に合意し、後続は先行マージ後に rebase

#### ドキュメント追記箇所の「末尾追記」が多発する罠 (PR #127 で再確認)

**症状**: `DEVELOPER_GUIDE.md` の **更新履歴テーブル末尾** や `RESPONSIVE_AUDIT.md` の
**更新履歴末尾** に複数 PR が同時期に行を追加すると、ほぼ確実にコンフリクトが出る。

例: PR #127 が main (PR #125 まで取り込み済) から分岐した後、PR #126 が main にマージ。
両 PR が `| 2026-04-24 | §xxx 追加 (PR #xxx) |` を **同一行の直後** に追記しており、
マージ時に `<<<<<<< HEAD | ... | ======= | >>>>>>> origin/main` が出る。

**解消**: 両方 keep、時系列順 (PR 番号の若い順) に並べる。今回の衝突は PR #127 末尾行を PR #126 の直下に残すだけで解消。

**予防**:
- 更新履歴は「1 行 1 PR」なので、他 PR と干渉しやすい場所と認識する
- stacked PR が複数ある場合は、上流が main にマージされたら速やかに下流を
  `git merge origin/main` で追従させる
- 長期 stacked PR では「末尾追記 3 行」を見越した rebase コミュニケーションを取る

#### Stacked PR で base に hotfix を当てた場合の sub-PR への伝播 (PR #128 → #129 で得た知見)

**背景**: 要望項目 7 のレスポンシブ対応は stacked PR (`#128` base → `#128a` `/projects`
→ `#128a-2` WBS → `#128b` 横断一覧 → `#128c` admin → `#128d` fine-tune) で進めている。

**症状**: `#128` base に hotfix を 4 回 commit (WebKit エンジン override / main merge /
`testIgnore` / mobile baseline 自動生成) した後、`#128a` (= PR #129) の CI を確認すると
**`#128` 初回と同じ WebKit 起動エラー 5 件** で fail していた。

**原因**: `#128a` branch は `#128` の **初回コミット (0490185)** から分岐しており、
以降に `#128` へ足した 4 件の hotfix を継承していない。stacked PR は後続が
自動追従しないため、base 更新分は各 sub-PR で明示的に取り込む必要がある。

**解消**: `#128a` で `git merge origin/feat/pr128-responsive-audit` 実行。
auto-merge が全ファイル成立 (PR #128a の `/projects` モバイルカード実装は、main 由来
SearchableSelect 追加と同一ファイル `projects-client.tsx` を触るが別範囲のため衝突なし)。

**予防・運用ルール**:
1. stacked PR の **base (上流) に hotfix を commit したら即座に下流全部に merge を流す**。
   上流の CI が green になった時点で sub-PR の CI も再走させるために必要。
2. sub-PR の CI が fail していて、かつ base (上流) の同 workflow も同時期に fail して
   いた場合、**まず上流の fix 伝播漏れを疑う**。下流固有のバグ調査より先に rebase/merge
   を試す方が安い。
3. stacked PR の commit は意図的に 1 本化しておくと、base merge 時の衝突対処が容易
   (#128a の 4870b74 のように 1 コミット/PR に寄せる)。
4. Mobile baseline PNG のような **workflow が自動生成してコミットしたファイル** も
   base に溜まっていく。sub-PR rebase 時に大量の新規 PNG ファイルが一括で降ってくるが
   正常動作 (衝突にならない、単に `new file` として追加される)。

**再発事例 3 例目 (PR #130 = PR #128a-2 hotfix)**: PR #129 への hotfix 取り込み後、
PR #130 (`feat/pr128a-2-wbs-mobile`) も同じ E2E Visual Baseline の WebKit エラーで
fail。PR #130 は PR #129 の **初回コミット 4870b74** から分岐しており、PR #129 が
後から追加した merge commits (`f096b8d` + `fadcdfe`) を引き継いでいなかった。
同じく `git merge origin/feat/pr128a-p1-tables-card` の 1 コマンドで auto-merge 成立
(conflict 0 件、`projects-client.tsx` の WBS 改修 / mobile card / SearchableSelect
3 系統が同一ファイルを触るが別範囲なので衝突せず)。stacked PR 長さが n 段なら
hotfix 伝播もそのぶん n-1 回必要 = 本例では **#128 base → #128a(#129) → #128a-2(#130)**
の 2 段伝播となった。

**再発事例 4 例目 (PR #131 = PR #128b hotfix)**: 3 段目。PR #131
(`feat/pr128b-p2-cross-list`, P2 横断一覧モバイルカード化) は PR #130 の初回
コミットから分岐しており、PR #130 が後で取り込んだ hotfix を継承していなかった。
`git merge origin/feat/pr128a-2-wbs-mobile` で auto-merge 成立。

**再発事例 5 例目 + 6 例目 (PR #132 / #133 hotfix)**: 4 段目 / 5 段目。
同パターンが **5 PR 連続** (#129 → #130 → #131 → #132 → #133) で再発し、
それぞれ `git merge` 1 コマンドで解消。

**運用ルールとして確定 (5 例以上の連続再発が根拠)**:
1. stacked chain を運用する PR では **base ブランチへ hotfix が push されたら
   即座に全 sub-PR へ順送り merge を流す** (下流ほど新しい変更を含むため、
   上流から下流の向きが正しい)。
2. 手動運用は 4 段を超えると伝播忘れが多発するため、**自動化スクリプト**
   (各 sub-PR branch をチェックアウト → `git merge origin/<上流>` → push) を
   整備すべき。現状は手動 + チェックリスト運用。
3. sub-PR を作る際は **初回コミット直前に base の最新 HEAD に rebase しておく**
   ことで以降の伝播回数を最小化できる (本件の PR #128 スタックは全 sub-PR が
   一斉に #128 初期状態 0490185 から分岐していたため伝播コストが連鎖した)。
4. **並走 docs PR の場合、後発 PR は先に main にマージされる予定の PR 内容を
   事前に把握し sub-section header の重複追加を避ける** (本件の PR #136 で
   遭遇 = §10.5 末尾追記罠 4 例目)。具体的には:
   - 後発 PR を作る前に **gh pr list --state open** で並走中の docs 系 PR を確認
   - 同一セクションを触る場合は **後発 PR の本文を「差分のみ」に絞る**
     (header / 既存 sub-section の重複を避け、新規追加分だけを含める)
   - 結果として後発 PR がコンフリクトしても **conflict 解消はゼロ削除のみ**
     (新規追加行の保持) で済むようになる

**補足 (2026-04-24, docs/stacked-pr-propagation-lessons で追加)**:
本セクションは PR #128 stack hotfix 対応で得た知見だが、sub-PR (#129〜#133) が
**squash-merge** されたため、hotfix 伝播で追加した §10.5 の追記内容が main に
取り込まれなかった。一般論として **「sub-PR が squash-merge 運用の場合、sub-PR
のマージ後に追加した docs コミットは別 PR で main へ取り込む必要がある」** と
いうメタ教訓もある (merge commit 運用なら自動継承されるが、squash-merge では
最初の squash 時点のスナップショットしか残らないため)。

### 10.6 `.next` キャッシュがコンフリクト解消後にビルドを壊す (PR #115 hotfix)

Next.js は開発時 `.next/dev/types/validator.ts` にルートハンドラの型情報を
キャッシュする。**ファイル削除を伴うマージ**後にそのまま `pnpm build` すると、
削除済みの `.next/dev/types/validator.ts` が消滅した route (例:
`/api/cron/cleanup-accounts/route.js`) を import しようとして型エラーで
build 失敗する。

**対策**: コンフリクト解消後 (特にエンドポイント削除を含む場合) は必ず
`rm -rf .next` で キャッシュを消してから build する。

### 10.7 日時描画ルール — ハイドレーション不一致の防止 (PR #117 で得た知見)

クライアントコンポーネントで `new Date(x).toLocaleString('ja-JP')` や
`d.getFullYear()` 等の **runtime TZ に依存する API** を使うと、React hydration
mismatch (`#418 Minified hydration failed because the server rendered text
didn't match the client`) が発生する。

**原因**: Next.js の Server Component → Client Component ハイドレーション時、
サーバは UTC (Vercel/Docker 等) でレンダリングし、クライアントは JST で再計算する。
`toLocaleString` / `getHours()` 等は実行環境の TZ を使うため、両者で文字列が
異なり、React が「マウント時の DOM が SSR 出力と一致しない」と判定する。

**ルール**:

- クライアントコンポーネントで日時を描画するときは必ず `src/lib/format.ts` の
  ヘルパを使う:
  - `formatDate(iso)` → `YYYY/MM/DD`
  - `formatDateTime(iso)` → `YYYY-MM-DD HH:MM`
  - `formatDateTimeFull(iso)` → `YYYY/MM/DD HH:MM` (ツールチップ等)
- サーバコンポーネント (`page.tsx` 等) でも、環境差を避けるため同じヘルパを使う
- 禁止 API: `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` /
  `getFullYear()` / `getMonth()` / `getDate()` / `getHours()` / `getMinutes()`
  (いずれも runtime TZ 依存)

**実装の裏側** (PR #118 で i18n 化): ヘルパは `Intl.DateTimeFormat(locale, { timeZone, ... })`
を (locale, tz) の組ごとにキャッシュして使い回す。
サーバ/クライアントが同じ timezone/locale を渡す限りハイドレーション安全。

テストは `src/lib/format.test.ts` / `src/config/i18n.test.ts` で
UTC→JST 変換 / runtime TZ 独立性 / オプション指定 / フォールバック動作を検証。

**チェック**: 新規ファイル追加時は以下で漏れ検査できる:

```bash
rg -n "toLocaleDateString|toLocaleString|toLocaleTimeString|getFullYear\(\)|getMonth\(\)|getDate\(\)|getHours\(\)|getMinutes\(\)" src/
```

### 10.8 タイムゾーン / ロケールの 3 段階フォールバック (PR #118)

**背景**: 日本国内限定から将来的にローカル/オンプレ/クラウド多拠点展開を視野に入れ、
JST ハードコード (PR #117) を設定可能化。

**解決順序** (`src/config/i18n.ts` の `resolveTimezone()` / `resolveLocale()` 実装):

```
ユーザ個別設定 (User.timezone / User.locale)     ← 設定画面で変更 (PR #119 予定)
  ↓ (null / 空文字列なら)
システムデフォルト (src/config/i18n.ts の FALLBACK) ← リポジトリ同梱の既定値 (Asia/Tokyo / ja-JP)
  ↓ (env が設定されていれば上書き)
環境変数 (APP_DEFAULT_TIMEZONE / APP_DEFAULT_LOCALE) ← オンプレ / クラウド環境ごとに指定
```

**使い方** (PR #119 で整備済、通常こちらを使う):

```tsx
// クライアントコンポーネント: useFormatters フック
'use client';
import { useFormatters } from '@/lib/use-formatters';
export function MyClient() {
  const { formatDate, formatDateTime, formatDateTimeFull } = useFormatters();
  return <span>{formatDate(iso)}</span>;
}

// サーバコンポーネント: getServerFormatters 関数
import { getServerFormatters } from '@/lib/server-formatters';
export default async function MyPage() {
  const { formatDateTimeFull } = await getServerFormatters();
  return <td>{formatDateTimeFull(log.createdAt.toISOString())}</td>;
}
```

**低レベル API** (特殊ケース、通常は上記を使う):

```ts
import { formatDate } from '@/lib/format';
// (1) 引数なし = システムデフォルト (login page 等 session が無い場所で使用)
formatDate(iso)
// (2) 明示的 TZ/locale 指定 (テスト・固定表示等)
formatDate(iso, { timeZone: 'UTC', locale: 'ja-JP' })
```

**SSR/CSR 一貫性**: `session.user.timezone` / `session.user.locale` は JWT に格納され、
`<SessionProvider session={session}>` (PR #119 で設定) により第 1 クライアントレンダリングで確定値が参照可能。
サーバとクライアント両方で同じ値を使うためハイドレーション安全。

**DB 格納方針**: DB の `timestamptz` は常に UTC で保存・交換する (Postgres 仕様通り)。
描画時のみ TZ 解決を行う。API 境界も ISO 8601 UTC (`...Z` サフィックス) で統一。

**env 設定例** (オンプレ展開で米国東部を既定にしたい場合):

```bash
# .env.production
APP_DEFAULT_TIMEZONE=America/New_York
APP_DEFAULT_LOCALE=en-US
```

**ロケールを段階的に提供するパターン (PR #120 で導入)**:

メッセージカタログ未整備のロケールを UI に出したいが誤選択を防ぎたい場合、
`src/config/i18n.ts` の `SELECTABLE_LOCALES` マップを使う:

```ts
// UI には出すが選択不可にしたい場合
export const SUPPORTED_LOCALES = { 'ja-JP': '日本語', 'en-US': 'English' } as const;
export const SELECTABLE_LOCALES = {
  'ja-JP': true,   // 選択可
  'en-US': false,  // 表示するが disabled (翻訳未完)
} as const;
```

- UI 層: `<option disabled={!SELECTABLE_LOCALES[key]}>` + 「※準備中」表記
- API 層: `isSelectableLocale(value)` で 400 拒否 (curl 直叩き等の迂回防止)
- format 層: `isSupportedLocale` は true のまま返す (過去に書き込まれた値を壊さない)

翻訳完了 PR で該当キーの `SELECTABLE_LOCALES` を `true` に切り替えると、
カタログ側も紐付いて一斉に有効化される。

### 10.9 設定画面にセクションを追加するときの CI 連鎖 fail パターン (PR #119 で得た知見)

`settings-client.tsx` に新しい Card セクションを追加したり、`src/app/api/settings/*`
配下に route.ts を新設したりする場合、以下の **2 つの CI チェックが同時に fail** する。
両方まとめて対処しないとマージできないので手順化する。

**症状**:
1. `E2E coverage manifest check` — 新規 `route.ts` が `E2E_COVERAGE.md` に未記載
2. 視覚回帰 (`e2e/visual/dashboard-screens.spec.ts` / `settings-themes.spec.ts`) —
   設定画面の高さが変わって baseline PNG と不一致

**対処手順**:

1. `docs/developer/E2E_COVERAGE.md` の「API Routes > その他」セクションに新規 route を追記
   (即 E2E でカバーしないなら `[ ] /api/settings/xxx — skip: <理由>` の形式)
2. `pnpm e2e:coverage-check` をローカル実行して green 確認
3. `[gen-visual]` タグ付き commit を push して baseline を CI で再生成:
   ```bash
   git commit --allow-empty -m "chore: regenerate visual baselines for settings section [gen-visual]"
   git push
   ```
4. "E2E Visual Baseline" workflow 完了後、自動 commit が push され E2E ワークフローが緑化する

**なぜ両方同時に必要か**: `E2E coverage manifest check` が先に fail すると
`Test (vitest + coverage)` が skip → `coverage-summary.json` 不在で
`Report coverage` も連鎖 fail (§9.5.1 の PR #115 知見と同パターン)。
視覚回帰 fail は独立だが、UI 変更を伴う PR では必ず同時に発生する。

---

## 11. 後続対応 (TODO) 一覧 (PR #122 で追加)

> セッション内で暫定合意された未着手・延期項目を失念しないよう、本セクションに集約する。
> 着手時は該当行を削除、完了時は該当 PR 番号を記載して残すこと。

### 11.1 未着手 (優先度: 中)

| # | 項目 | 背景 / 詳細 | 起票元 |
|---|---|---|---|
| T-01 | 入力層の TZ 統合 (date-picker / date-field 系) | PR #118-#119 で描画層は `session.user.timezone` 反映済だが、`date-field-helpers.ts` / `date-field-with-actions.tsx` / `gantt-client.tsx` 等の **入力** では `new Date()` / `.getFullYear()` 等のブラウザ runtime TZ 依存 API を使用中。海外ユーザが 2026-04-24 と入力した際の UTC 変換が TZ 依存になる可能性。date-fns-tz 導入 or 軽量自前変換で解消予定 | PR #118-#119 時点で PR #121 予定 → CI 恒久対策と入れ替わりで未着手 |
| T-02 | PAT 動作確認 (`CI_TRIGGER_PAT`) | PR #121 で導入した PAT fallback が次回の baseline 更新時に正しく動作し、CI 自動再起動が効くか実地確認 | PR #121 マージ時、ユーザ指示「今後の開発で様子を見る」 |

### 11.2 低優先 (長期案件)

| # | 項目 | 背景 / 詳細 | 起票元 |
|---|---|---|---|
| T-10 | UI 文字列の英訳 (en-US 有効化) | 現在 `en-US` は `SELECTABLE_LOCALES=false` で UI disabled (PR #120)。実有効化には `src/i18n/messages/en-US.json` 新設 + 全 .tsx のハードコード日本語抽出 + 翻訳 + `src/i18n/request.ts` を `session.user.locale` 連携 + `SELECTABLE_LOCALES['en-US']` を true 化、の順で実施 | PR #120 時点、ユーザ指示「優先度低、後続対応」 |
| T-11 | 本番 build での `console.*` 自動削除 (SWC `removeConsole`) | `next.config.ts` に `compiler: { removeConsole: { exclude: ['error', 'warn'] } }` 追加で可。現状 ESLint の `no-console` でソース混入は防げているが、本番バンドルでも保険として削除したい | PR #122 時点、SPECIFICATION §25.5 で限界として明示 |
| T-12 | ソースマップ本番非公開の明示宣言 | 現状 Next.js の既定動作で本番ソースマップは生成されないが、`productionBrowserSourceMaps: false` を `next.config.ts` に明示宣言しておくと将来の誤変更防止になる | PR #122 時点 |
| T-13 | `/api/settings/i18n` の E2E 実カバー | PR #119 で `[ ] skip` で manifest 登録済。単体テスト 8 ケースで主要観点はカバー済だが、設定画面からの反映確認は未 E2E | PR #119 時点 |
| T-14 | `system_error_logs` の自動削除バッチ | 1 ヶ月経過ログの退避 or 物理削除を cron で自動化 (OPERATION §13.1 で言及) | PR #122 時点 |
| T-15 | 全見積もり 横断画面 (`/estimates`) | プロジェクト横断で見積を一覧・比較する画面。route 実装後、ナビ「プロジェクト」プルダウンに追加 (SPECIFICATION §20.4) | PR #127 時点 |
| T-16 | 全 WBS 横断画面 (`/wbs`) | プロジェクト横断で WBS (タスク階層) を俯瞰する画面。同上 | PR #127 時点 |

### 11.3 期限付き (管理必須)

| # | 項目 | 期限 | 内容 |
|---|---|---|---|
| T-20 | `CI_TRIGGER_PAT` ローテーション | **2027/04/24 失効** | 期限 30 日前を目安に fine-grained PAT 再発行 (repo: `BusinessManagementPlatform` only, `Contents: Read and write`, 1 年期限) → Repo Settings → Secrets の `CI_TRIGGER_PAT` を上書き。失効しても fallback で GITHUB_TOKEN に戻るだけで壊れないが、baseline auto-commit 後の CI 自動再起動が効かなくなる (§9.6 参照)。PR #121 時点で `/schedule` による自動リマインド Agent 登録は保留 |

### 運用ルール

- 新規発見の TODO は対応 PR を切る前に本セクションへ記入
- 着手 PR で「T-XX 完了 (PR #XXX)」を commit message に含める
- 半期に 1 回、本セクションの棚卸しを行い不要化した項目を削除

---

## 付録 A. 設計原則のリマインダ

- **§21.4 ゼロハードコーディング**: 業務的意味を持つ値は `src/config/` に外出し
- **§21.1 デザイン 3 原則 (そろえる・まとめる・繰り返す)**: 同じ機能は同じ見た目に
- **§21.2 DRY 原則**: 同じドメイン知識を 2 箇所以上に書かない
- **§21.4.4 スコープ外**: レイアウト utility class / 単一コンポーネント内の数値定数 / 純粋な実装詳細は外出し対象外

詳細は `docs/DESIGN.md §21` 参照。

## 付録 B. よくある質問

| 質問 | 回答 |
|---|---|
| 新しい色を JSX で使いたい | 必ず semantic token (`bg-card` / `text-muted-foreground` 等)。Tailwind パレット (`bg-gray-50` 等) は使わない |
| ハードコード値があってもいい場面は? | (1) 単一コンポーネント内のレイアウト数値、(2) テストの期待値、(3) 普遍定数 (1000ms = 1秒等)。詳細は DESIGN.md §21.4.4 |
| エラーメッセージはどこに書く? | API ルート内の固有メッセージは inline で OK。共通化すべきものは `src/i18n/messages/ja.json` の `message.*` |
| 新しいエンティティの追加で迷ったら? | 既存の `Memo` (PR #70 で追加された最新の独立エンティティ) を参考に: schema → service → API → UI → test → docs の順に揃える |

---

## 更新履歴

| 日付 | 内容 |
|---|---|
| 2026-04-21 | 初版作成 (PR #81)。`src/config/` 構造 / テーマ追加手順 / 機能 CRUD 手順 / i18n / テスト / デプロイを集約 |
| 2026-04-24 | §10.7 追加 (PR #117)。日時描画ルール / ハイドレーション不一致防止ガイド |
| 2026-04-24 | §10.8 追加 + §10.7 更新 (PR #118)。TZ/locale の 3 段階フォールバック / env 上書き / format ヘルパのオプション化 |
| 2026-04-24 | §10.8 拡充 (PR #119)。`useFormatters()` / `getServerFormatters()` + 設定画面 UI + `/api/settings/i18n` の整備完了 |
| 2026-04-24 | §10.9 追加 (PR #119 hotfix)。設定画面に Card 追加時の CI 連鎖 fail (coverage manifest + 視覚回帰) 対処手順 |
| 2026-04-24 | §9.6 罠追記 (PR #119 hotfix 2)。GITHUB_TOKEN による auto-commit は次の workflow を起動しない問題と回避手順 |
| 2026-04-24 | §10.8 追記 (PR #120)。`SELECTABLE_LOCALES` による段階的ロケール提供パターン (翻訳未完ロケールを UI に出すが disabled + API 拒否) |
| 2026-04-24 | §9.6 拡充 (PR #120)。GITHUB_TOKEN 罠の手動再起動手順を確定版として明示 + 恒久対策 4 選択肢の比較表 + 推奨案 (PAT) |
| 2026-04-24 | §9.6 恒久対策実装 (PR #121)。`e2e-visual-baseline.yml` に PAT fallback 構文を導入。`CI_TRIGGER_PAT` secret を登録すれば baseline auto-commit 後の CI 再起動が自動化される (登録前は従来通り手動再起動、fallback により壊れない) |
| 2026-04-24 | §11 追加 (PR #122)。後続対応 (TODO) 一覧を集約 (入力層 TZ / PAT 動作確認 / en-US 英訳 / SWC removeConsole / 期限付き PAT ローテーション等) |
| 2026-04-24 | §5.8 追加 (PR #126)。Select と SearchableSelect の使い分け (件数が増える可能性のあるエンティティ系は SearchableSelect、固定少数は既存 Select) |
| 2026-04-24 | §11.2 T-15/T-16 追加 (PR #127)。ナビ 3 分類ハイブリッド化に合わせ、全見積もり / 全 WBS 横断画面の実装時にプロジェクト プルダウンへ追加する TODO を登録 |
| 2026-04-24 | §5.9 追加 (PR #128)。レスポンシブ実装パターン (ResponsiveTable 基盤 + 設計原則 + 段階 PR 計画)。詳細監査は docs/developer/RESPONSIVE_AUDIT.md を参照 |
| 2026-04-24 | §10.5 再発事例追記 (PR #128 hotfix)。DEVELOPER_GUIDE の更新履歴テーブルで origin/main に PR #126/#127 が追加され、PR #128 の追記と末尾コンフリクト。PR 番号順 (#126 → #127 → #128) で結合する形で解消 (§10.5 テンプレ通りのリゾルブで 2 例目) |
| 2026-04-24 | E2E_LESSONS_LEARNED §4.35 / §4.36 新設 (PR #128 hotfix 2 / 3)。§4.35: `devices['iPhone 13']` の defaultBrowserType='webkit' 罠 (chromium-mobile project で override 必須)。§4.36: 並列 project 間の固定 email UPSERT 干渉で spec 01 が mobile で fail → `testIgnore` で chromium 限定実行 |
| 2026-04-24 | §10.5 サブセクション追加 (PR #129 hotfix = PR #128a hotfix)。Stacked PR で base に hotfix を当てた場合の sub-PR への伝播ルール (4 項目)。sub-PR は上流自動追従しないため base が green 化した時点で即 merge を流す必要があり、下流 CI fail は viewport 問題より base 伝播漏れを先に疑うべし |
| 2026-04-24 | §5.10 新設 (fix/project-create-customer-validation)。フォーム送信前の事前バリデーション (エラー情報最小化方針)。HTML5 `required` で拾えない `SearchableSelect` 必須項目は `handleXxx` 先頭で事前 validation + `setError` + `return` し、無効値 POST が 400 を返してブラウザ Console にエラー情報を露出させる経路を断つ |
| 2026-04-24 | §5.10.1 / §5.10.2 追加 (fix/project-create-customer-validation 追補)。§5.10.1: Base UI Combobox で `{value, label}` を items に渡すと onValueChange はオブジェクトで emit される (string 限定の type guard で選択イベントが握り潰されていた)。§5.10.2: タグ入力の全角読点「、」対応 + 共通関数 `@/lib/parse-tags.ts` 集約 (projects / knowledge の重複を解消) |
| 2026-04-24 | §5.10.1.5 追加 (fix/project-create-customer-validation E2E hotfix)。`<Label>` + `<Input>` に htmlFor/id ペアを必ず付ける規約。欠落すると (1) screen reader 読み上げ不可 (2) Playwright `getByLabel` が timeout の 2 つが同時に壊れる (E2E §4.3 の再発事例)。projects-client の全入力フィールドに id を付与 |
| 2026-04-24 | §10.5 末尾追記コンフリクト 3 例目 (PR #135 conflict resolve)。HEAD の §10.5 サブセクション追加行と origin/main の PR #134 系 3 行が更新履歴末尾で衝突 → 時系列 (PR #129 hotfix の docs commit 22:00 → PR #134 の docs commit 22:12-22:40) に従って HEAD 行を先に残し、main 由来 3 行をその直後に並べて解消。§10.5 既知パターン「末尾追記が多発する罠」3 例目として再記録 |
| 2026-04-25 | §10.5 再発事例 3〜6 例目 + 運用ルール 3 項 + メタ教訓 (squash-merge 取りこぼし) を追加 (docs/stacked-pr-propagation-lessons)。sub-PR (#129〜#133) が squash-merge されたため hotfix 伝播で追記した §10.5 内容が main に届かなかった分を本 PR で集約。§10.5 sub-section header 自体は PR #135 経由で先に main へマージ済のため重複を回避し本 PR は **再発事例 3〜6 + 運用ルール + メタ教訓のみ** を追加 |
| 2026-04-25 | §10.5 末尾追記コンフリクト **4 例目** (PR #136 conflict resolve)。HEAD (PR #136 の再発事例 3〜6 + 運用ルール + メタ教訓本文) と origin/main (PR #135 マージ後の §10.5 サブセクション header + PR #135 conflict resolve 行) が末尾衝突。**§10.5 既知パターン 4 例目**。本 conflict 自体が「短期間に末尾追記が連鎖する」パターンの再現で、同パターン 1 PR で 2 回 (PR #135 と PR #136) 発生したため**運用ルール 4 項目「並走 docs PR の場合、後発 PR は先に main にマージされる予定の PR 内容を事前に把握し sub-section header の重複追加を避ける」**を追記 |
