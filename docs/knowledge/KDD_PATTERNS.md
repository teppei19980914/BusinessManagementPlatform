# KDD (Knowledge-Driven Development) ナレッジ集

本ドキュメントは、PR ごとに蓄積された **既存機能の改修パターンと過去の罠** を集約する (DEVELOPER_GUIDE.md §5 全体、約 60 のサブセクション)。時系列順に並んでおり、各エントリは PR との対応を持つ。

索引と概要は [README.md](./README.md) を参照。

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

### 5.11 編集ダイアログの save 後 close 順序とリスト列の表示漏れ (feat/account-lock-and-ui-consistency, item 6/7)

#### 症状

ユーザ報告:
- (1) 編集ダイアログで保存しても自動で閉じず、手動で閉じる必要がある (体感)
- (2) 編集画面で公開範囲 (visibility) を変更し更新したが画面上データが更新されていない

#### 原因

**(1) close 順序問題**:
旧実装の編集ダイアログは PATCH 成功後 `await onSaved()` (= 親の reload) を完了させて
から `onOpenChange(false)` で閉じていた。reload は API 再 fetch + state 更新 + 再描画
を含むため数百 ms のラグが発生し、ユーザには「ダイアログが閉じない」ように見える。

create ダイアログは `setIsCreateOpen(false)` を先に呼んでから reload を裏で走らせる
ため即座に閉じる。**両者の挙動が非対称** だった。

**(2) リスト列の表示漏れ**:
PATCH は成功し DB の visibility は更新されるが、project-level の **risks 一覧** /
**retrospectives 一覧** に visibility 列/バッジが存在しなかったため、ユーザは
「変更が反映されていない」と認識していた。

実際に表示済だったのは:
- ✓ memos-client.tsx (公開範囲列あり)
- ✓ project-knowledge-client.tsx (visibility badge あり)

漏れていたのは:
- ✗ risks-client.tsx (列なし)
- ✗ retrospectives-client.tsx (state 表示はあるが visibility 表示なし、概念混同を誘発)

#### 修正

**(1)**: 4 編集ダイアログ (`risk-edit-dialog.tsx` / `knowledge-edit-dialog.tsx` /
`retrospective-edit-dialog.tsx` / `user-edit-dialog.tsx`) を以下に統一:

```ts
// 旧 (遅い)
await onSaved();
onOpenChange(false);

// 新 (即時 close + 裏で reload)
onOpenChange(false);
void onSaved();
```

`void` 演算子で fire-and-forget を明示。reload 失敗時の通知は親側で必要なら追加する
(現状は router.refresh / lazy-fetch の error state で UI に出る)。

**(2)**: risks-client.tsx に `公開範囲` 列を追加 (Badge)、retrospectives-client.tsx の
state badge 横に「公開: ○○」バッジを追加。

#### 汎化ルール

1. **編集ダイアログの save 後は「close 先 / reload 後」が原則**。await reload してから
   close は UX が破綻する。新規 dialog 実装時は本パターンを踏襲。
2. **編集可能なフィールドはリスト/カードに必ず表示する**。編集だけできて表示できない
   フィールドは「変更が反映されない」誤認を生む。フィールド追加時 (visibility のように
   後から増えた属性) は **編集 UI と表示 UI を必ずペアで実装** する。
3. **横展開の確認スクリプト**: `editXxxDialog` で扱うフィールド一覧と各 list/card 表示
   フィールド一覧の差分を grep で取り、漏れを検出する。今回の漏れは**新規エンティティ
   (visibility) 追加時に list に同期していなかった** ことが原因。

#### 関連

- 「全○○」横断ビューでは draft を除外 (item 5、PR 同梱) — 一覧表示の整合性を保つ
- 並走 item 1 (アカウントロック) とは独立した修正だが、同 PR で UI consistency を
  まとめて改善する

### 5.11.1 User モデルだけは `updatedBy` カラムを持たない設計 (Vercel build 失敗で再発見, PR #138 hotfix)

#### 症状

PR #138 で `lockInactiveUsers` を実装中、`prisma.user.update({ data: { isActive: false, updatedBy: systemTriggerId } })` と他エンティティ流儀で書いたところ Vercel build が以下で失敗:

```
./src/services/user.service.ts:407:34
Type error: Object literal may only specify known properties,
and 'updatedBy' does not exist in type '(...UserUpdateInput...)'.
```

`pnpm lint` は型チェックを行わないため検知できず、Vercel の `next build` (TypeScript チェック含む) で初めて落ちる。

#### 原因

`prisma/schema.prisma` の **User モデルは意図的に `updatedBy` / `createdBy` を持たない**。
他の業務エンティティ (Project / Task / Risk / Knowledge / Retrospective / Estimate / Memo 等) は全て持つが、User は self-referential になるため除外されている (User 自身が created/updated する側であり「ユーザを更新したユーザ」を持つと FK 循環参照リスク + 削除時のカスケード設計が複雑化)。

`user.service.ts` 内の他 `prisma.user.update` 呼び出し (4 箇所) も全て `updatedBy` を渡していない (`data: { isActive }` 等のみ)。**1 箇所だけ流儀外で混入** していた。

#### 修正

`data: { isActive: false, updatedBy: systemTriggerId }` から `updatedBy` を削除。
ロック実行者の追跡は **audit_log の userId フィールド** で行う (元から記録済)。

#### 汎化ルール

1. **User モデルへの update は updatedBy を渡さない**。schema 上に列がない (Prisma 型に存在しない) ため TypeScript が拒否する。
2. **Vercel build = ローカル `pnpm lint` の上位検証**。lint clean でも `next build` の TypeScript チェックで落ちることがある。**コミット前に `pnpm tsc --noEmit` を回す** か、PR 作成後 Vercel ビルドの結果を必ず確認する。
3. **prisma model の差異に依存する操作を書く時は schema を先に確認**。「他のサービスでこう書いてるから同じで OK」の流儀借用は schema 不整合の温床。

#### 関連

- §10.6 `.next` キャッシュ問題: ローカル build で `cleanup-inactive` の参照残存エラーが出る。Vercel はクリーンビルドのため影響なし。ローカルで検証する場合は `rm -rf .next` してから `pnpm build`。

#### 再発事例 2 例目 (PR #138 hotfix のさらに hotfix, 同 PR で 2 連続)

§5.11.1 で「commit 前に `pnpm tsc --noEmit` を回すルール」を追記したにもかかわらず、
直後の hotfix commit (`updatedBy` 削除) でその検証を省略 → `recordAuditLog` の引数名
を `before` / `after` (実際は `beforeValue` / `afterValue`) と取り違えた **別の型エラー** で
GitHub Actions の `Lint / Test / Build` job が再度 fail。

**追加教訓**:

1. **「修正」commit でも tsc --noEmit を必ず回す**。型エラーは 1 commit の中に
   複数潜在することがある (今回は同じ関数内に 2 つ別種の型違反が共存)。
2. **API シグネチャを使う前に必ず型定義を確認**。`recordAuditLog` の引数を記憶ベースで
   書くと historical な引数名 (before/after) と現状のシグネチャ (beforeValue/afterValue)
   がズレる。`Read` でサービスの型定義を見るのが安い。
3. **`pnpm lint` のみでの「OK」報告は不正確**。本ガイドのテンプレ報告で `pnpm lint`
   clean のみを根拠に「検証完了」と書くのを禁止し、必ず `pnpm tsc --noEmit` の結果を
   併記する運用に改める。

### 5.12 DB nullable 列の Zod schema は `.nullable().optional()` 必須 (PR #138 後 hotfix)

#### 症状

リスクの編集ダイアログから公開範囲を draft → public に変更しても保存されず、
ブラウザ Console + UI に以下のエラー:

```
PATCH /api/projects/:pid/risks/:rid 400 (Bad Request)
Invalid input: expected string, received null
```

UI 上もエラー文言が表示され、ユーザは「公開範囲が編集できない」と認識した。
ブラウザ Console への 400 露出は **エラー情報最小化方針** にも違反 (§5.10)。

#### 根本原因

Zod の `.optional()` は **`undefined` のみ受理し `null` は拒否** する。
しかし `risk-edit-dialog.tsx` は値が空のとき以下のように送信:

```ts
body: JSON.stringify({
  ...
  assigneeId: form.assigneeId || null,   // 空欄なら null
  deadline: form.deadline || null,        // 空欄なら null
  ...
})
```

DB 側 `RiskIssue.assigneeId String?` / `deadline DateTime?` は **nullable** であり、
ユーザが担当者や期日を「クリアして空に戻す」のは正当な操作。null を Zod が拒否
した結果、200 で完了するはずの編集が **400 で失敗**していた。

具体的なトリガ条件:
- 元のレコードで該当列が null (例: 担当者未設定の risk)
- 編集ダイアログを開く → form が `assigneeId: ''` で初期化
- 任意のフィールド (visibility 等) を編集 → submit
- body に `assigneeId: null` が含まれて送信 → 400

#### 修正

##### (1) Zod schema: nullable 列に `.nullable().optional()` を必須化

```ts
// NG (旧)
assigneeId: z.string().uuid().optional(),
deadline: z.string().regex(...).optional(),

// OK (新)
assigneeId: z.string().uuid().nullable().optional(),
deadline: z.string().regex(...).nullable().optional(),
```

`.nullable().optional()` で `string | null | undefined` 全てを受理。`.nullish()`
は同等の shorthand (zod v4 で利用可) だが、本プロジェクトは可読性優先で
`.nullable().optional()` を採用。

##### (2) Service 層: `new Date(null)` epoch 化を防ぐ

```ts
// NG: input.deadline === null のとき new Date(null) → 1970-01-01
if (input.deadline !== undefined) data.deadline = new Date(input.deadline);

// OK: null は明示パススルー
if (input.deadline !== undefined)
  data.deadline = input.deadline === null ? null : new Date(input.deadline);
```

##### (3) Service signature: 入力型に `| null` を追加

`Partial<CreateXxxInput> & { result?: string }` のように個別拡張している場合、
`| null` を明示しないと TypeScript が拒否 (CreateXxxInput 側に nullable を反映済の前提)。

#### 横展開済 (本 PR で全 validator 対応済)

| validator | 修正対象フィールド |
|---|---|
| `risk.ts` | cause / likelihood / responsePolicy / responseDetail / **assigneeId** / **deadline** / riskNature / result / lessonLearned |
| `knowledge.ts` | conclusion / recommendation / reusability / devMethod |
| `retrospective.ts` | estimateGapFactors / scheduleGapFactors / qualityIssues / riskResponseEvaluation / knowledgeToShare |
| `project.ts` | outOfScope / notes |
| `estimate.ts` | preconditions / notes |
| `customer.ts` | (元から対応済) department / contactPerson / contactEmail / notes |
| `task.ts` | (元から `updateTaskSchema` / `bulkUpdateTaskSchema` は対応済) |

#### 汎化ルール

1. **Prisma schema の `String?` / `DateTime?` 等 (nullable) に対応する Zod field は
   必ず `.nullable().optional()`** とする。`.optional()` 単独は禁止。
2. **編集 dialog で `value || null` パターンが書ける = nullable な値である** ことの
   宣言。validator 側で受け入れる準備が必須。
3. **service 層で `new Date()` / `parseInt()` 等のパース関数に値を渡すときは
   null を明示的に分岐**。`new Date(null)` は 1970 epoch、`parseInt(null)` は NaN
   といった silent corruption を防ぐ。
4. **schema 追加・変更時は dialog body の payload と突き合わせ**。
   - 検出方法 grep:
     ```bash
     grep -rnE "form\.\w+ \|\| null|: \w+ \|\| null" src/components/dialogs src/app
     ```
   - 各ヒットに対して validator の該当 field が `.nullable()` を含むか確認

#### 関連

- §5.10 (フォーム送信前の事前バリデーション) — 別軸の同種問題 (空文字 → 400)
- §5.11 (編集ダイアログの save→close 順序 + リスト列の表示漏れ) — UI 一貫性
- §5.11.1 (User updatedBy / 型エラー検証ルール) — Vercel build 検知の重要性

### 5.13 過去 Issue / Retrospective の提案ロジックを Knowledge と同等の tag-aware に統一 (fix/suggestion-tag-parity)

#### 症状

「参考」タブ (新規作成後の提案モーダル + プロジェクト詳細「参考」タブ) で、過去
ナレッジには tag-based マッチングが効くが、**過去 Issue / 過去 Retrospective には
tag マッチングが効かず text 類似度のみ**で判定されていた。

`suggestion.service.ts` 内のコメントには「Issue はタグ列を持たないため text スコア
のみで判定する」と意図的な設計として書かれていたが、結果として:

- Issue / Retro の score は **常に textScore × TEXT_WEIGHT** (TAG_WEIGHT 部分は 0)
- 同じテキスト類似度でも Knowledge より低スコアになり、SCORE_THRESHOLD で
  filter されやすい不利な扱い
- ユーザの期待 (「ナレッジ候補と同様に提案される」) を満たしていない

#### 根本原因

DB schema 上 `RiskIssue` と `Retrospective` には独自タグ列が存在しない (Knowledge
だけが `techTags` / `processTags` / `businessDomainTags` を持つ)。一方 **両者とも
`projectId` を持ち、親 Project にはタグ列がある**。本来は親 Project のタグを proxy
として使うのが意味的に妥当 (「同ドメインのプロジェクトで起きた Issue/Retro は別
ドメインのものより関連性が高い」) だが、その実装が抜けていた。

#### 修正

`suggestion.service.ts` で以下を変更:

```ts
// 旧: タグ無視 (常に 0)
const tagScore = 0;

// 新: 親 Project のタグを proxy として使う (Knowledge と同等の tag-aware)
const issueProjectTags = unifyProjectTags({
  businessDomainTags: (i.project?.businessDomainTags as string[]) ?? [],
  techStackTags: (i.project?.techStackTags as string[]) ?? [],
  processTags: (i.project?.processTags as string[]) ?? [],
});
const tagScore = jaccard(ctx.tags, issueProjectTags);
```

Prisma クエリの `select` 句に `project.businessDomainTags` 等を追加。schema 変更
不要、migration 不要。Retrospective も同等の改修。

#### 統一後の動作 (PR #160 で「自プロジェクト除外」列を追加し parity 完成)

| カテゴリ | tagScore 計算 | textScore 計算 | 自プロジェクト除外 |
|---|---|---|---|
| Knowledge | Knowledge 自身の techTags+processTags+businessDomainTags | title + content | ✅ `NOT: { knowledgeProjects: { some: { projectId } } }` (PR #160) |
| Issue | **親 Project の businessDomainTags+techStackTags+processTags** | title + content | ✅ `NOT: { projectId }` (PR #65 〜) |
| Retrospective | **親 Project の businessDomainTags+techStackTags+processTags** | problems + improvements (限定) | ✅ `NOT: { projectId }` (PR #65 Phase 2 (a)) |

Retrospective の text 限定は「避けたい失敗 / 次に活かす学び」の核心部分にフォーカス
する意図的な設計 (本改修対象外、現状維持)。

「自プロジェクト除外」は 3 種すべて DB 側 where 節で行う (in-memory フィルタや UI 側
分岐ではない、§5.20 汎化ルール 1)。**新カテゴリ追加時は本表の 3 列すべてが揃っているか
視覚的に確認** (§5.20 汎化ルール 3 を本表で実装)。

#### 汎化ルール

1. **「○○ A は B と同等」を確認する場合は、スコアリング全要素を表化** して比較する。
   片方の要素 (tagScore など) がゼロ固定だと「同等」を主張できない。
2. **DB に直接列がなくても親エンティティから proxy 取得**できるなら、まず schema 変更
   なしの経路を検討する。本件は Project が tag を持っていたため migration 回避。
3. **新カテゴリを suggestion に追加するときは scoring の対称性をチェック**。「タグなし
   だから text のみ」と短絡せず、proxy 候補の有無を必ず検討する。

#### 回帰防止テスト

`src/services/suggestion.service.test.ts` に 2 ケース追加:

- 「Issue / Retrospective は親 Project のタグで tagScore を計算する」
  - Issue: 親 Project tag 完全一致 → tagScore=1.0、final score > textScore
  - Retro: 親 Project tag 部分一致 (1/3) → tagScore≈0.333
- 「親 Project のタグが空なら Issue / Retrospective の tagScore は 0 (regression: 旧挙動と互換)」

#### 関連

- §5.12 (DB nullable 列の Zod schema) — 別軸の suggestion 関連修正
- DESIGN.md §23 (核心機能 / 提案型サービス)
- `src/lib/similarity.ts` の `jaccard` / `unifyProjectTags` (本改修で再利用)

### 5.14 readOnly な edit dialog から fetch する子コンポーネントは認可漏洩 (403 Console エラー) を起こす (fix/attachment-list-non-member-403)

#### 症状

非メンバーが「全リスク」一覧から行クリックでリスク詳細を開くと、画面上に
「添付の取得に失敗しました」、ブラウザ Console に以下のエラー:

```
api/attachments?entityType=risk&entityId=...&slot=general
Failed to load resource: the server responded with a status of 403 ()
```

§5.10 のエラー情報最小化方針に違反 (Console / Network panel に内部 API の 403 が
公開される)。

#### 根本原因

`risk-edit-dialog.tsx` / `retrospective-edit-dialog.tsx` / `knowledge-edit-dialog.tsx`
は `readOnly` prop を受け取り form 領域は disable できる設計だが、子の
`<AttachmentList>` / `<SingleUrlField>` は **readOnly に関わらず常に mount され、
mount 直後に GET /api/attachments を発火** する。

- /api/attachments の認可は **非 admin の非メンバーは 403** (§22 添付リンク設計)
- 「全リスク」横断ビューは readOnly=true で開かれる: メンバー以外も risk を見られる設計
- 結果: 非メンバーが横断ビュー → リスク詳細 readOnly 開く → 403 → Console エラー

#### 修正

3 dialog 全てで attachment 系子コンポーネントを **`{!readOnly && (...)}` で gating**:

```tsx
// NG: 常に fetch して非メンバーは 403
<AttachmentList entityType="risk" entityId={risk.id} canEdit={!readOnly} ... />

// OK: readOnly なら mount せず fetch も行わない
{!readOnly && (
  <AttachmentList entityType="risk" entityId={risk.id} canEdit ... />
)}
```

これにより:
- メンバー (プロジェクト個別画面、readOnly=false) → 従来通り表示・編集可
- 非メンバー (横断ビュー、readOnly=true) → AttachmentList 非表示、API 呼ばれず 403 ゼロ

#### 横展開チェック

`AttachmentList` / `SingleUrlField` を使う箇所をすべて確認:

| 使用箇所 | readOnly 経路 | 対応 |
|---|---|---|
| risk-edit-dialog | あり (全リスク横断) | ✓ 本 PR で修正 |
| retrospective-edit-dialog | あり (全振り返り横断) | ✓ 本 PR で修正 |
| knowledge-edit-dialog | あり (全ナレッジ横断) | ✓ 本 PR で修正 (SingleUrlField 含む) |
| project-detail-client (概要タブ) | なし (プロジェクト個別) | 対応不要 |
| memos-client | 自分のメモのみ表示 | 対応不要 |

#### 汎化ルール

1. **edit dialog に `readOnly` prop がある場合、子の fetch する component は
   `{!readOnly && ...}` で gating する**。fetch そのものを起こさないことが重要
   (try/catch で握り潰すだけだと Network/Console には 403 が残る)。
2. **「権限不足の場合に 403 を返す API」を画面に常時 mount しない**。コンポーネントが
   `useEffect` / `useCallback` で fetch するパターンは 認可境界の漏洩源になる。
3. **将来「非メンバーも添付を read できる」緩和** が必要なら、`/api/attachments`
   route の `authorize(... 'read')` 分岐に visibility=public 添付の許可を追加する
   (本 PR スコープ外、§22 の認可設計と合わせて再検討)。

#### 関連

- §5.10 (エラー情報最小化方針) — 同じ「Console に余分な 4xx を出さない」観点
- DESIGN.md §22.5 (添付リンク認可設計)

### 5.15 UI 要素の表示条件を緩和したら mobile viewport で overlap して E2E click が intercept される (fix/quick-ux PR #143 hotfix)

#### 症状

PR #143 (PR-A) の E2E が chromium-mobile project で 2 件 fail:

1. `05-teardown Step 11 (admin プロジェクト削除)`: `TimeoutError: locator.click 10s exceeded`
   - Playwright のエラーログに `<span>状態変更</span> from <button data-slot="select-trigger">
     subtree intercepts pointer events`
2. `dashboard-screens visual: プロジェクト詳細 概要タブ`: `toHaveScreenshot mismatch`

#### 根本原因

PR #143 で `canChangeStatus = isActualPmTl || isSystemAdmin` に緩和し、admin にも
状態変更 Select (`w-44 = 176px`) が表示されるようになった。ヘッダ右側の flex
コンテナ:

```tsx
<div className="flex items-center gap-2">    // ← gap-2 / flex-wrap なし
  {canChangeStatus && <Select className="w-44">状態変更</Select>}  // 176px
  {(isActualPmTl || isSystemAdmin) && <Button>編集</Button>}        // ~64px
  {canDeleteProject && <Button>削除</Button>}                       // ~64px
</div>
```

幅合計 ≒ 304px + gap でほぼ 320px。chromium-mobile (390px) viewport では
ヘッダ左側のプロジェクト名/顧客名と並ぶと幅不足で、**flex-wrap がないため要素が
横方向に押し出されて重なり**、Playwright の click が「subtree intercepts pointer
events」で失敗する。

PC (1440px) では幅が十分なため発症せず、admin が状態変更を持たない以前の状態
では Select が表示されないため発症しなかった (PR #143 由来の新パターン)。

#### 修正

```tsx
// 旧
<div className="flex items-center gap-2">
  ...
  <SelectTrigger className="w-44">

// 新
<div className="flex flex-wrap items-center gap-2 justify-end">
  ...
  <SelectTrigger className="w-36 md:w-44">  // mobile 144px / PC 176px
```

- `flex-wrap`: 幅不足時に折り返し → overlap 解消
- `justify-end`: wrap 後も右寄せキープ
- Select 幅 mobile 縮小 (w-44 → w-36): 折り返しの発生頻度を軽減

合わせて `[gen-visual]` で `*-chromium-mobile-linux.png` baseline を新レイアウトで
再生成。

#### 汎化ルール

1. **権限・条件分岐で UI 要素の表示有無を変える PR では、表示が増える側のケースで
   mobile レイアウトを必ず確認する**。要素 1 つの追加でも mobile では総幅オーバー
   で overlap する (visible だが click できない) ケースが発生する。
2. **flex コンテナで複数の操作要素を並べる場合は `flex-wrap` を入れておく**。
   将来の要素追加に対する保険として、見た目の影響なく overlap を予防できる。
3. **`w-NN` (絶対幅) を使う Select / ボタンは `w-NN md:w-MM` で mobile / PC を
   別指定**。`w-44` のような 176px 級の幅は mobile 390px の半分弱を占有するため
   要素が並ばない。
4. **権限緩和系 PR が E2E (chromium-mobile) で fail した場合、最初に疑うのは
   レイアウト overlap**。Playwright のログに「subtree intercepts pointer events」が
   出ていれば即座にこのパターン。viewport 幅に対する要素合計幅を計算する。

#### 関連

- §4.37 (E2E_LESSONS_LEARNED): chromium-mobile project の testIgnore とは別軸の
  「mobile viewport 固有の click 失敗」パターン
- §5.9 (レスポンシブ実装パターン): hidden md:block / md:hidden の DOM 二重化と
  異なり、本件は同一 DOM 内のレイアウト overlap

### 5.16 ダイアログ全画面トグル (90vw × 90vh) — useDialogFullscreen (feat/dialog-fullscreen-toggle)

#### 背景

リスク / 課題 / 振り返り / ナレッジ / メモの 編集・作成 dialog は文字量が多くなる
ケースがあり、既定の `max-w-[min(90vw,36rem)]` (PC で 576px 上限) では狭く感じる
声があった。dialog 上部右側に「全画面」トグルボタンを置き、ON のとき 90vw × 90vh
(どの画面でも 90%) に拡大する設計に統一する。

#### 設計判断

- **state は dialog ごとにローカル**: sessionStorage に永続化しない。開き直すと
  既定 (通常表示) に戻る。複数 dialog (例: メモ画面の create + edit) が同時に
  存在する場合は、それぞれ独立した hook 呼び出しで個別に制御する
- **`!important` (`!`) 修飾子**: shadcn/ui Dialog の base class
  (`sm:max-w-[min(90vw,36rem)]`) を上書きするため `!w-[90vw] !max-w-[90vw]
  !h-[90vh] !max-h-[90vh]` を使う。`max-w` だけでなく `w` も指定しないと幅が
  狭いままになる
- **mobile / PC 区別なし**: 「どの画面でも 90%」という要求仕様を貫く。
  vw/vh 単位なので screen size 自動追従

#### 実装パターン

`@/components/ui/use-dialog-fullscreen.tsx` の hook を呼び出して、返り値の
`fullscreenClassName` を `<DialogContent>` の className に追記、`<FullscreenToggle />`
を `<DialogTitle>` の右隣に並べる。

```tsx
import { useDialogFullscreen } from '@/components/ui/use-dialog-fullscreen';

const { fullscreenClassName, FullscreenToggle } = useDialogFullscreen();

<DialogContent className={`max-w-[min(90vw,36rem)] max-h-[80vh] overflow-y-auto ${fullscreenClassName}`}>
  <DialogHeader>
    <div className="flex items-center justify-between gap-2">
      <DialogTitle>...</DialogTitle>
      <FullscreenToggle />
    </div>
    <DialogDescription>...</DialogDescription>
  </DialogHeader>
  ...
```

#### 同一コンポーネント内で 2 つ以上の dialog がある場合

`memos-client.tsx` のように作成 dialog と編集 dialog を同居させる場合、それぞれ
独立した state が必要なので **destructure rename を使う**:

```tsx
const { fullscreenClassName: createFsClassName, FullscreenToggle: CreateFullscreenToggle }
  = useDialogFullscreen();
const { fullscreenClassName: editFsClassName, FullscreenToggle: EditFullscreenToggle }
  = useDialogFullscreen();
```

JSX タグ名が大文字始まりで component として解釈されるよう、destructure 時の rename
で `XxxFullscreenToggle` (PascalCase) に揃える。lowercase 開始の変数名から dot 記法
で参照する形 (`<createFs.FullscreenToggle />`) は技術的には動くが、destructure rename
の方が読みやすく安全。

#### 適用済 dialog (9 箇所)

- `src/components/dialogs/risk-edit-dialog.tsx` (リスク・課題 編集)
- `src/components/dialogs/retrospective-edit-dialog.tsx` (振り返り 編集)
- `src/components/dialogs/knowledge-edit-dialog.tsx` (ナレッジ 編集)
- `src/app/(dashboard)/memos/memos-client.tsx` (メモ 作成 + 編集 → 2 hook 呼び出し)
- `src/app/(dashboard)/projects/[projectId]/risks/risks-client.tsx` (リスク・課題 起票)
- `src/app/(dashboard)/projects/[projectId]/retrospectives/retrospectives-client.tsx` (振り返り 作成)
- `src/app/(dashboard)/projects/[projectId]/knowledge/project-knowledge-client.tsx` (ナレッジ 作成)
- `src/app/(dashboard)/all-memos/all-memos-client.tsx` (公開メモ 詳細 read-only)

#### 横展開ガイド

新規に文字量が多い編集・作成 dialog を追加する場合、本 hook を使って FullscreenToggle
を組み込むことを推奨する。dialog 上に大きい textarea や複数 textarea を持つ画面が
対象。短いダイアログ (確認ダイアログ等) には不要。

#### 関連

- §5.7 (ダイアログサイズ・スクロール規約): 既定の max-w/max-h は維持し、本機能は
  「ユーザの能動操作で一時的に拡大する」追加レイヤとして共存

### 5.17 複数行テキストの Markdown 入力 + プレビュー + 既存値との差分表示 (feat/markdown-textarea)

#### 背景

リスク / 課題 / 振り返り / ナレッジ / メモ / プロジェクト概要 / ステークホルダー
人物評など、業務情報の多くは複数行のフリーテキスト。Markdown 形式で構造化しつつ
入力したい / 入力中に整形イメージを確認したい / 既存値からの変更点を確認したい
というニーズに応える共通コンポーネントを新設。

#### 提供するもの

- `<MarkdownTextarea>`: 入力欄 (textarea) + プレビューパネル (右) + 差分パネル (下)
  - プレビュー / 差分は既定 OFF、トグルボタンで ON
  - `previousValue` prop を渡せば差分パネルが利用可 (create dialog では undefined にする)
- `<MarkdownDisplay>`: 読み取り専用のテキスト描画。Markdown 構文を含めば
  react-markdown、含まなければ whitespace-pre-wrap でプレーン表示
  - 入力欄を持たない overview / 詳細表示でも一貫した描画を実現
- `@/lib/markdown-utils.ts`: `isMarkdown` / `computeWordDiff` / `extractBeforeChunks` /
  `extractAfterChunks` の純粋関数 (テスト容易性のため React と分離)

#### Markdown 検出ロジック

軽量ヒューリスティックで誤検知より見落としを優先:

```ts
const MARKDOWN_PATTERNS = [
  /^#{1,6}\s+/m,      // 見出し
  /^[*\-+]\s+/m,      // 箇条書き
  /^\d+\.\s+/m,       // 番号付きリスト
  /\*\*[^*]+\*\*/,    // 太字
  /__[^_]+__/,        // 太字 (アンダースコア)
  /(?<!`)`[^`\n]+`(?!`)/, // インラインコード
  /\[[^\]]+\]\([^)]+\)/,  // リンク
  /!\[[^\]]*\]\([^)]+\)/, // 画像
  /^\|.*\|/m,         // テーブル
  /^>\s+/m,           // 引用
  /^[-*_]{3,}\s*$/m,  // 水平線
  /```[\s\S]*?```/,   // コードブロック
];
```

#### セキュリティ

- `react-markdown` は既定で raw HTML を許可しない (XSS 対策)
- GitHub Flavored Markdown (テーブル・取消線・タスクリスト) は `remark-gfm` で対応
- `remark-breaks` で「単一改行 → `<br>`」化 (Markdown 仕様の 2 改行ルールはユーザの直感に反するため緩和)

#### 使い方 (edit dialog)

```tsx
<MarkdownTextarea
  value={form.content}
  onChange={(v) => setForm({ ...form, content: v })}
  previousValue={risk.content}  // 編集前の値、差分パネルで使う
  rows={4}
  maxLength={MEDIUM_TEXT_MAX_LENGTH}
  required
/>
```

#### 使い方 (create dialog)

```tsx
<MarkdownTextarea
  value={form.content}
  onChange={(v) => setForm({ ...form, content: v })}
  // previousValue は渡さない → 差分トグルが非表示になる
  rows={4}
  maxLength={MEDIUM_TEXT_MAX_LENGTH}
  required
/>
```

#### 使い方 (read-only display)

```tsx
<MarkdownDisplay value={memo.content} />
```

#### 適用済 (本 PR)

| 場所 | 種別 | フィールド |
|---|---|---|
| `risk-edit-dialog.tsx` | edit | content |
| `knowledge-edit-dialog.tsx` | edit | background / content / result |
| `retrospective-edit-dialog.tsx` | edit | planSummary / actualSummary / goodPoints / problems / improvements |
| `memos-client.tsx` | edit | content |
| `memos-client.tsx` | create | content |
| `stakeholder-edit-dialog.tsx` | edit + create 兼用 | contactInfo / personality / strategy |
| `risks/risks-client.tsx` | create | content |
| `retrospectives/retrospectives-client.tsx` | create | planSummary / actualSummary / goodPoints / problems / improvements |
| `knowledge/project-knowledge-client.tsx` | create | background / content / result |
| `project-detail-client.tsx` | edit dialog | purpose / background / scope |
| `project-detail-client.tsx` | overview 表示 | purpose / background / scope / outOfScope / notes (display only) |
| `all-memos-client.tsx` | read-only viewer | content (MarkdownDisplay) |

#### 横展開ガイド (今後の textarea 追加時)

新規に複数行テキストの入力欄を追加する場合は **既定で `<MarkdownTextarea>` を使う**。
プレーンテキスト固定にしたい正当な理由がある場合のみ生 `<textarea>` を残す。
読み取り専用ビューでも `<MarkdownDisplay>` を使うと記法が解釈されて整形表示される。

#### スコープ外 (将来 PR 候補)

- ツールバー (太字 / リスト / リンク 等) のボタン UI
- 画像アップロード対応 (現在は外部 URL のみ可)
- 入力中のリアルタイム文字数カウント表示

#### 落とし穴と対策 (PR #154 で発覚した横展開ナレッジ)

##### 1. `prose` クラスは Tailwind Typography プラグイン依存

react-markdown のレンダリング出力に \`className="prose prose-sm dark:prose-invert"\`
を当てるだけでは、**当プロジェクトでは何も効かない**。\`@tailwindcss/typography\`
プラグインが未導入のため、これらのクラスは無効化される (PR #154 でユーザ指摘により発覚)。

**対策**: typography プラグイン追加で依存・ビルドサイズを増やすのではなく、
react-markdown の \`components\` prop で **要素ごとに明示的な Tailwind クラス**
(text-xl font-bold border-b border-border 等) を設定する方針を採用。

```tsx
const MARKDOWN_COMPONENTS = {
  h1: ({ children }) => (
    <h1 className="mt-3 mb-2 text-xl font-bold border-b border-border pb-1">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-3 mb-2 text-lg font-bold border-b border-border pb-0.5">{children}</h2>
  ),
  // h3-h6, ul, ol, li, blockquote, code, pre, a, hr, table, th, td, strong, em
};

<ReactMarkdown components={MARKDOWN_COMPONENTS}>{value}</ReactMarkdown>
```

**横展開の保証**: \`MarkdownDisplay\` / \`MarkdownTextarea\` は全画面で **共通コンポーネント
1 箇所** (`src/components/ui/markdown-textarea.tsx`) を経由するため、ここを更新すれば
全 39 利用箇所 (knowledge / risk / retro / memo / stakeholder / project / all-memos) が
自動的に同じスタイルを得る。並行する \`ReactMarkdown\` 直接呼び出しを書かないこと
(\`grep -rn "react-markdown\\|ReactMarkdown" src/\` で 0 件であることを保つ)。

##### 2. 差分ハイライトは「20% 透過」ではダーク背景で見えない

PR #152 初期実装の \`bg-success/20\` (緑 20% 透過) はダークテーマで視認性不足。
**塗りつぶし + 高コントラスト前景色** に変更する必要があった (PR #154 で修正)。

**対策**: 専用 CSS 変数 (\`--diff-add-bg\` / \`--diff-add-fg\` / \`--diff-remove-bg\` /
\`--diff-remove-fg\`) を **テーマ別に定義** し、テーマトークン経由で配色を切替:

```ts
// theme-definitions.ts
export type ThemeTokens = {
  // ...既存トークン
  diffAddBg: string;
  diffAddFg: string;
  diffRemoveBg: string;
  diffRemoveFg: string;
};

const LIGHT: ThemeTokens = {
  // 追加=緑塗りつぶし白文字、削除=赤塗りつぶし白文字
  diffAddBg: 'oklch(0.55 0.16 150)',
  diffAddFg: 'oklch(0.99 0 0)',
  diffRemoveBg: 'oklch(0.6 0.2 27)',
  diffRemoveFg: 'oklch(0.99 0 0)',
};

// dark テーマでは ユーザ指摘どおり 黄色塗りつぶし黒文字
THEME_DEFINITIONS.dark = extend({
  diffAddBg: 'oklch(0.85 0.18 90)',
  diffAddFg: 'oklch(0.15 0 0)',
  diffRemoveBg: 'oklch(0.7 0.22 27)',
  diffRemoveFg: 'oklch(0.15 0 0)',
});
```

UI 側は Tailwind ユーティリティ \`bg-diff-add-bg text-diff-add-fg\` を使うだけ。
ハードコード色を避けることで全テーマで一貫した「目立つ色」を保証できる。

##### 3. 新トークンを追加したら REQUIRED_TOKENS テストも同時更新が必須

\`theme-definitions.test.ts\` の \`REQUIRED_TOKENS\` リストは「全テーマがこれらを必ず
持つ」ことを実行時に検証する網羅性チェック。新トークンを \`ThemeTokens\` に追加して
\`REQUIRED_TOKENS\` を忘れると **テストは pass する** (`expected` 側に新キーがないため)
が「実行時に存在しないキーが追加された」を検知できなくなる。

**運用ルール**: \`ThemeTokens\` 拡張時は **3 ファイル同時編集**:
1. \`src/config/theme-definitions.ts\` の interface + LIGHT 既定値 + 各テーマ上書き
2. \`src/config/theme-definitions.test.ts\` の \`REQUIRED_TOKENS\` リスト追記
3. \`src/app/globals.css\` の \`@theme\` ブロックに \`--color-xxx: var(--xxx);\` 追加

3 を忘れると Tailwind の \`bg-xxx\` ユーティリティが効かない (CSS が生成されない)。
2 を忘れると新トークンの欠落を実行時テストで検知できない。

#### 関連

- §5.16 (全画面トグル): 入力欄 + プレビューを並べると幅を要するため、全画面トグル
  と組み合わせると UX が向上する
- §5.7 (ダイアログサイズ・スクロール規約): 同様にテーマ非依存の構造規約

### 5.19 横断ビュー (全リスク / 全課題 / 全振り返り / 全ナレッジ) における可視性レイヤの整理 (fix/cross-list-non-member-columns)

#### 背景と仕様確定

「全○○」横断ビューは **visibility='public' のもののみを表示する** 設計 (PR #60)。
そのため、「行が見える」状態 = 「その行は公開されたもの」と等価。

可視性レイヤを以下のように再整理した (2026-04-27 確定):

| 列 / 情報 | 旧仕様 (PR #55) | 新仕様 (本 PR) | 理由 |
|---|---|---|---|
| プロジェクト名 (projectName) | 非メンバーには null | **据置: 非メンバーには null** | 案件名は顧客名類似の機微情報、引き続き機微扱い |
| 担当者氏名 (assigneeName) | 非メンバーには null | **公開** | 行が公開されている以上、誰がアサインされているかは共有価値あり |
| 起票者氏名 (reporterName) | 非メンバーには null | **公開** | 同上 |
| 作成者氏名 (createdByName) | 非メンバーには null | **公開** | 同上 |
| 更新者氏名 (updatedByName) | 非メンバーには null | **公開** | 同上 |
| 添付 (attachment 一覧) | 非メンバーには空配列 | **visibility='public' なら公開** | 添付は entity の付随情報、行が公開なら添付も公開する設計 |
| projectDeleted フラグ | admin のみ | **据置: admin のみ** | 削除状態は管理情報 |

#### 実装変更点

##### service 層 (3 ファイル)

`isMember ? name : null` 三項演算子を **削除** し、氏名を直接公開:

```ts
// 旧
reporterName: isMember ? r.reporter?.name ?? null : null,
assigneeName: isMember ? r.assignee?.name ?? null : null,
createdByName: isMember ? userNameById.get(r.createdBy) ?? null : null,
updatedByName: isMember ? userNameById.get(r.updatedBy) ?? null : null,

// 新
reporterName: r.reporter?.name ?? null,
assigneeName: r.assignee?.name ?? null,
createdByName: userNameById.get(r.createdBy) ?? null,
updatedByName: userNameById.get(r.updatedBy) ?? null,
```

projectName 行の `isMember` gate は据置。

##### attachments batch route

非メンバーでも `visibility='public'` の risk / retrospective に対しては attachment を返す:

```ts
} else if (entityType === 'risk') {
  const all = await prisma.riskIssue.findMany({
    where: { id: { in: entityIds } },
    select: { id: true, projectId: true, visibility: true },
  });
  rows = all
    .filter((x) => x.visibility === 'public' || memberProjectIds.has(x.projectId))
    .map((x) => ({
      id: x.id,
      // 後段の memberProjectIds.has() 判定を通すため、public なものは
      // ダミー projectId に置換し memberProjectIds 集合に同値を追加する
      projectId: x.visibility === 'public' ? '__public__' : x.projectId,
    }));
  memberProjectIds.add('__public__');
}
```

knowledge は既に「`visibility=public` なら non-member でも閲覧可」を実装済 (PR #115)。

#### 回帰防止

##### (A) service 単体テストの仕様明示

`risk.service.test.ts` / `knowledge.service.test.ts` の「非メンバー」ケースを
新仕様に合わせて更新。テスト名にも「2026-04-27 仕様変更」と明記し、将来の
仕様逆戻り (再 mask) を検知可能に:

```ts
it('非 admin & 非メンバーは projectName のみマスク、氏名は公開 (2026-04-27 仕様変更)', async () => {
  // ...
  expect(r[0].projectName).toBe(null); // プロジェクト名は機微情報扱い維持
  expect(r[0].reporterName).toBe('Alice'); // 氏名は公開
  expect(r[0].assigneeName).toBe('Bob');
  expect(r[0].createdByName).toBe('Alice');
  expect(r[0].updatedByName).toBe('Alice');
});
```

##### (B) DEVELOPER_GUIDE による設計方針の明文化

本セクション (§5.19) で「横断ビューでは行が見える = 公開、関連情報も公開」原則を
明文化。将来「氏名を再 mask」の改修 PR が来たら本セクションへの参照で
**仕様意図を確認** できる。

#### 横展開ルール

新規に「全○○ 横断ビュー」を追加する場合の DTO 設計指針:

1. **行表示の前提**: visibility='public' フィルタを WHERE で適用済か確認
2. **氏名系**: 非メンバーにもそのまま公開 (mask しない)
3. **プロジェクト名**: `isMember ? name : null` で機微扱い継続
4. **添付**: parent の visibility='public' を含めて batch route の許可条件に追加
5. **削除状態**: admin のみ可視

#### 関連

- DESIGN.md §22 (添付リンク認可設計) — `visibility='public'` で公開するパターンの基本ルール
- §5.14 (readOnly な edit dialog の認可漏洩) — UI 側で fetch を抑止するパターン
- DEVELOPER_GUIDE §5.10 (エラー情報最小化方針) — 非メンバーに 403 を出さないため UI で gating

### 5.18 WBS 上書きインポート (Sync by ID) 実装パターン (feat/wbs-overwrite-import)

#### 背景

旧テンプレートインポート (`/tasks/import`) は **別プロジェクトへの WBS 雛形流用** 用途で
常に新規 ID で全件 INSERT する。同一プロジェクト内の WBS を「export → Excel 編集 →
re-import」の往復編集サイクルで管理するニーズに応える新フロー。

詳細設計は **DESIGN.md §33** 参照。本セクションは実装上の判断記録。

#### ファイル構成

| 役割 | ファイル |
|---|---|
| Service (ロジック層) | `src/services/task-sync-import.service.ts` |
| 既存 task.service への追加 | `exportWbsTemplate` に `mode='template'\|'sync'` 引数、`recalculateAncestorsPublic` を export |
| Validator (列挙のみ) | `src/lib/validators/task-sync-import.ts` |
| API route (preview + execute) | `src/app/api/projects/[id]/tasks/sync-import/route.ts` |
| API route (export 拡張) | `src/app/api/projects/[id]/tasks/export/route.ts` (`mode='sync'` 受け取り) |
| UI dialog | `src/components/dialogs/wbs-sync-import-dialog.tsx` |
| UI 統合 | `src/app/(dashboard)/projects/[projectId]/tasks/tasks-client.tsx` (ID 表示トグル + 2 ボタン) |

#### 設計上の判断

1. **新サービスファイルへの分離**: 既存 task.service.ts は 1400 行超で密度が高く、CSV
   parse / 3-way diff / rollback を含む 700 行規模の追加は別ファイルが管理性高い。旧
   `parseCsvLine` / `recalculateAncestorsPublic` は task.service から import。

2. **17 列 CSV と 10 列 CSV の共存**: `exportWbsTemplate(projectId, taskIds, mode)` の
   3 引数めで分岐。後方互換のため `mode` 既定は `'template'`。
   API route 側も `body.mode` で判定し権限を切替 (`task:create` vs `task:update`)。

3. **dry-run と本実行の同一エンドポイント**: `?dryRun=1` クエリで分岐。`computeSyncDiff`
   は副作用なしで純粋に diff を返し、`applySyncImport` が内部で **`computeSyncDiff` を
   再呼び出し** して再 validation する (CSV 改竄や DB 状態変動への保険)。

4. **ロールバック方式**: PgBouncer 制約で `prisma.$transaction` 不可のため、
   `applySyncImport` 開始時に該当プロジェクトの全タスクをメモリに snapshot し、
   try/catch でエラー時に `rollbackToSnapshot` を呼ぶ。
   - CREATE 済 → 物理削除
   - UPDATE 済 → snapshot から全列復元
   - DELETE 済 (deletedAt セット) → `deletedAt: null` で undelete

5. **WP↔ACT 切替の禁止**: dry-run 時に blocker として弾く。type 変更は WP の集計や
   ACT の必須項目 (assignee 等) と整合しないため、**手動の削除→新規作成** を促す。

6. **進捗・実績の保全**: CSV 13-17 列は read-only 注記をヘッダーに付与し、import 時は
   無視。DB と異なる値が CSV に書かれていれば warning だけ出す。`progressRate` /
   `actualStartDate` / `actualEndDate` / `status` は触らない。

7. **削除モード 3 段階**: dry-run プレビューで `keep` / `warn` / `delete` をユーザ選択。
   `delete` で進捗を持つタスクが削除候補に含まれる場合は `IMPORT_REMOVE_BLOCKED` で
   拒否し、誤削除を予防。

8. **担当者氏名 lookup**: `ProjectMember` から `user.name` で一意 lookup。氏名重複時は
   blocker (`複数該当` メッセージ)。CSV では UUID ではなく **氏名で運用** (Excel 編集
   時に人間が判断しやすいため)。

9. **ID 表示トグルの永続化なし**: タスク一覧の「IDを表示」ボタンは React state ローカル
   保持 (sessionStorage 等への永続化なし)。普段は使わない列なので。

#### 落とし穴と対策 (横展開ナレッジ)

本 PR で踏み込んだ実装上の罠と、将来同様の課題に直面したときに参照する解決策。

1. **PgBouncer 環境で `prisma.$transaction` が使えない問題への対処**

   Vercel + Supabase pooler (現在の本番構成) では Prisma の `$transaction` が動かない。
   既存の `importWbsTemplate` も逐次 create + エラー時 createdIds 物理削除でロールバック
   している。本 PR の `applySyncImport` はそれを拡張し、CREATE/UPDATE/DELETE 混在の
   失敗時復元に対応した:

   ```ts
   // 1. 開始時に対象プロジェクトの全タスクをメモリに snapshot
   const snapshot = await prisma.task.findMany({ where: { projectId, deletedAt: null } });
   try {
     // 2. CREATE / UPDATE / soft-delete を逐次実行
     // ...
   } catch (e) {
     // 3. 失敗時: createdIds を物理削除、updatedIds を snapshot から全列復元、softDeletedIds を undelete
     await rollbackToSnapshot(snapshot, /* ... */);
     throw e;
   }
   ```

   **適用条件**: PgBouncer 環境かつ「複数テーブル / 複数 CRUD オペレーションに跨る原子性」
   が必要なバルク処理。**注意点**: 大規模プロジェクト (1000+ レコード) では snapshot 保持の
   メモリ圧が問題になり得る。本 PR はそれが現実化する前 (上限 500 件) で対処不要だが、
   1000+ になる将来機能では「分割実行 + 部分ロールバック」を別途検討する必要あり (将来 PR 候補)。

2. **既存 RPC / service 関数に引数を追加するときの後方互換と型安定**

   `exportWbsTemplate(projectId, taskIds?, mode?)` のように既定値付きで第 3 引数を
   足すと、既存呼出側 (route / UI) は変更不要で動き続ける一方、**新規呼出は必ず明示的に**
   `mode` を渡すべき (既定値依存は呼出意図を曖昧にする)。

   実装パターン:
   ```ts
   // service 側
   export type WbsExportMode = 'template' | 'sync';
   export async function exportWbsTemplate(
     projectId: string,
     taskIds?: string[],
     mode: WbsExportMode = 'template',  // 既定値で旧呼出を通す
   ): Promise<string> { ... }

   // 新規呼出側 (本 PR の sync export route)
   const csv = await exportWbsTemplate(projectId, taskIds, 'sync'); // 明示

   // API route で body から取り出すときも narrowing で型安全に
   const mode: WbsExportMode = body?.mode === 'sync' ? 'sync' : 'template';
   ```

   **避けるべきパターン**: `mode: string` のような広い型で受けて service 側で if 分岐
   (= 列挙の網羅性チェックが効かない)。enum 型 + narrowing で渡す。

3. **CSV パースは構文エラーに寛容、validation は後段に集約**

   `parseSyncImportCsv` は列数不足の行を `continue` でスキップ、優先度や種別が想定外なら
   `null` / 既定値にフォールバックする (壊れにくい設計)。一方で **業務ルール検証**
   (ID 不在 / WP↔ACT 切替 / 担当者不在 / 親不在 等) は **`computeSyncDiff` 側に集約** し、
   行ごとの `errors` / `warnings` として返す。

   この分離の利点:
   - parse 段で例外を投げないため、UI 側で「CSV が壊れていて読めません」エラーが出ない
     (ユーザが直したい行ごとの問題が個別表示される)
   - validation はテスト可能な純粋関数になり、Mock prisma で全パターン網羅できる
   - グローバル問題 (ヘッダー不正、500 件超等) は `globalErrors` に集約し、行レベルとは
     別のチャンネルで返す

   **横展開先**: 顧客 CSV 取り込み / 一括ユーザ招待 等、CSV 入力を伴う他機能でも同じ
   構造を取ると UX が一貫する。

#### スコープ外 (将来 PR 候補)

- 列名のヘッダーゆらぎ吸収 (例: 「ID」と「id」の同一視)
- Undo (実行後の取り消し: audit_log の beforeValue から復元する管理機能)
- 進捗系列も書き戻し可能にする上級モード
- 実績工数列の export 値 (現在は空欄)
- 複数プロジェクト跨ぎの一括 sync

#### 関連

- DESIGN.md §33 (WBS 上書きインポート設計)
- SPECIFICATION.md §10 (CSV 列詳細・dry-run UX・エラー分類)

### 5.20 提案リストから「自プロジェクト紐付け済」を **DB 除外** で外す (PR #160 / fix/suggestion-exclude-self-project)

#### 症状

「参考」タブと新規作成後の提案モーダルで、自プロジェクトに既に紐付け済の Knowledge が
ノイズとして並んでいた。当初実装は `findMany` で全公開ナレッジを取得し、結果に
`alreadyLinked: true` フラグを乗せ、UI 側で「紐付け済」バッジに切替える方式。
ただし提案リストの趣旨は「過去の **他プロジェクト** の資産活用」なので、自プロジェクトで
既に手元にあるナレッジを並べる意味がなく、UX 上は単なるノイズになっていた。

過去 Issue (`NOT: { projectId }`) / 過去 Retrospective (`NOT: { projectId }`) は
**他プロジェクトのみ** に絞っていたが、Knowledge だけ parity が崩れていた。

#### 根本原因 (設計判断ミス)

1. **「フラグ運用」を選んでしまった**: 「紐付け済を除外」ではなく「フラグで印付け」を
   選んだことで、UI に `if (alreadyLinked) {...}` 分岐が必要になり、サービス層と UI 層
   の責務が漏れていた。
2. **横展開チェック漏れ**: 同 service 内で Issue/Retro は `NOT: { projectId }` を採用
   していたのに、Knowledge は alreadyLinked 方式という非対称な設計を温存していた。

#### 修正

`prisma.knowledge.findMany` の where 節に DB レベルで除外を追加:

```ts
const knowledges = await prisma.knowledge.findMany({
  where: {
    deletedAt: null,
    visibility: 'public',
    NOT: {
      knowledgeProjects: { some: { projectId } },
    },
  },
  select: { /* ... knowledgeProjects は不要なので削除 ... */ },
});
```

合わせて:
- `KnowledgeSuggestion` 型から `alreadyLinked: boolean` を削除
- `SuggestionsPanel` の `isAdopted = k.alreadyLinked || adopted.has(...)` を
  `isAdopted = adopted.has(...)` に簡略化 (採用直後の表示は引き続き Set で管理)

#### 汎化ルール

1. **提案系の「除外」は DB 側 where 節で行う**: in-memory フィルタや UI 側分岐より
   ① 転送量が減る ② 実装が単純 ③ 同 service の他カテゴリとの parity を保ちやすい。
2. **「フラグ運用 vs 完全除外」の選択基準**:
   - フラグ運用が妥当: そのレコードを **採用済として可視化したい** UX のとき
     (例: ECサイトの「カートに入れた商品」を再表示する)
   - 完全除外が妥当: そのレコードを並べる **意味が無い** UX のとき (今回はこちら)
3. **suggestion 系で新カテゴリを追加するときは parity 表を更新**: §5.13 の表に
   「自プロジェクト除外: ✅ / ❌」列を加え、3 種で揃っているか視覚的に確認する。

#### 回帰防止テスト

`src/services/suggestion.service.test.ts` に 2 ケース追加:

1. `findMany` の where 句スナップショット (`NOT: { knowledgeProjects: { some: { projectId } } }` を含む)
   - これにより「フラグ運用に戻す」regression を即検知する
2. `KnowledgeSuggestion` DTO に `alreadyLinked` プロパティが含まれないこと

#### 関連

- §5.13 (Issue/Retro tag-aware parity) — 同じく「parity 達成」の修正パターン (本 §5.20 で表に「自プロジェクト除外」列を追加して 3 種完備)
- §5.21 (PR #161) — 同じく「DB 側 where で除外」設計指針の応用 (横断ビュー bulk update の filterFingerprint 必須化)
- DESIGN.md §23.2 (除外条件) / SPECIFICATION.md §16.2 — 仕様文言を本実装に追従
- `src/services/suggestion.service.ts` の `suggestForProject` (PR #160 で完成形)

### 5.21 「○○一覧」(project-level) で「フィルター必須」型の一括更新を実装するパターン (PR #161 で誤って cross-list に実装 → PR #165 で project-list に移し替え)

#### 背景・要件

「全リスク / 全課題」のような **複数プロジェクト横断ビュー** に一括更新機能を載せる場合、
特有の危険性として「フィルターをかけずに全件選択 → 全件更新」の事故がある。
ユーザ要望: 「フィルターをかけずに行うと一括選択した時の対象がやけに広くなるので、
危険性を排除するため、必ずフィルターをかけることを必須としてください」。

#### 実装パターン (二重防御)

**(A) UI 側: フィルター適用前は bulk UI 自体を出さない**

```tsx
const filterApplied = isAnyFilterApplied(filter, Boolean(typeFilter));
// フィルター未適用なら checkbox 列もツールバーも描画しない
{filterApplied && <BulkSelectToolbar /* ... */ />}
{filterApplied && <CheckboxColumn /* ... */ />}
```

タブ選択 (例: 「全リスク」/「全課題」) は **暗黙のフィルター** としてカウントする
(ユーザは既にタブを選んだ時点で「種別」で絞り込んでいる)。

**(B) サーバ側: filterFingerprint 必須化で API 直叩きを防ぐ**

```ts
// validator schema (zod)
filterFingerprint: z.object({
  type: z.enum(['risk', 'issue']).optional(),
  state: z.enum([...]).optional(),
  // ...
})

// API ルート
if (!isFilterApplied(parsed.data.filterFingerprint)) {
  return 400 with { error: 'FILTER_REQUIRED' };
}
```

UI のチェックボックス無効化だけでは JS を改変するだけで bypass できる。
**サーバ側でも判定**して二重防御する。

#### 認可: 「reporter 本人のみ」を per-row 判定 + silent skip

横断ビューでは ids[] に他人作成のレコードが混在し得る。単純に
`where: { id: { in: ids } }` で updateMany すると **他人のレコードまで巻き込まれる**。

```ts
// 1 クエリで reporter を取得し、本人分だけに絞る
const targets = await prisma.riskIssue.findMany({
  where: { id: { in: ids }, deletedAt: null },
  select: { id: true, reporterId: true },
});
const ownedIds = targets.filter((t) => t.reporterId === viewerUserId).map((t) => t.id);
await prisma.riskIssue.updateMany({ where: { id: { in: ownedIds } }, data });
return { updatedIds: ownedIds, skippedNotOwned, skippedNotFound };
```

UI 側でも viewerIsCreator=false の行は checkbox 自体を出さないが、
**サーバ側でも per-row 判定** することで「checkbox を JS で出した」攻撃を防ぐ。
admin であっても他人のレコードは更新しない (delete のみ admin 特権、という既存方針と一致)。

#### `viewerIsCreator` を DTO に持たせる

横断ビューの DTO (例: `AllRiskDTO`) に `viewerIsCreator: boolean` を追加し、
list 時の reporter 比較結果を返す。reporterId そのものをクライアントに expose
すると個人特定 ID が漏れるので、boolean 一発で済ませる方が責務分離になる。

#### patch 項目の選定

- **採用**: state / assigneeId / deadline (選択肢/期限。誤更新リスクが低い)
- **不採用**: title / content (自由文を一括置換する UX は壊れやすい)
- **不採用**: visibility (機微情報を一括公開する事故リスク、個別 review が必要)

#### nullable patch 値の扱い (§5.12 と同方針)

```ts
if (patch.deadline !== undefined) {
  // null は明示クリア (担当者を外す/期限を外す)、`new Date(null)` で 1970 epoch 化を防ぐ
  data.deadline = patch.deadline === null ? null : new Date(patch.deadline);
}
```

`undefined` = patch しない / `null` = クリア / 値あり = 設定。

#### 結果返却: silent skip の数を含める

```ts
return { updatedIds, skippedNotOwned, skippedNotFound };
```

UI 側で「N 件更新 (M 件は権限なくスキップ)」のような透明性を出せる。
全件 error にすると 1 件混入で全滅するので silent skip にする。

#### 汎化ルール

1. **横断ビューの bulk は「フィルター必須」を UI + API 両方で強制**: 二重防御。
2. **権限は per-row 判定 + silent skip**: 全 rollback だと 1 件混入で全滅する。
3. **patch 対象は「選択肢/数値/期限」のみ**: 自由文の bulk は単発編集に絞る。
4. **viewerIsCreator のような boolean 派生フィールドを DTO に持たせる**: ID 直接 expose を避け責務を service 層に閉じる。

#### 回帰防止テスト

- `src/lib/validators/risk-bulk.test.ts`: schema 全パス、`isFilterApplied` 全分岐
- `src/services/risk.service.test.ts`: 他人混入 silent skip、null 明示クリア、Date 変換
- `src/app/api/risks/bulk/route.test.ts`: 401/400/200 + FILTER_REQUIRED エラー

#### 関連

- §5.12 (nullable Zod スキーマ) — patch null 受理の基底ルール
- §5.13 (Issue/Retro tag-aware parity) — 横断/集約パターン
- §5.20 (PR #160 / 提案リスト DB 除外) — 同じく「DB 側 where で除外する」設計指針
- §5.22 (PR #162) — 本パターンを Retrospective/Knowledge/Memo に展開した補強版 (visibility 一括更新)
- DESIGN.md §17 (パフォーマンス / N+1 回避) — updateMany 1 クエリ採用の根拠

### 5.22 「○○一覧」 bulk update の **共通 Toolbar** 化 + 3 entity 展開 (PR #162 で誤って cross-list に実装 → PR #165 で project-list / personal-list に移し替え)

#### 背景

PR #161 で Risk/Issue 用に確立した二重防御パターン (UI: filterApplied なら bulk UI 表示 / API: filterFingerprint 必須化 / per-row owner 判定 + silent skip) を、
Retrospective / Knowledge / Memo の 3 つの「全○○一覧」横断ビューにも展開する。

#### entity 別の差分

| entity | DTO の作成者判定フィールド | visibility 値域 | 利用 service 関数 |
|---|---|---|---|
| Retrospective (`AllRetroDTO`) | `viewerIsCreator: boolean` (PR #162 で追加) | `'draft'` / `'public'` | `bulkUpdateRetrospectivesVisibilityFromCrossList` |
| Knowledge (`AllKnowledgeDTO`) | `viewerIsCreator: boolean` (PR #162 で追加) | `'draft'` / `'public'` | `bulkUpdateKnowledgeVisibilityFromCrossList` |
| Memo (`MemoDTO`) | `isMine: boolean` (既存 PR #70) | `'private'` / `'public'` | `bulkUpdateMemosVisibilityFromCrossList` |

Memo だけ visibility 値域が `'private'` / `'public'` で他と非対称。schema を共通化せず entity ごとに enum を切る方針 (`cross-list-bulk-visibility.ts` の 3 schema)。

#### 共通化のポイント

**(A) Toolbar コンポーネント**: `src/components/cross-list-bulk-visibility-toolbar.tsx` に
フィルター UI (キーワード + 自分作成のみ) + bulk 編集ボタン + visibility 切替ダイアログを集約。
3 つのクロスリスト UI から再利用 (DRY)。

**(B) サーバ側 schema**: `src/lib/validators/cross-list-bulk-visibility.ts` に
共通の `filterFingerprintSchema` + `isCrossListFilterApplied()` を定義し、
entity 別の visibility enum で 3 つの schema を export。
PR #161 の `risk-bulk.ts` とほぼ同パターンだが、こちらの fingerprint は
`{ keyword, mineOnly }` のみ (entity 共通最小限)。

**(C) updateMany では relation connect 構文不可**: Knowledge は通常更新で
`updater: { connect: { id } }` 形式を使うが、`updateMany` は scalar field のみ
受理するため bulk では `updatedBy: viewerUserId` で直接セット。Memo は
`updatedBy` 列自体が無い (元から作成者本人のみ更新する設計、admin 特権なし) ため
`updateMany` の data には `visibility` のみ。

**(D) Memo の認可は `userId === viewerUserId`**: Memo は `createdBy` ではなく
`userId` フィールド (個人ノートのため Project と紐付かず、user に直接所属)。
service 関数の per-row 判定を entity ごとに微調整する必要あり。

#### 汎化ルール (PR #161 §5.21 を補強)

5. **共通 Toolbar 抽出**: 3 entity 以上に同パターンを展開する場合、
   `<EntityCrossListBulkXxxToolbar>` のような shared component を作る。
   各 entity の table 側は `selectedIds` / `filter` の state 管理 + checkbox 列 + 行選択 + reload trigger のみを担当する責務分離。
6. **値域の非対称は entity 別 enum で表現**: 共通 schema を 1 つにまとめると
   Memo の `'private'` を Retrospective が誤受理するリスクがある。
   schema は entity ごとに 3 つ用意する方が型安全。
7. **`updateMany` は relation connect 不可**: bulk 経路では `updatedBy` 等 scalar 列を直接セットする。
   relation 構文は単発 update 用と覚えておく。

#### 回帰防止テスト

- `src/lib/validators/cross-list-bulk-visibility.test.ts`: 3 schema の値域 + `isCrossListFilterApplied` 全分岐 (15 ケース)
- 各 service test に bulk 関数の per-row skip / null 等 6 ケース ずつ追加
- 各 API route test (3 個) に FILTER_REQUIRED + 401/400/200 の 4-7 ケースずつ追加

#### 関連

- §5.21 (PR #161) — 元パターン (Risk/Issue 用、state/assignee/deadline)
- DESIGN.md §17 (パフォーマンス / N+1 回避) — `updateMany` 1 クエリ採用の根拠

### 5.23 「全○○ = 参照のみ / ○○一覧 = CRUD」設計ルール違反からの原状回復 (PR #165 / refactor/bulk-update-to-project-list)

#### 背景・症状

PR #161 (Risk/Issue) と PR #162 (Retrospective/Knowledge/Memo) で、**ユーザ要望「全○○一覧で
一括編集できるように」** を文字通り受け取り、cross-list 横断ビュー (`/risks`, `/retrospectives`,
`/knowledge`, `/all-memos`) に bulk UI を追加した。しかしこれは **既存の設計ルール
「全○○ = 参照のみ / ○○一覧 = CRUD」** を破る実装で、ユーザから
「『全○○』ではなく『○○一覧』上でできるように。なぜならば全○○はデータの参照のみ可能としており、
作成/編集/削除は『○○一覧』としているから」とフィードバックを受けた。

#### 原状回復 (PR #165)

| Entity | bulk UI 実装場所 (旧 = PR #161/#162) | bulk UI 実装場所 (新 = PR #165) |
|---|---|---|
| Risk/Issue | `/risks`, `/issues` (cross-list) | `/projects/[id]/risks`, `/projects/[id]/issues` (project-list、`RisksClient`) |
| Retrospective | `/retrospectives` (cross-list) | `/projects/[id]/retrospectives` (project-list、`RetrospectivesClient`) |
| Knowledge | `/knowledge` (cross-list) | project-tab 「ナレッジ一覧」(`ProjectKnowledgeClient`) |
| Memo | `/all-memos` (cross-list) | `/memos` (personal、`MemosClient`) |

API も path を移動:
- `/api/risks/bulk` → `/api/projects/[projectId]/risks/bulk` (`checkProjectPermission('risk:update')` 経由)
- `/api/retrospectives/bulk` → `/api/projects/[projectId]/retrospectives/bulk` (`project:update`)
- `/api/knowledge/bulk` → `/api/projects/[projectId]/knowledge/bulk` (`knowledge:update`)
- `/api/memos/bulk` は personal scope なので path 維持

サービス関数 rename: `bulkUpdateXxxFromCrossList` → `bulkUpdateXxxFromList`、
Risk/Retrospective/Knowledge には projectId を第 1 引数に追加し where に scope を強制
(他プロジェクトの行混入を skippedNotFound 扱いに)。

#### 認可境界の強化 (副次的メリット)

cross-list 版は「認証済ユーザなら誰でも API アクセス可」だったが、project-scoped 化に
より以下の利点が出た:
1. **`checkProjectPermission` 経由になる**: メンバーシップ + ロール (member 以上) の
   2 段検証が API entry でかかる
2. **per-row 検証は維持** (createdBy/reporterId 一致 → silent skip): admin であっても
   他人のレコードは触らない既存方針と整合
3. **404 / 403 の境界が明確**: 別プロジェクトの ID 混入は projectId where で
   skippedNotFound、メンバーでないプロジェクトへの bulk アクセスは API entry で 403

#### 根本原因の総括

PR #161/#162 の段階で **既存の「全○○ = 参照のみ」設計ルールを認識していなかった**
ことが直接原因。原因は以下:

1. **ユーザ要望の文字通り解釈**: 「全○○一覧で一括編集」と言われ、`/risks` / `/retrospectives` 等の
   `/全○○` 画面に追加した。実際は「○○管理 (CRUD) は project-list、全○○ は参照のみ」という
   既存ルールが SPECIFICATION.md / 各クライアントコメントに明記されていた
2. **`/recall` を飛ばした**: 新機能着手前に `/recall <topic>` で既存ナレッジ参照する KDD Step 2 を
   省略していた。「全○○ read-only 方針 (2026-04-24 改修)」が `risks-client.tsx:45-50` の
   コメントにあったが見落とした

#### 汎化ルール (8 項目目として確定)

8. **「○○管理 = ○○一覧 (project-list / personal-list)、全○○ = 参照のみ」設計ルールを厳守**:
   新機能 (CRUD / 一括操作 / 編集) を「○○ ○○ できる」要望で受けた場合、画面を選ぶ前に
   **既存のクライアントコメント (`*-client.tsx` の冒頭) で「全○○」「○○一覧」の責務分担を
   確認** する。要望が「全○○一覧」と表現されていても、設計ルール上は「○○一覧 (project-list)」が
   実装場所であることが多い。
   - 適用例: 一括編集、一括削除、ステータス変更、タグ付け、ファイル操作
   - 例外: read-only な可視化 (フィルター・検索・ソート) は cross-list でも OK

#### 関連

- §5.21 (PR #161 元パターン) / §5.22 (PR #162 共通化) — 本 §5.23 で project-list に修正
- 各 client コメント: `risks-client.tsx` / `retrospectives-client.tsx` / `project-knowledge-client.tsx` / `memos-client.tsx`
- DEVELOPER_GUIDE §10.5 9 例目 (PR #168 で記録済 — 独立並走 PR の機械解消パターン)

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

### 5.24 TabsList のレスポンシブ集約パターン (PR #167 / feat/asset-tab-responsive-mobile)

#### 背景

タブが多い画面 (`/projects/[id]` 詳細ページの 8〜10 タブ) は狭い画面幅で折り返し
表示になり、UX が崩れる。`dashboard-header.tsx` で確立した
**「lg+: フラット表示 / lg-: 分類プルダウン」** pattern を `TabsList` 内にも適用して、
画面幅小では関連タブをプルダウンに集約する仕組み。

#### 実装パターン

```tsx
<TabsList>
  <TabsTrigger value="overview">概要</TabsTrigger>
  <TabsTrigger value="tasks">WBS管理</TabsTrigger>

  {/* PC 表示: 個別 TabsTrigger を hidden lg:inline-flex で出し分け */}
  <TabsTrigger value="risks" className="hidden lg:inline-flex">リスク一覧</TabsTrigger>
  <TabsTrigger value="issues" className="hidden lg:inline-flex">課題一覧</TabsTrigger>
  {/* ...残りの集約対象タブ... */}

  {/* Mobile 表示: Menu.Root プルダウンに集約 (lg:hidden) */}
  <Menu.Root>
    <Menu.Trigger
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-3 py-1 lg:hidden',
        // 配下のいずれかが active なら親も active 表示
        groupValues.includes(activeTab)
          ? 'bg-background font-medium shadow-sm'
          : 'text-muted-foreground',
      )}
    >
      <span>資産</span>
      <ChevronDownIcon className="size-3.5" />
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Positioner sideOffset={4}>
        <Menu.Popup>
          {options.map((opt) => (
            <Menu.Item
              key={opt.value}
              onClick={() => handleTabChange(opt.value)}
              className={cn(
                'block w-full px-4 py-2 text-sm hover:bg-accent',
                activeTab === opt.value ? 'bg-accent font-medium' : 'text-foreground',
              )}
            >
              {opt.label}
            </Menu.Item>
          ))}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>
</TabsList>
```

#### 設計判断

1. **TabsList 自体を 2 系統描画しない**: 「lg+ TabsList / lg- TabsList」のように切替えると
   `Tabs` コンポーネントの state 同期が二重になる。**個別 TabsTrigger を hidden で出し分け +
   Menu を別途追加** で 1 系統に保つ。
2. **Menu.Trigger は TabsTrigger でない**: Menu.Trigger は Tab 親要素ではないため、`value`
   制約 (1 値のみ) を回避できる。配下 N 値のいずれかなら親 active 扱いとする UI ルールで対応。
3. **Menu.Item の onClick で `handleTabChange(value)` を呼ぶ**: TabsContent はそのまま再利用、
   activeTab が変わるだけで描画が切替わる。

#### 汎化ルール

1. **lg ブレークポイント (1024px) を境界に**: `lg:hidden` / `hidden lg:inline-flex` の対称ペア。
   md (768px) で切替えると tablet 縦持ちで両方表示される事故が起きやすい。
2. **集約対象は「機能カテゴリで括れるタブ群」**: 例: 「リスク/課題/振り返り/ナレッジ/参考」=
   資産系。バラバラの機能を集約するとプルダウン名が決められない。
3. **active 判定は `配下 value 配列.includes(activeTab)` で配列管理**:
   ハードコード `'risks' || 'issues' || ...` だと将来追加忘れる。

#### 関連

- `src/components/dashboard-header.tsx` — 元パターン (3 分類プルダウン)
- `src/app/(dashboard)/projects/[projectId]/project-detail-client.tsx` — 本パターン適用先
- DESIGN.md §11 (ナビゲーション)

### 5.25 添付対応 entity の一覧表示横展開チェック (PR #168 / fix/wbs-attachment-display)

#### 背景

新しい entity を追加するときに、添付 (Attachment) の **登録・一覧表示**を対応させる
箇所が複数あり、漏れやすい。本セクションは添付対応 entity の網羅チェックリスト。

#### チェックリスト (新 entity 追加時)

新 entity `foo` で添付を有効化する際、以下 4 箇所すべて対応する:

1. **API 層 `/api/attachments/batch/route.ts`**: `if (entityType === 'foo')` 分岐を追加し、
   メンバーシップ判定 + foo の DB 取得を実装
2. **登録 UI (作成 dialog)**: `<StagedAttachmentsInput>` をフォームに追加 + 作成成功後に
   `persistStagedAttachments({ entityType: 'foo', entityId, items })` を呼ぶ
3. **登録 UI (編集 dialog)**: `<AttachmentList entityType="foo" entityId={...} canEdit={...}/>`
   を追加 (read-only でも `canEdit={false}` で添付閲覧可)
4. **一覧表示**: クライアントコンポーネントで
   `useBatchAttachments('foo', items.map((x) => x.id))` でバッチ取得し、
   各行/カードに `<AttachmentsCell items={attachmentsByEntity[x.id] ?? []} />` を配置

#### 検出方法 (既存 entity の網羅 grep)

```bash
# API 対応 entity を列挙
grep -nE "entityType.*===.*['\"]\w+['\"]" src/app/api/attachments/batch/route.ts

# 各 entity の一覧画面で useBatchAttachments を使っているか確認
for ent in memo project task estimate risk retrospective knowledge; do
  echo "--- $ent ---"
  grep -rn "useBatchAttachments" src/app/ --include='*.tsx' | grep "'$ent'"
done
```

API 対応済だが `useBatchAttachments` 未使用の entity = **一覧表示が欠如している**。

#### PR #168 で発見した欠如箇所

| Entity | 一覧画面 | API | 一覧表示 |
|---|---|---|---|
| **task / WBS** | tasks-client.tsx | ✅ | ❌ → 本 PR で追加 |
| **knowledge (project)** | project-knowledge-client.tsx | ✅ | ❌ → 本 PR で追加 |
| **retrospective (project)** | retrospectives-client.tsx | ✅ | ❌ → 本 PR で追加 |
| estimate | estimates-client.tsx | ✅ | ❌ (UI 経由の登録 UI 自体が無い、§11 T-05 として TODO 化) |

#### 汎化ルール

1. **「API 対応 = UI 対応」ではない**: API は早めに対応されるが UI は entity ごとに後追いに
   なりやすい。API 追加と同時に登録 UI + 一覧表示も追加するのが望ましい
2. **横展開チェックは grep スクリプト化**: 上記検出方法をプロジェクト固有スクリプトに
   する (将来の横展開漏れ防止)
3. **階層構造の entity (例: task) は collectAllIds で全 ID 取得**: 親子関係がある場合
   `useBatchAttachments` に渡す ID は flat な全件 (filteredTasks.map() ではなく
   collectAllIds(filteredTasks))

#### 関連

- `src/components/attachments/use-batch-attachments.ts`
- `src/components/attachments/attachments-cell.tsx`
- `src/components/attachments/staged-attachments-input.tsx`
- `src/app/api/attachments/batch/route.ts` — entity 別の認可分岐
- §11.1 T-05 (estimate UI 追加 TODO)

### 5.26 同一機能を持つ画面間で **共通部品を必ず流用する** 規約 (PR #171 / feat/date-field-clear-rename)

> **section 番号メモ (PR #171 conflict resolve)**: 本セクションは当初 §5.24 として執筆したが、
> PR #167 / PR #168 が先に main にマージされ §5.24 (TabsList) / §5.25 (添付横展開) を取得したため
> §5.26 に繰り上げた。§10.5 9 例目「機械並列型」の典型再発例 (運用ルール 8 適用)。

#### 背景・症状

PR #71/#72 で日付入力の共通部品 `<DateFieldWithActions>` (本体 popover + 「今日」「クリア」
ボタン) を作り、単発編集系 dialog (RiskEditDialog / RetrospectiveEditDialog / project の
plannedStartDate/EndDate / task の predicted/actual 日 等) は全てこれを採用していた。

しかし **risks-client.tsx の bulk edit dialog** だけが `<Input type="date">` (生の HTML5
ネイティブ date input) を使っており、結果として:

- 単発編集では「今日」「クリア」ボタンが使えるのに、bulk 編集では使えない (UX 不整合)
- 「削除」ボタンが「クリア」表記に統一されたとき、bulk edit 側だけが取り残される
  (横展開漏れ — ユーザ指摘)

ユーザフィードバック原文:
> 別画面だが、同じ機能を有する者は同じ部品を流用してください。
> これにより今回のような横展開漏れを徹底的に減らすことができます。

#### 規約 (実装前 / レビュー時に必ず確認)

1. **同一機能 = 同一部品**: 「日付を選ばせる」「ファイルを添付させる」「タグを入力させる」等の
   「機能の意味」が同じであれば、画面が違っても **必ず既存の共通部品を流用** する。
   `<Input type="date">` / 自作の input を散在させない。
2. **既存部品リスト** (2026-04-27 時点 — 新規追加時はここに足す):
   - 日付入力: `<DateFieldWithActions>` (`@/components/ui/date-field-with-actions`)
   - 数値入力: `<NumberInput>` (`@/components/ui/number-input`)
   - Markdown 入力: `<MarkdownTextarea>` (`@/components/ui/markdown-textarea`)
   - 検索可能 Select: `<SearchableSelect>` (`@/components/ui/searchable-select`)
   - 添付管理: `<AttachmentList>` / `<SingleUrlField>` / `<StagedAttachmentsInput>`
3. **新規画面の実装前チェック**: 入力 UI を書く前に必ず `grep -n '@/components/ui/' src/components/dialogs/` で
   既存採用部品を確認する。同じ意味の input を生で書きたくなったら **共通部品を探し直す**。
4. **共通部品の文言変更は 1 箇所で完結**: デフォルト prop の文言を変えれば全画面に伝播する
   (本 PR の「削除」→「クリア」変更は default `clearLabel` 1 行修正で全 dialog 反映)。
   **これは流用が徹底されていれば成立** する自己治癒性であり、生 input が混じっていると
   個別追従が発生して横展開漏れの温床になる。

#### grep による点検

新規 / 改修 PR で日付入力を扱う場合、commit 前に必ず以下を実行する:

```bash
# 生の date input を新たに導入していないか
grep -rn 'type="date"\|type=.date.' src/app src/components

# DateFieldWithActions を採用しているか (リファレンス)
grep -rn 'DateFieldWithActions' src/app src/components
```

`type="date"` がヒットしたら、そのファイルは原則 **`<DateFieldWithActions>` への置換が必須**。
例外 (どうしてもネイティブが必要) は本 §5.26 にケース追記して可視化する。

#### `<DateFieldWithActions>` の使用シーン (現時点の caller 一覧)

PR #171 マージ時点で本部品を採用している画面 (default `clearLabel='クリア'` 経由で文言伝播):

| 画面 / ファイル | 用途 | 備考 |
|---|---|---|
| `src/components/dialogs/risk-edit-dialog.tsx` | リスク/課題の `deadline` (期限) 単発編集 | `clearLabel` default 依存 |
| `src/components/dialogs/retrospective-edit-dialog.tsx` | 振り返りの `conductedDate` (実施日) | `hideClear` (required) |
| `src/app/(dashboard)/projects/projects-client.tsx` | プロジェクト新規作成の `plannedStartDate` / `plannedEndDate` | `required hideClear` |
| `src/app/(dashboard)/projects/[projectId]/project-detail-client.tsx` | プロジェクト編集の予定日 2 項目 | `required hideClear` |
| `src/app/(dashboard)/projects/[projectId]/tasks/tasks-client.tsx` | Activity 作成/編集 + bulk edit (予定/実績日 各 2 項目 × 2 dialog) | bulk edit caller も含む |
| `src/app/(dashboard)/projects/[projectId]/retrospectives/retrospectives-client.tsx` | リスト画面内 dialog | `required hideClear` |
| `src/app/(dashboard)/projects/[projectId]/risks/risks-client.tsx` | bulk edit の `deadline` (PR #171 で追加) | 単発編集と同部品を流用 |

#### 「削除」→「クリア」全画面伝播の仕組み (PR #171 で確立)

```ts
// src/components/ui/date-field-with-actions.tsx
export function DateFieldWithActions({
  // ...
  clearLabel = 'クリア',  // ← この 1 行修正だけで全 caller に伝播
}: Props) { ... }
```

- **caller 側で `clearLabel` を上書きしている箇所はゼロ** (PR #171 で grep 確認済):
  ```bash
  grep -rn "clearLabel=" src/  # → 該当なし (default 依存のみ)
  ```
- **必要なら個別に上書き可能**: `<DateFieldWithActions clearLabel="リセット" />` のように
  prop で override できるが、原則は default に従う (UX 一貫性)
- **これが「自己治癒性」の実例**: 文言変更 1 行で全画面が追従する。逆に bulk edit が
  生 `<Input type="date">` だった頃は、ここが取り残されて横展開漏れを起こした
  (PR #171 で発覚)。

#### 関連

- §5.8 (Select と SearchableSelect の使い分け) — 同類の「画面を跨ぐ部品流用」規約
- §5.10.1.5 (Label/Input htmlFor/id ペア) — 同類の「画面を跨ぐ規約」
- §10.5 9 例目 (本セクションが §5.24 → §5.26 に繰り上がった conflict resolve の経緯)
- `src/components/ui/date-field-with-actions.tsx` — 当該共通部品

### 5.27 機能 deferral パターン: UI のみ削除、DB/API/service は温存 (PR #177 / 項目 10)

#### 背景

「将来再設計予定だが現時点では UI を出したくない機能」を扱うとき、機能を完全削除すると
将来再有効化のコストが大きくなる。一方 UI を温存すると未完成機能が公開される。

PR #177 (項目 10) で振り返りコメント機能を「将来 cross-list 横ぐしに再設計予定」のため
**現時点では UI のみ非表示化、DB/API/service は温存** という選択をした。これは §6 (機能削除)
とは異なる、**deferral (延期)** の専用パターン。

#### パターン適用判断基準

UI 削除のみ (deferral) を選ぶ条件:
1. **将来再有効化が確定的** (TODO に登録済 or §11 に記載)
2. **UI 削除でデータ損失が起きない** (DB / API は触らないため既存データは無傷)
3. **API 直接呼び出しが残っても害がない** (認可は API 側で enforce 済)
4. **再有効化コストが高い** (DB schema 復元 / migration / 認可ロジック復元)

これらが揃わない場合は §6 (完全削除) を採用する。

#### 実施手順

```
1. UI: 該当 JSX block を削除 (将来計画コメントを残す)
2. UI: 関連 state / handler を削除 (commentText, handleComment 等)
3. UI: prop 型から該当フィールドを削除し、caller 側も更新 (canComment 等)
4. import 整理: unused import を削除 (Input, useFormatters 等)
5. **温存**: API endpoint / service / DB schema は触らない
6. **コメント追記**: API endpoint の冒頭に「項目 X で UI 非表示化、API は将来再利用予定」と記載
7. §11 TODO に再有効化タスクを登録
```

#### grep 横展開チェックリスト

UI 削除完了後、以下を実行して残存ゼロを確認:

```bash
grep -rn "<削除した変数/関数名>" src/ --include='*.ts' --include='*.tsx'
# 該当ヒット = JSDoc コメント / API endpoint コメント のみなら OK (UI コードに残存していないこと)
```

JSDoc コメントに残った参照は **削除した文脈に応じて更新** (削除したことを明記、または「将来再利用」と記載)。

#### PR #177 の例

- **削除した UI**: 振り返りコメント (h4 + 一覧 + 入力フォーム) + state (`commentText`) + handler (`handleComment`) + prop (`canComment`)
- **温存**: `POST /api/projects/[id]/retrospectives/[retroId]/comments` + `retro.comments` DTO + DB の `retrospective_comments` テーブル
- **§11 TODO**: T-18 (cross-list 横ぐしコメント + 通知システム) として登録予定

#### 関連

- §6 (機能削除の手順) — 完全削除との対比
- §11.1 T-18 (cross-list comment 再設計の TODO 起点)
- §10.5 (deferral 経緯を追跡可能にする更新履歴管理)

### 5.28 Prisma migration の UPDATE 文を書くときは init migration で列存在を grep する (PR #178 E2E P3018 hotfix)

#### 症状

PR-β (#178) の E2E が以下で失敗:

```
Error: P3018
Migration name: 20260428_project_dev_method_rename_and_contract_type
Database error code: 42703
Database error: ERROR: column "dev_method" does not exist
Position: ... UPDATE "knowledge_projects" SET "dev_method" = 'low_code_no_code' ...
```

#### 根本原因

migration の `UPDATE "knowledge_projects" SET "dev_method" = ...` で **テーブル名を誤認**。

- **誤認した経路**: schema.prisma の line 442 で `Knowledge` モデル (= `knowledges` テーブル) の
  末尾フィールドとして `devMethod String? @map("dev_method")` を見たが、隣に
  `KnowledgeProject` モデル (= `knowledge_projects` テーブル) があるため、
  どちらが `dev_method` を持つのか脳内変換でミスした
- **実体**: `knowledges` テーブルが `dev_method` を持ち、`knowledge_projects` は単なる多対多の
  関連テーブル (id / knowledge_id / project_id のみ)

#### 教訓 (汎化ルール)

**migration の UPDATE / ALTER / DROP 文を書く前に、必ず init migration の `CREATE TABLE`
で対象列の存在を確認**する。schema.prisma の model 名から table 名を脳内変換するのは
事故の元 (本件: KnowledgeProject ≠ Knowledge、ProjectMember ≠ Project 等)。

#### 確認手順 (commit 前のセルフチェック)

```bash
# 例: knowledge_projects テーブルに dev_method 列があるか確認
grep -B 2 -A 15 'CREATE TABLE "knowledge_projects"' prisma/migrations/*/migration.sql

# CREATE TABLE のスニペットを見て対象列が無ければ migration の table 名が間違っている可能性
```

別の確実な方法 (推奨): **本番に近いローカル DB で `pnpm prisma migrate dev` を一度走らせる**。
Prisma が dry-run 段階で SQL を実行するため、column 不在エラーは即座に検出できる。
CI を待ってから直すと iteration が遅い。

#### grep 横展開チェック (本件の同パターン残存確認)

```bash
# init migration で関連 (多対多) テーブルとそうでないテーブルを区別:
grep -E "^CREATE TABLE \"\w+_\w+s?\"" prisma/migrations/20260415060313_init/migration.sql

# 関連テーブル候補: knowledge_projects / project_members / task_knowledges / ...
# これらは scalar カラムを持たないことが多いので、UPDATE の対象にしない原則
```

#### 関連

- prisma/migrations/20260428_project_dev_method_rename_and_contract_type/migration.sql — 本件 hotfix
- §5.11.1 (User schema 借用ミス) — schema.prisma の脳内変換ミス系の類似事例
- §11 T-21 (完了 / 2026-04-28 — 本教訓を活用して migration `20260428_user_temporary_lock_count` を作成、ALTER TABLE 単純 1 行で table 名取り違えなし)

### 5.29 PR-η: 永続ロック未実装バグの発見 (項目 16 調査結果)

#### 検証対象 (ユーザ要望、項目 16)

> アカウントの管理画面上に表示されるログインロック情報セクションの数字は正しく集計されるのか検証してください。

#### 検証結果

| 項目 | 実装 | 詳細 |
|---|---|---|
| `failedLoginCount` インクリメント | ✅ | `src/lib/auth.ts:52` |
| `lockedUntil` 一時ロック (5 回失敗で 30 分) | ✅ | `src/lib/auth.ts:58` |
| `lockedUntil` ログイン成功時リセット | ✅ | `src/lib/auth.ts:76` |
| **`permanentLock` 永続ロック設定** | ❌ **未実装 (バグ)** | grep でも `permanentLock: true` を設定する箇所が無い |
| MFA 系 (PR #116) | ✅ | 別系統で正常動作 |

#### 不整合の具体内容

- `users-client.tsx:216` のコメント「failedLoginCount 5 回で一時ロック (30 分) / 3 回目で permanentLock」
  の **後半が実装伴わず**
- 結果: 一時ロック → 解除 → 再失敗 → また一時ロック の無限ループ。永続化されない
- `user-edit-dialog.tsx:186` の「永続ロック: あり/なし」UI は **常に なし** を表示

#### 修正方針 (T-21 として §11 登録、選択肢 A 推奨)

1. schema に `temporaryLockCount` (Int, default 0) を追加
2. 一時ロック発生時にインクリメント
3. `>= 3` で `permanentLock = true` をセット

選択肢 B (auth_event_logs から動的集計) は認証パスのオーバヘッドが増えるため非推奨。

#### grep による発見手順 (汎化)

「実装が伴わない可能性のあるコメント」を見つけるための grep:

```bash
# UI コードのコメントで言及されているフラグが実際に true 化されている箇所を確認
grep -rnE "permanentLock\s*[:=]\s*true|permanentLock:\s*true" src/ --include='*.ts' --include='*.tsx' | grep -v ".test."
# ヒットが select clause (読み取り) のみで write 経路が無ければバグ
```

これは「コメントと実装の同期確認」の標準パターンとして §5.x で運用ルール化候補。

#### 関連

- §11 T-21 (永続ロック実装) — 本調査結果の修正タスク
- DESIGN.md §8 (権限制御) — 仕様文書の更新も必要 (実装と乖離している)
- src/lib/auth.ts:52-66 — 現在の一時ロック実装 (改修対象)

### 5.30 master-data.ts の enum 値を変更するときの横展開チェックリスト (PR-β hotfix で確立)

#### 背景

`src/config/master-data.ts` は業務概念の列挙値の単一源泉として運用されているが、
**Zod validator (src/lib/validators/) は別ファイル群** に enum を別途定義している。
`master-data.ts` の値を変更したとき validator 側の更新を忘れると、
**DB は新値、UI は新値、API request validator は旧値** という不整合が発生し、
ユーザ操作が 400 エラーで弾かれる。

#### 実例 (PR-β hotfix, 2026-04-28)

PR-β で `DEV_METHODS` の `'power_platform'` → `'low_code_no_code'` リネームを実施したとき:

| 場所 | 更新済? | 状態 |
|---|---|---|
| `src/config/master-data.ts` (DEV_METHODS) | ✅ | 4 値新仕様 |
| Prisma migration (UPDATE 既存データ) | ✅ | 'low_code_no_code' に変換 |
| `src/lib/validators/project.ts` (createProjectSchema) | ✅ | 新値 enum |
| `src/lib/validators/estimate.ts` (createEstimateSchema) | ❌ **漏れ** | 旧値 'power_platform' のまま |
| `src/lib/validators/knowledge.ts` (createKnowledgeSchema) | ❌ **漏れ** | 旧値 'power_platform' のまま |

結果: estimate / knowledge エンティティの API が新値受理せず 400 エラー。
Stop hook の横断監査で発覚し PR-β hotfix で修正。

#### 横展開チェックリスト (master-data.ts 値変更時に必ず実行)

```bash
# 1. 変更対象 enum を使う validator を全検索
ENUM_NAME="DEV_METHODS"  # 例
LOWERCASE_FIELD="devMethod"
grep -rn "$LOWERCASE_FIELD" src/lib/validators/ --include='*.ts'

# 2. 旧値を直接 hardcode している箇所を検出 (validator 内の z.enum)
OLD_VALUE="power_platform"  # 例
grep -rn "$OLD_VALUE" src/lib/validators/ --include='*.ts'

# 3. test ファイルでも旧値使用を検出 (false positive 含む)
grep -rn "$OLD_VALUE" src/ --include='*.test.ts'

# 4. UI 側 (Object.entries(MASTER_CONST)) の renderer 確認
grep -rn "Object\.entries\($ENUM_NAME\)" src/app src/components --include='*.tsx'
```

#### 規約 (master-data 値変更 PR で必ずやる)

1. **master-data.ts の値を変更したら、必ず上記チェックリストを実行**
2. **変更対象 enum を使う validator を全件 update** (関連 entity 全部、漏れなく)
3. **migration の UPDATE 文も全関連テーブルを網羅** (§5.28 の table 名検証ルールも併用)
4. **test ファイルの enum 使用箇所も grep して同期**
5. **commit message に「validator N 件横展開済」と明記** してレビュー時の確認を促す

#### 恒久対策 (将来の改善案)

`master-data.ts` の `DEV_METHODS` 等を **Zod の z.enum source** として直接 export し、
validator はそれを `z.enum(Object.keys(DEV_METHODS) as [keyof typeof DEV_METHODS, ...])` で
参照する形にすれば、master-data.ts 1 箇所変更で全 validator が自動追従する (= type-safe な
single source of truth 化)。

#### 関連 (「変更時の漏れ防止 3 兄弟」)

§5.28 (migration 文法漏れ) / §5.30 (validator 漏れ) / §4.44 (migration 適用漏れ) は
いずれも「**ある変更を加えたときに関連箇所の更新を忘れて事故が起きる**」パターンを
防ぐ KDD で、**「変更時の漏れ防止 3 兄弟」** と総称する:

| 兄弟 | 場所 | 漏れ対象 | 起点 |
|---|---|---|---|
| 長男 | §5.28 | migration SQL 文の **table 名** 漏れ | PR #178 (P3018) |
| 次男 | §5.30 (本セクション) | master-data 変更時の **validator** 漏れ | PR-β hotfix |
| 三男 | E2E §4.44 | PR マージ後の **migration 適用** 漏れ | PR #184 (P2022) |

§5.31 (枠数固定要件のアクション充足) は別レベル「**仕様検証時の欠落防止**」(着手前) で、
3 兄弟は「変更時の漏れ防止」(着手後 〜 マージ後) と区別する。

#### その他関連

- §5.10 (フォーム送信前の事前バリデーション) — validator の役割
- src/config/master-data.ts — 列挙値の単一源泉
- PR-β hotfix commits (54e38a0, 3850432) — 本ナレッジの起点

### 5.31 枠数固定要件のアクション充足チェック (T-19 で確立)

#### 背景

ユーザ要件で「N 列のみ」「N フィールドのみ」のように **枠数固定** で来た場合、
そのスキーマで **CRUD 全アクションが満たせるか** を実装着手前に検証する習慣が必要。
T-19 (WBS export/import 7 列化) で、当初要件「6 列のみ」だったが ID 空欄行の
新規作成で parent (階層位置) が解決不能 = CREATE アクションが破綻すると
判明し、`level` 1 列追加して 7 列に確定する仕様微調整が発生した。

#### 検証チェックリスト (枠数固定要件で実装着手前に必須)

| 観点 | 確認内容 |
|---|---|
| **CREATE** | 新規作成行 (= ID/PK 空欄) でレコードを生成可能か。階層構造 / 外部キー / 必須属性は枠内で表現できるか |
| **UPDATE** | 既存レコードの ID 突合で更新可能か。突合キー (ID 等) が枠に含まれているか |
| **DELETE** | 削除モード (CSV 行から消える = 削除候補) を要件に含むか。含む場合、ID なしで「DB 既存」と「枠内 CSV」の差分が取れるか |
| **構造の保持** | 階層 / 親子関係 / 並び順 が必要なら、それを表現する列が枠内にあるか |
| **同名重複の検知** | level + 名称 / 種別 + 名称 等の組み合わせで CSV 内重複を判定可能か |

#### T-19 適用例

| 列構成 | CREATE | UPDATE | DELETE | 階層 | 結論 |
|---|:---:|:---:|:---:|:---:|---|
| 案 A: 6 列 (ID/種別/名称/開始/終了/工数) | ❌ (parent 解決不能) | ✅ | ✅ (ID 突合) | ❌ | **要件破綻** |
| 案 B: 7 列 (+ level) | ✅ | ✅ | ✅ | ✅ (level スタック) | **採用** |
| 案 C: 7 列 (+ parentId) | ✅ (UUID) | ✅ | ✅ | ✅ | 案 B より Excel 編集性で劣る |

着手前に上記マトリクスを記述するだけで、案 A の致命欠陥が事前検出可能だった。

#### 規約 (枠数固定要件で実装着手前に必ずやる)

1. **要件起票時に CRUD マトリクスを引く** (上記テンプレート)
2. **欠落アクションがあればユーザに仕様調整を提案** (列追加 / アクション削除のいずれかを選択)
3. **層構造を伴う entity は階層表現の列が必須** (level / parentId / wbsNumber 等)
4. **設計微調整は §11 の TODO entry に「仕様微調整」として記録** (ユーザ承認後に実装着手)
5. **commit message で「当初要件 N 列 → 仕様微調整で M 列確定」と明記** (将来のレビューで経緯追跡可能化)

#### 一般化 (枠数固定の他パターン)

- 「フィールド N 個のみ」(form) でも同じ: バリデーション / 関連 entity の参照 / 表示 で枠が足りるか
- 「ボタン N 個のみ」(UI 統合) でも同じ: 主要操作 (作成 / 編集 / 削除 / インポート / エクスポート) を満たせるか
- 「画面 N ページのみ」(IA) でも同じ: ユーザの主要ジャーニー全部が枠内に収まるか

#### 関連 (本セクションは「**仕様検証時の欠落防止**」レベル、§5.28/§5.30/§4.44 とは別レベル)

- §11 T-19 (本ナレッジの起点)
- §5.28 / §5.30 / E2E §4.44 (「**変更時の漏れ防止 3 兄弟**」、本セクションとレベルが異なる) — 詳細は §5.30 末尾参照
- §10.5.1 (並列 worktree agents パターン) — 仕様分割の方法論

レベル区別:

| レベル | 該当ナレッジ | タイミング |
|---|---|---|
| **仕様検証時の欠落防止** (本 §5.31) | アクション充足チェック | 実装着手 **前** |
| **変更時の漏れ防止 3 兄弟** | §5.28 / §5.30 / §4.44 | 変更を加えた **直後 〜 マージ後** |

### 5.32 複数 entity 横展開時の段階的汎用化パターン (T-22 で確立)

#### 背景

複数 entity に同種機能 (CRUD、import/export、検索 filter 等) を実装する場合、
個別に実装すると **重複コードが entity 数に比例** し保守性が落ちる。
§5.26「共通部品流用」の戦略的拡張として、**Phase 分割による段階的汎用化** を本セクションで規約化する。

T-22 (5 entity の sync-import 機能) で確立: 先行 1 entity を「**汎用 component
の prop API 設計まで含めた完成形**」で実装することで、後続 N-1 entity が
**機械流用** (~300 行 / 30 分 / entity) で完結することが定量的に実証された。

#### 数値実績 (T-22 全 4 entity)

| Phase | entity | 規模 | 内容 |
|---|---|---|---|
| 22a | risks | ~1,100 行 | service + 汎用 `EntitySyncImportDialog` 確立 + UI + i18n + test |
| 22b | retrospectives | ~700 行 | service + API route + UI 5 行 + i18n |
| 22c | knowledge | ~740 行 | 同上 (tags はセミコロン区切り) |
| 22d | memos | ~700 行 | 同上 (user-scoped、project 紐付けなし) |
| **計** | 4 entity | **~3,240 行** | 個別実装試算 ~4,400 行 → **~26% 圧縮** |

汎用化の中核は `<EntitySyncImportDialog apiBasePath i18nNamespace>` の
**prop API 設計**。Phase 22a 時点で「entity 種別を 2 つの prop で抽象化」
する判断が、後続 3 entity の機械流用を可能にした。

#### パターン適用フロー

| Step | 内容 |
|---|---|
| **1. 横展開対象の確定** | entity 数 ≥ 3 で本パターン適用判断。各 entity の構造の差異を §5.31 アクション充足マトリクスで事前検証 |
| **2. Phase 分割設計** | 先行 1 entity (Phase A) + 後続 N-1 entity (Phase B〜) に分割。各 Phase は独立 PR とする |
| **3. Phase A 実装** | service / API / **汎用 component** / UI / i18n / test を完成形で実装。汎用 component の **prop API 設計** に最大の注意を払う (entity 種別を 2-3 個の prop で表現できるか) |
| **4. Phase A レビュー** | 「次 entity がコピー&置換にならないか」を観点にレビュー (専用実装にとどまっていないかの検証) |
| **5. Phase B〜 機械流用** | 後続 entity は service の列パース定義 + i18n キー一式 + UI への 5-10 行追加のみ。**汎用 component には触れない** |
| **6. §11 への完了マーク + 数値記録** | 圧縮率 / Phase 別行数 / Phase A の汎用化判断 を更新履歴に残す |

#### 適用判断基準

| 状況 | 適用 | 代替案 |
|---|---|---|
| entity 数 ≥ 3 + 構造類似 | ✅ 本パターン | — |
| entity 数 = 2 | △ 効果限定的 | 共通 helper 関数のみ抽出 (§5.26) |
| 各 entity の構造が極端に異なる | ❌ | 個別実装 |
| 1 entity のみ | ❌ | 通常の専用実装 |

#### アンチパターン (避けるべき実装順序)

| 失敗パターン | 結末 |
|---|---|
| Phase A を「専用実装」で済ませる | Phase B〜 が「コピー&置換」になり保守性低下 (1 箇所修正が N 箇所に波及) |
| Phase A の prop API を「最低限」に絞る | 後続で必ず prop 追加 → 既存 entity の component 再修正 (Breaking change) |
| 全 entity 一括実装 | レビュー困難、テスト網羅性低下、汎用化判断が後付けになる |

#### T-22 適用の具体例 (汎用 component prop 設計)

```tsx
// ❌ アンチパターン: entity 種別ごとに専用 component
<RiskSyncImportDialog projectId={...} />
<RetrospectiveSyncImportDialog projectId={...} />
// 各 component が ~400 行、列定義以外はほぼ重複

// ✅ T-22 で採用: 2 つの prop で抽象化
<EntitySyncImportDialog
  apiBasePath={`/api/projects/${projectId}/risks/sync-import`}
  i18nNamespace="risk.syncImport"
  open={...} onOpenChange={...} onImported={...}
/>
// Component 1 件のみ (~410 行)、後続 entity は 5 行の wiring で完結
```

#### 関連

- §5.26 (共通部品流用、本パターンの基盤原則)
- §5.31 (枠数固定要件のアクション充足、横展開前の事前検証として組み合わせる)
- §11 T-22 (本パターンの起点・実証 5 entity)
- T-22 commits 19fa9bd (Phase 22a) / 2081e88 (22b) / 20f548b (22c) / 73afd2d (22d)

### 5.33 API route の server-side i18n + vitest 共通モック (T-17 Group 2 で確立)

#### 背景

API route が返すエラー message も i18n 化する必要がある (`Accept-Language` 等の
ロケール切替時に英語表示される)。next-intl では server context で
`getTranslations(namespace)` を呼ぶが、**vitest 環境では
「`getTranslations` is not supported in Client Components」** で失敗する。

T-17 Group 2 (2026-04-28) で 24 API route × 16 i18n keys を一括 i18n 化した経験から、
**vitest.setup.ts 共通モック** + **route 側の標準パターン** を §5.33 として規約化する。

#### route の i18n 化パターン (標準)

```ts
// src/app/api/.../route.ts
import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';   // ← 追加

export async function POST() {
  // ... バリデーション
  if (errorCondition) {
    const t = await getTranslations('message');       // ← エラー時のみ取得
    return NextResponse.json(
      { error: { code: 'XXX', message: t('keyName') } },
      { status: 400 },
    );
  }
}
```

ポイント:

| 項目 | 規約 |
|---|---|
| `import` 位置 | `next/server` の直下に配置 (順序を統一) |
| `t` 取得タイミング | エラー分岐内で local に `await getTranslations(...)` (関数 top-level で取らない、未使用時のオーバヘッドを避ける) |
| 既存 namespace の活用 | `message` (汎用) / `admin.users` (admin 系) など、文脈に合うものを選ぶ |
| 新規 key 追加 | `ja.json` と `en-US.json` の **両方** に追加 (片方漏れは i18n test で検知) |
| 共通 helper の async 化 | `function forbidden()` 等を `async function forbidden()` にすると caller 側に `await` が必要、忘れると Promise が response として返り 500 |

#### vitest 共通モック (vitest.setup.ts)

```ts
// vitest.setup.ts (T-17 Group 2 で新設)
import { vi } from 'vitest';

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));
```

```ts
// vitest.config.ts
test: {
  setupFiles: ['./vitest.setup.ts'],   // ← 全 test に自動適用
  // ...
}
```

これにより:

- 全 test で `getTranslations` が「key 名そのまま返す」スタブで動作
- 個別 test に `vi.mock('next-intl/server', ...)` を書く必要なし
- メッセージ検証は **`expect(body.error.message).toBe('keyName')`** スタイルになる
  (具体メッセージを検証したい場合は個別 test で上書きモック可能)

#### test 期待値の書き換え規約

i18n 化前のテストは具体メッセージを `toContain('自分が担当のタスクのみ')` のように
検証していた。i18n 化後は **key 名そのまま検証** に変更:

```ts
// Before (i18n 化前)
expect(body.error.message).toContain('自分が担当のタスクのみ');

// After (i18n 化 + vitest setup スタブ前提)
expect(body.error.message).toBe('bulkProgressOwnTasksOnly');
```

#### 横展開時の手順 (将来 i18n 対応する route で適用)

1. ja.json / en-US.json の `message` namespace に新規 key を追加 (両 locale 必須)
2. route ファイルに `import { getTranslations } from 'next-intl/server';` を追加
3. エラー分岐内で `const t = await getTranslations('message');`
4. メッセージ部分を `t('keyName')` で置換
5. 該当 test の期待値を key 名検証に変更 (vitest.setup.ts のスタブが自動適用)
6. `pnpm tsx scripts/i18n-extract-hardcoded-ja.ts` で残ヒット 0 件確認

#### アンチパターン

| 失敗パターン | 結末 |
|---|---|
| 各 test に個別 `vi.mock('next-intl/server', ...)` を書く | 重複コード + 追加忘れによる CI 失敗の連鎖 |
| `getTranslations` を関数 top で 1 回取得 | 早期 return path も無駄に async になり、未使用時オーバヘッド |
| ja.json のみ追加 (en-US 漏れ) | en-US 切替時に `[Missing message]` 表示 |
| 共通 helper を sync のまま `getTranslations` を呼ぶ | 「await の伝播漏れ」エラーで 500 (非同期化忘れの罠) |

#### 関連

- §11 T-17 (本パターンの起点)
- §10.5.1 (並列 worktree agents パターン、大量 i18n 化の作業並列化と相性良)
- vitest.setup.ts / vitest.config.ts (実装位置)

### 5.34 アクション型 Select の選択後表示 (`SelectValue` children render 関数 + `value=""`、Phase A で確立)

#### 背景

@base-ui/react の `<Select>` は `value` が **未指定 (uncontrolled)** だと、`onValueChange`
で API 呼び出しした後にも内部で選択値を保持してしまい、`<Select.Value>` が **内部 key
名 (例: `'manager'`、`'planning'`)** をそのまま表示してしまう問題がある。

これは「アクション型 Select」(選択 = サーバ更新の即実行、選択値を state として
保持しない) で頻繁に発生する。Phase A (2026-04-28) で プロジェクト状態 / メンバー
ロール / ナレッジ種別フィルタの 3 箇所で同じ症状を修正した。

#### 標準パターン (2 系統)

##### 系統 A: アクション型 Select (選択 = 即サーバ更新、value を保持しない)

**典型例**: 「状態変更」プルダウン、「ロール変更」プルダウン

```tsx
// ❌ Bad: uncontrolled、選択後に内部 key 名が露出
<Select onValueChange={handleStatusChange}>
  <SelectTrigger>
    <SelectValue placeholder={t('placeholder')} />
  </SelectTrigger>
  ...
</Select>

// ✅ Good: value="" で常時 placeholder + render 関数で表示名フォールバック
<Select value="" onValueChange={handleStatusChange}>
  <SelectTrigger>
    <SelectValue placeholder={t('placeholder')}>
      {(value) => (value
        ? PROJECT_STATUSES[value as keyof typeof PROJECT_STATUSES] || value
        : t('placeholder'))}
    </SelectValue>
  </SelectTrigger>
  ...
</Select>
```

`value=""` で常に placeholder が表示され、render 関数は二重防御として表示名にフォールバック。

##### 系統 B: コントロール型 Select (state と双方向バインド)

**典型例**: フィルタ Select、編集 dialog 内の項目選択

```tsx
// ❌ Bad: SelectValue が内部 key 名を表示
<Select value={typeFilter} onValueChange={setTypeFilter}>
  <SelectTrigger>
    <SelectValue placeholder={t('all')} />
  </SelectTrigger>
  ...
</Select>

// ✅ Good: render 関数で必ず表示名にマップ
<Select value={typeFilter || '__all__'} onValueChange={setTypeFilter}>
  <SelectTrigger>
    <SelectValue placeholder={t('all')}>
      {(value) => {
        if (!value || value === '__all__') return t('all');
        return KNOWLEDGE_TYPES[value as keyof typeof KNOWLEDGE_TYPES] || value;
      }}
    </SelectValue>
  </SelectTrigger>
  ...
</Select>
```

#### 横展開チェックリスト (master-data の enum を Select で扱う全箇所)

```bash
# 1. <SelectValue> を使っている全箇所を抽出
grep -rnE "<SelectValue\\s*/?>" src/app src/components --include='*.tsx'

# 2. 上記のうち render 関数 (children) を持たないものを特定
#    (false positive: edit dialog 内の text フィールドは表示名問題が起きないが、
#     master-data enum を扱うものは要対応)

# 3. 同一 master-data (PROJECT_STATUSES / PROJECT_ROLES / KNOWLEDGE_TYPES /
#    DEV_METHODS / IMPACT_LEVELS / 等) を Select で表示する箇所は全て render 関数を要設定
```

#### 規約 (`<SelectValue>` を使う PR で必ずやる)

1. **render 関数を必ず設定**: 内部 key 名露出のリスクを設計レベルで遮断
2. **アクション型なら `value=""` を併用**: 二重防御
3. **`render(value) => label` の lookup は O(1)**: master-data 静的オブジェクト
   (`PROJECT_STATUSES[value]` 等) を参照、ループ禁止
4. **i18n 切り替えで自動追従**: master-data の Japanese label が直接埋め込まれて
   いるため、en-US 切り替えは別途 §8 (UI ラベル追加手順) に従う必要あり。
   将来的には master-data も翻訳 key に統一する候補 (T-XX)
5. **PR レビュー観点**: `<SelectValue` の追加/変更があれば render 関数の有無を必ず確認

#### アンチパターン

##### A1. children を関数として渡さず、固定 ReactNode で渡す

```tsx
// ❌ value 引数を受け取れない、表示名マッピング不可能
<SelectValue>{KNOWLEDGE_TYPES.research}</SelectValue>
```

##### A2. アクション型で `value` 未指定 + `defaultValue` も未指定

```tsx
// ❌ 選択後に内部 key 名が trigger に残り続ける
<Select onValueChange={handleAction}>
```

##### A3. master-data から外れた値で render 関数が undefined にフォールバック

```tsx
// ❌ value || value のフォールバックなしだと undefined が出る
<SelectValue>
  {(value) => KNOWLEDGE_TYPES[value]}
</SelectValue>

// ✅ || value で内部 key 名へのフォールバックを保つ
<SelectValue>
  {(value) => KNOWLEDGE_TYPES[value] || value}
</SelectValue>
```

##### A4. SelectValue children を controlled value と矛盾させる

state が `value="research"` でも render 関数が `'verification'` を返すなど、
内部 state と表示の食い違いを生む手書きロジックは避ける。

#### 関連

- §5.31 (枠数固定要件のアクション充足) — 表示と内部 state の整合性確保レイヤ
- @base-ui/react Select.Value 公式ドキュメント — `children` は `(value: any) => ReactNode`
- src/config/master-data.ts — 表示名マッピングの単一源泉
- Phase A 適用例: project-detail-client (state 変更) / members-client (ロール変更) /
  knowledge-client (種別フィルタ)

### 5.35 dialog 内 component の nested form 回避 (Phase B 要件 4 で確立)

#### 背景

編集 dialog の中に `<AttachmentList>` のような **内部に独自 `<form onSubmit>` を持つ
component** を埋め込むと、HTML 仕様 (HTML5) で **nested forms は許容されない**
ため parser は内部 `<form>` を無効化し、内部の `<Button type="submit">` クリック
が外側 dialog form の submit を発火する。

Phase B (2026-04-28) 要件 4 で発覚:
「リスク編集 dialog で **添付リンク追加ボタン** をクリックすると、添付が追加
されず代わりに dialog が閉じてしまう」

```html
<!-- ❌ Bad: 編集 dialog の中に AttachmentList の内部 form -->
<form onSubmit={handleEditSave}>           <!-- 外側 form -->
  <Input value={title} ... />
  <AttachmentList>                          <!-- ↓ component 内部 -->
    <form onSubmit={handleAddAttachment}>   <!-- 内部 form (HTML 仕様で無効化される) -->
      <Input value={url} ... />
      <Button type="submit">追加</Button>   <!-- ← 押すと外側 form を submit -->
    </form>
  </AttachmentList>
  <Button type="submit">保存</Button>
</form>
```

#### 標準パターン

dialog (= 外側 form 内) で使われる **可能性がある** component は、**内部に
`<form>` を絶対に書かない**。代わりに `<div>` + `type="button"` + 必要なら
`onKeyDown` で Enter キー処理を自前で実装する:

```tsx
// ✅ Good: <form> を使わず、Enter キーは自前で捕捉
<div
  onKeyDown={(e) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault();      // 外側 form への伝播を遮断
      void handleAdd();
    }
  }}
>
  <Input value={url} ... />
  <Button type="button" onClick={() => void handleAdd()}>追加</Button>
</div>
```

ポイント:
1. `<form>` を使わない (nested forms 禁止)
2. submit ボタンは `type="button"` で明示 (default は submit になりブラウザ依存)
3. Enter キー UX は `onKeyDown` で自前実装し `e.preventDefault()` で外側 submit を遮断
4. `e.target.tagName === 'INPUT'` で input フォーカス時のみ trigger (textarea などは別判定)
5. validation は handler 内で手動チェック (form 自動 validation は使えない)

#### 横展開チェックリスト (新規 component を作るとき)

```bash
# 1. dialog 内で使われる component かどうかを確認
#    (一般に @/components/* に置かれ <form> 配下で使われる component は要対応)

# 2. component 内で <form onSubmit> を使っていないか確認
grep -rnE "<form onSubmit" src/components --include='*.tsx'

# 3. ヒットしたら以下を確認:
#    - その component は dialog (= 外側 form) の中で使われるか?
#    - 使われるなら本パターンに変換 (<div> + type="button")
#    - 使われない (= top-level page 専用) なら問題なし
```

#### 規約 (component を作る/レビューする時に必ずやる)

1. **再利用 component は `<form>` を持たない**: dialog 内利用を考慮し、最初から
   `<div>` + `type="button"` で書く
2. **どうしても form 機能が欲しい場合**: 1 ボタンの component なら `<button
   type="submit" form="<form-id>">` の `form` 属性で外部 form を指定する手も
   あるが、依存が増えるので非推奨
3. **PR レビュー観点**: 新規 component の PR で `<form>` を見つけたら「dialog
   内利用するか」を確認、する場合は本パターンに修正
4. **既存修正例**: `src/components/attachments/attachment-list.tsx` /
   `single-url-field.tsx` (Phase B 要件 4 で本パターンに修正)

#### アンチパターン

##### A1. `<form onSubmit>` を component 内部に書く

最悪の例。外側 form がある場合は確実に壊れる。

##### A2. `<button type="submit">` を default に任せる

```tsx
// ❌ default で submit type になり、外側 form が submit される
<button>追加</button>

// ✅ 明示的に type="button"
<button type="button">追加</button>
```

##### A3. `e.stopPropagation()` だけで済ませようとする

`<form onSubmit>` は実装上 `<form>` 上の event だが、HTML が nested form を
無効化するため内部 form の onSubmit は **そもそも発火しない**。
`stopPropagation()` も `preventDefault()` も意味なく、外側 form の submit が
そのまま走る。**`<form>` を消すこと以外の解はない**。

#### 関連

- HTML 仕様 (HTML Living Standard §4.10.3): "form elements must not have any
  form descendants" — nested forms は parser が黙って削除する
- §5.34 (アクション型 Select の選択後表示) — Phase A/B で同時に発見した UI 系統別の罠
- 修正例: PR #188 (commit 17369d4) — attachment-list.tsx / single-url-field.tsx

### 5.36 dialog の readOnly 分岐パターン (一覧行クリックで詳細閲覧 + 作成者のみ編集、Phase B 要件 5 で確立)

#### 背景

「○○一覧」「全○○」のような一覧画面で:
- **作成者本人**: 行クリック → 編集 dialog 表示
- **非作成者**: 行クリック → ダイアログが開かない (= 詳細も見れない)

という UX が PR #165 以降で運用されていたが、Phase B 要件 5 で
「**詳細閲覧は全員に許可、編集権限のみ作成者に限定**」へ変更が必要になった。

#### 標準パターン

各 edit-dialog component に `readOnly?: boolean` prop を持たせ、`fieldset
disabled={readOnly}` でフィールド全体を非活性化する。一覧側では:

```tsx
// ✅ Good: 全員 row click 可、dialog 内で readOnly 分岐
{items.map((item) => {
  const isOwner = item.createdBy === currentUserId;
  return (
    <Row
      key={item.id}
      className="cursor-pointer hover:bg-muted"
      onClick={() => setEditing(item)}    // ← 全員クリック可
    />
  );
})}

<EditDialog
  item={editing}
  open={editing != null}
  onOpenChange={(v) => { if (!v) setEditing(null); }}
  // ↓ 非作成者は readOnly モード (admin は編集可、サービス層で再判定)
  readOnly={editing != null && editing.createdBy !== currentUserId && systemRole !== 'admin'}
/>
```

dialog 側:

```tsx
export function ItemEditDialog({ item, readOnly = false, ... }: Props) {
  return (
    <Dialog>
      <DialogTitle>{readOnly ? t('detailTitle') : t('editTitle')}</DialogTitle>
      <fieldset disabled={readOnly} className="space-y-4 disabled:opacity-90">
        {/* 全 input field */}
      </fieldset>
      {!readOnly && <Button type="submit">{t('save')}</Button>}
    </Dialog>
  );
}
```

ポイント:
1. **行クリックは全員に開放**: 詳細閲覧は基本的な権限と扱う
2. **`fieldset disabled` で一括非活性化**: 個別 input の disabled 設定より保守性が高い
3. **Save ボタンは readOnly 時に非表示**: 誤クリック防止
4. **タイトルも分岐**: 「編集」 vs 「詳細」で UX を明示
5. **API 側でも再判定**: クライアントの readOnly はあくまで UX、サービス層で
   create_by との照合を必ず実施 (`§5.10` の事前 validation 原則)

#### 横展開チェックリスト

すべての edit-dialog component で以下を確認:

```bash
# 1. readOnly prop が定義されているか
grep -nE "readOnly\??:.*boolean" src/components/dialogs/*-edit-dialog.tsx

# 2. fieldset disabled={readOnly} で非活性化しているか
grep -nE "fieldset disabled" src/components/dialogs/*.tsx

# 3. submit button が !readOnly でガードされているか
grep -nE "!readOnly &&" src/components/dialogs/*-edit-dialog.tsx
```

#### 規約

1. **新規 edit-dialog は最初から readOnly 対応**: 後から付ける retrofit は漏れやすい
2. **行クリックの onClick で `isOwner` ガードを書かない**: dialog 側で readOnly
   分岐するため、一覧側は無条件 onClick で OK
3. **admin の扱い**: `systemRole !== 'admin'` を加えると admin は他人作成も編集
   可。entity の業務性質に合わせる (例: project knowledge は admin もリスト経由
   で編集できない方針 → admin 編集を加味しない)
4. **添付の readOnly 配慮**: §5.35 の AttachmentList も `canEdit={!readOnly}`
   で添付追加/削除を非活性化する (PR #188 の延長運用)

#### 適用例 (Phase B 要件 5)

| 一覧画面 | readOnly 分岐ロジック |
|---|---|
| `risks-client.tsx` (project tab) | `r.reporterId !== currentUserId && systemRole !== 'admin'` |
| `retrospectives-client.tsx` (project tab) | `retro.createdBy !== currentUserId` |
| `project-knowledge-client.tsx` (project tab) | `k.createdBy !== currentUserId` |
| `all-risks-table.tsx` (top-level 全リスク) | 常に `readOnly={true}` (PR #165 方針: 編集は ○○一覧経由) |
| `all-retrospectives-table.tsx` (top-level) | 常に `readOnly={true}` |

#### 関連

- §5.10 (事前 validation): クライアントの readOnly はあくまで UX、サービス層で
  必ず再判定する
- §5.35 (nested form 回避): readOnly モード時の AttachmentList は `canEdit={false}`
  で連動非活性化
- §5.27 (機能 deferral): UI 削除と service 残置の組み合わせと逆方向のパターン
- 修正例: PR #188 (commit 17369d4) — Phase B 要件 5

### 5.37 一括編集はフィルター任意 — 多層防御は per-row 認可で代替する (Phase C 要件 18 で確立、§5.21/§5.22/§5.23 を上書き)

#### 背景

- §5.21 (PR #161) / §5.22 (PR #162) / §5.23 (PR #165) で確立した「フィルター必須」
  二重防御パターン (`isFilterApplied()` / `isCrossListFilterApplied()` をサーバ側で
  検証し、UI も `filterApplied` で gating) は、Phase C 要件 18 (2026-04-28) で撤廃。
- ユーザ要件: 「フィルタの有無関係なく一括編集は可能であり、任意の複数行に対して
  一括編集できる。そのため、全行でも任意の複数行でも一括編集可能」
- フィルター適用を強制すると「全選択した行のうち、自分が起票/作成した一部だけを
  さらに絞って bulk 編集したい」という正常 UX が阻害されるため要件を上書き。

#### 新ルール

「全件更新の事故防止」は **以下の 3 層** で代替する:

1. **per-row 作成者判定 (silent skip)**: サービス層で reporter/createdBy が viewer と
   一致しない行は無視する (旧来から既に実装済)。これが最強の防御層。
2. **ids 上限 500**: schema レベルで 1 リクエストあたりの blast radius を限定。
3. **projectId scope**: project-scoped API は where 句に projectId を含めるため、
   ids に他プロジェクトの行が混ざっても skippedNotFound 扱い (= 触れない)。

UI 側は **常時 checkbox 列とツールバーを表示** し、`viewerIsCreator=true` 行のみ
チェック可能とする (per-row 認可の UI 反映)。

#### 実装チェックリスト (Phase C 要件 18 の横展開時)

- API route: `if (!isFilterApplied(...))` / `if (!isCrossListFilterApplied(...))`
  ブロックを削除 + import / `getTranslations` の不要化を確認
- validator: `isFilterApplied` / `isCrossListFilterApplied` 関数 + テストを削除。
  `filterFingerprint` schema は schema 互換維持のため残すが値の検証はしない
- client: `filterApplied` の computed 変数を削除し、checkbox 列・ツールバーを常時表示
- i18n: `message.filterRequiredForBulk` / `*.filterRequiredHint` キーを削除
- E2E: `400 FILTER_REQUIRED` ケースを `200 OK + filterFingerprint:{}` に書き換え
- unit test: `isFilterApplied` / `isCrossListFilterApplied` の expect を全削除し、
  代わりに「filterFingerprint 空でも schema は通る」ケースを追加

#### 履歴

- §5.21 / §5.22 / §5.23 (PR #161/#162/#165) — 旧「フィルター必須」二重防御パターン。
  Phase C 要件 18 で撤廃。歴史的経緯として残す。
- 修正例: feat/ux-improvements-batch3 (Phase C 要件 18, 2026-04-28)

### 5.38 空白区切り OR キーワード検索の共通ヘルパ (Phase C 要件 19 で確立)

#### 背景

各一覧画面 (risks / memos / knowledge / retrospectives / cross-list 系) が独自に
`text.toLowerCase().includes(keyword.toLowerCase())` で keyword 検索していた。
ユーザ要件 (Phase C 要件 19, 2026-04-28): 「ログイン エラー」と空白区切りで複数キーワードを
入れたとき、いずれか一方でもヒットする (OR 条件) のが直感に合う。
旧仕様だと「ログイン エラー」の連続文字列を持つレコードしかマッチせず実用性が低い。

#### 共通ヘルパ

`src/lib/text-search.ts`:

- `splitKeywordTokens(query)`: 半角/全角空白 (`/[\s　]+/`) で分割し小文字化、空要素除外
- `matchesAnyKeyword(query, fields)`: トークン × フィールドの 2 重 OR で判定
  - query が空 (もしくは空白のみ) → true (= フィルタ非適用)
  - フィールド配列は `(string | null | undefined)[]` を許容 (null/undefined は空文字扱い)

```ts
import { matchesAnyKeyword } from '@/lib/text-search';

xs.filter((r) => matchesAnyKeyword(filter.keyword, [r.title, r.content, r.assigneeName]));
```

#### 設計上の罠 (再発防止メモ)

- **全角空白対応必須**: 日本語ユーザは IME で全角空白 `　` を入力する。
  JavaScript の `\s` は ECMAScript 6 以降 Unicode の空白文字 (　 含む) にマッチするが、
  確実性を高めるため `[\s　]+` と全角空白を明示的に列挙している。
- **`undefined` フィールドの安全な扱い**: 検索対象に nullable な氏名・補助文字列が混じる
  ケース (assigneeName / reporterName 等) があるため、ヘルパ側で `?? ''` 正規化を実施。
  呼出側で `(r.foo ?? '').toLowerCase().includes(...)` を書く必要がない。
- **大小文字無視**: トークンとフィールドの両方を toLowerCase してから比較。

#### 横展開チェックリスト

新たな一覧画面に keyword 検索を実装する際:

- 直接 `keyword.toLowerCase().includes(...)` を書かない
- `import { matchesAnyKeyword } from '@/lib/text-search'` を使う
- 検索対象フィールドは配列で渡す (`[r.title, r.content, ...]`)
- placeholder には「(空白区切りで OR 検索)」のヒントを含める (UX 一貫性)

#### 関連

- `src/lib/text-search.test.ts`: 12 ケース (全角空白 / 大小文字 / null フィールド 等)
- 適用先: risks-client / memos-client / project-knowledge-client / retrospectives-client /
  all-risks-table / all-retrospectives-table / knowledge-client (合計 7 ファイル)
- 修正例: feat/ux-improvements-batch3 (Phase C 要件 19, 2026-04-28)

### 5.39 ガントチャートの曜日・祝日色分けパターン (Phase C 要件 16/17 で確立)

#### 背景

旧仕様: 土・日・祝日を一律に `bg-accent text-muted-foreground` (灰色) で表示。
ユーザ要件 (Phase C 要件 16/17, 2026-04-28):
- 土曜日は **青** (text-info / bg-info/5)
- 日曜日と祝日は **赤** (text-destructive / bg-destructive/5)

カレンダーアプリ等で慣れた色彩 (土=青、日・祝=赤) に合わせ、視認性を向上させる。

#### 実装パターン

ヘッダ (date セル) と背景オーバーレイで同じ優先順位の if-chain を使う:

```tsx
const dayClass = isToday
  ? 'bg-info/20 font-bold text-info'                       // today を最優先
  : isSunday || isHoliday
    ? 'bg-destructive/5 text-destructive'                  // 日・祝
    : isSaturday
      ? 'bg-info/5 text-info'                              // 土
      : 'text-muted-foreground';                           // 平日
```

優先順位: **today > 日曜・祝日 > 土曜 > 平日** (土曜が祝日なら赤を優先)。

#### 設計判断

- **セマンティック色 token を使う**: `text-blue-600` ではなく `text-info`、
  `text-red-600` ではなく `text-destructive` を使うことで、
  ダークテーマやカスタムテーマでも視認性が維持される (config/theme-definitions.ts §76 で
  「全テーマで同色相を維持」が約束されている)。
- **背景は薄め (`/5` opacity)**: タスクバー・milestone マーカーの視認性を阻害しない。
  ただし today だけは明確に分かるよう `/20` で濃い目。
- **dayMarkers の filter 条件**: `isSaturday || isSunday || isHoliday || isToday` の
  4 種を OR 抽出。旧 `isWeekend` (土+日) を分割したことで、土曜と日曜で別の背景色を
  当てる経路が成立する。

#### 横展開チェックリスト

別の表形式 UI (例: 出勤簿、ロードマップ等) で同じ曜日色分けが必要な場合:

- 土曜判定は `dayOfWeek === 6`、日曜判定は `dayOfWeek === 0`
- 祝日判定は `import { getJapaneseHoliday } from '@/lib/jp-holidays'` で `null` 以外
- 色は info/destructive (セマンティック token) を `/5` 〜 `/20` opacity で使い分け
- title 属性で祝日名を tooltip 表示 (PR #125 確立パターン)

#### 関連

- `src/lib/jp-holidays.ts` (PR #125 で導入、`@holiday-jp/holiday_jp` ラッパ)
- 修正例: feat/ux-improvements-batch3 (Phase C 要件 16/17, 2026-04-28)
- `src/app/(dashboard)/projects/[projectId]/gantt/gantt-client.tsx`

### 5.40 派生カラムをサービス層で永続化するパターン (Phase D 要件 11 で確立)

#### 背景

ステークホルダーに優先度 (high/medium/low) を持たせる要件が発生。優先度は
PMBOK Power/Interest grid の 4 象限から **自動分類** された値であり、UI の
ソート/フィルタで使う。実装上の選択肢は 2 つ:

| 案 | メリット | デメリット |
|---|---|---|
| (A) DTO 化時に都度計算 (永続化しない) | スキーマ変更不要、依存元の influence/interest と必ず整合 | DB index が使えず、サーバ側 filter/orderBy 不可。N 件の DTO 化計算が常に走る |
| (B) DB に永続化 + create/update で再計算 | DB index/orderBy が使える、API 側 filter が直書きできる | influence/interest 変更時の再計算漏れリスク (整合性は service 層責務) |

#### 採用: (B) 永続化 + サービス層で再計算

理由: (1) 一覧の filter/sort で実用的な検索性能を出す、(2) 値域が変わった時の
backfill を migration で書ける (UPDATE … SET priority = CASE …) ため、既存データの
整合性を確保できる。(A) の場合 schema 移行不要で軽いが、UI の filter は完全クライアント
側になり、件数が増えると重くなる懸念がある。

#### 実装の要点 (派生カラムの整合性ガード)

1. **派生関数を 1 箇所に集中**: `src/config/master-data.ts` の `deriveStakeholderPriority`
   が単一の真実 (single source of truth)。サービス層と migration 双方が同じ式を実装。
   - migration の SQL `CASE WHEN influence>=4 AND interest>=4 …` は TS 関数と等価
   - 閾値や象限定義を変えるときは **TS 関数 + migration のみ修正**、それ以外は触らない
2. **create 時は常に derive**: 入力に priority フィールドを許さず、`influence × interest`
   から計算した値を保存する。
3. **update 時は依存元変更時のみ再計算**:
   ```ts
   if (input.influence !== undefined || input.interest !== undefined) {
     const nextI = input.influence ?? existing.influence;
     const nextN = input.interest  ?? existing.interest;
     data.priority = deriveStakeholderPriority(nextI, nextN);
   }
   ```
   片方だけの patch でも残り片方は existing から取得して derive する (ここを書き忘れると
   priority が依存元と乖離するバグになる)。
4. **migration で既存データを backfill**: 新カラム追加時は default 値だけでは不十分。
   `UPDATE` 文で全行を再計算してから index を張る (`20260429_stakeholder_priority`)。

#### 横展開チェックリスト (派生カラムを増やすときに確認)

- [ ] 派生関数を `src/config/master-data.ts` 等に **1 箇所だけ** 定義し、TS と migration の
      両方が同じ式を実装しているか
- [ ] create サービスで入力 (validator) に派生フィールドを **載せていない** (= ユーザが
      override できない)
- [ ] update サービスで「依存元のいずれかが undefined でない」場合に派生を再計算しているか
- [ ] update サービスで existing からの fallback (片方の patch でも残りで derive 可能) を
      実装したか
- [ ] migration で全行 backfill した上で必要なら index を張ったか
- [ ] DTO 型に派生フィールドを含め、UI/API が消費できるよう公開したか

#### 関連

- `src/config/master-data.ts` (deriveStakeholderPriority + classifyStakeholderQuadrant)
- `src/services/stakeholder.service.ts` (create/update での再計算)
- `prisma/migrations/20260429_stakeholder_priority/migration.sql` (backfill + index)
- `src/services/stakeholder.service.test.ts` (priority 自動分類 + 再計算ケース)
- 修正例: feat/ux-improvements-batch4 (Phase D 要件 11/12, 2026-04-28)

### 5.41 「○○一覧」共通 UI 部品の抽出規約 (Phase E 要件 1〜3 で確立)

#### 背景

「○○一覧」(全○○一覧 + プロジェクト個別一覧) で同じ shape の JSX が画面ごとに
コピペされていた。ユーザ要望「**今後要件変更があったときに修正箇所を極力減らしたい**」
を満たすため、重複箇所を全て common 部品に抽出した。

#### `src/components/common/` 部品マップ

| 部品 | 役割 | 元の重複箇所 |
|---|---|---|
| `<VisibilityBadge>` | `public`/`draft`/`private` バッジ表示 | 4 画面 (memo / risk / retro / knowledge) |
| `<ClickableRow>` / `<ClickableCard>` | テーブル行/カード全体のクリックで dialog を開く UX | 17 箇所 (table 7 + card 10) |
| `<ResizableTableShell>` | `ResizableColumnsProvider + ResetColumnsButton + Table` の 4 行ボイラープレート | 8 ファイル |
| `<FilterBar>` | `rounded-md border bg-muted/30 p-3` の filter shell + 任意タイトル | 3 一覧 + cross-list toolbar |
| `<BulkSelectHeader>` / `<BulkSelectCell>` | 一括編集 checkbox 列 (header + per-row + 認可分岐) | 4 画面 |
| `<DialogAttachmentSection>` | dialog 内 URL 添付 (`{!readOnly && (<SingleUrlField/>+<AttachmentList/>)}`) | 3 dialog |

#### 抽出ルール (将来同種の重複が発生した時の判断基準)

1. **2 ファイル以上で同じ shape の JSX が出現したら抽出を検討**。3 ファイル以上なら必須。
   shape の細部が変わるパターンは props か slot で吸収できないか先に検討する。
2. **slot 注入を許容**: 内側の入力欄やテーブル行は呼出側で異なるため、shell + children
   方式で骨格だけ共通化する (`<FilterBar>` / `<ResizableTableShell>` がこのパターン)。
3. **認可・state の分岐は props で外出し**: `active` / `canSelect` / `readOnly` 等の
   boolean prop で表示分岐を吸収し、内部に if 条件を書かない。例:
   `<BulkSelectCell canSelect={isOwner} hidePlaceholderWhenDisabled stopPropagation />`
4. **className は末尾結合可能に**: `cn(active && CLICKABLE_HOVER_CLASS, className)`
   で呼出側からの追加 className を許容する。
5. **className 定数も export**: 細かい混ぜ込みケース用に `CLICKABLE_HOVER_CLASS` 等の
   定数も export し、コンポーネント以外でも再利用可能にする。

#### 横展開チェックリスト (新規一覧画面を追加する時に確認)

- [ ] 検索/フィルタ UI は `<FilterBar>` で囲んだか
- [ ] 列幅可変テーブルは `<ResizableTableShell>` で囲んだか
- [ ] 行クリックで dialog を開くなら `<ClickableRow>` / `<ClickableCard>` を使ったか
- [ ] 公開範囲バッジは `<VisibilityBadge>` を使ったか
- [ ] 一括編集 checkbox は `<BulkSelectHeader>` / `<BulkSelectCell>` を使ったか
- [ ] 編集 dialog の URL 添付は `<DialogAttachmentSection>` を使ったか
- [ ] 上記いずれにも該当しないが「他画面と shape が同じ」と感じたら、新たに抽出するか
      既存部品に slot/prop を追加して取り込めないか検討したか

#### 抽出から除外したケース (なぜ抽出しなかったか記録)

- `tasks-client.tsx` の WBS 表: shadcn `<Table>` ではなく native `<table>` を使うため
  `<ResizableTableShell>` の対象外。Provider + ResetColumnsButton を直接記述する。
- `my-tasks-client.tsx`: Provider が `<h2>` 等を含む広範囲を覆う特殊レイアウトのため対象外。
- `customer-detail-client.tsx` の `rounded-md border bg-muted/30 p-3` 1 箇所:
  filter ではなく info block 用途のため `<FilterBar>` ではない。

#### 関連

- `src/components/common/visibility-badge.tsx`
- `src/components/common/clickable-row.tsx` (`<ClickableRow>` / `<ClickableCard>` + 定数)
- `src/components/common/resizable-table-shell.tsx`
- `src/components/common/filter-bar.tsx`
- `src/components/common/bulk-select.tsx` (`<BulkSelectHeader>` / `<BulkSelectCell>`)
- `src/components/common/dialog-attachment-section.tsx`
- 修正例: feat/ux-improvements-batch5 (Phase E 要件 1〜3, 2026-04-29)

### 5.42 migration を含む PR は本番手動適用が必須 — PR description にチェックリスト必須 (Phase D hotfix で確立)

#### 背景・事故事例

- **2026-04-29**: PR #190 (Phase D / `20260429_stakeholder_priority`) を main にマージ後、
  本番ステークホルダー画面が `P2022 ColumnNotFound` で 500 エラーに。
- 原因: PR で migration ファイルは追加したが、**Supabase 本番 DB に手動適用されていなかった**。
- Vercel デプロイは新コード (priority カラム前提の Prisma client) を反映するが、
  DB スキーマは旧状態のまま → カラムなしで SELECT して落ちる。

OPERATION.md §3.3 に「本プロジェクトは Vercel ビルドで `prisma migrate deploy` を実行しない」
ことは明記されていたが、PR description に「Supabase SQL Editor で手動適用」ステップを
明示しなかったため、開発者が「マージ＝本番反映完了」と認識してしまった。

#### 不変ルール

migration ファイルを追加・変更する PR は、**PR description の Test plan セクションに
以下のチェックリストを必ず含める** (フォーマット固定):

```markdown
## 本番反映チェックリスト (migration あり)

- [ ] **マージ前**: Supabase ダッシュボード → SQL Editor で migration SQL を貼り付けて Run
  - SQL 取得: `pnpm migrate:print <migration-name>`
  - 例: `pnpm migrate:print 20260429_stakeholder_priority`
  - RLS 警告が出たら "Run without RLS" を選択
- [ ] **マージ後**: 本番画面で当該機能 (新カラム参照箇所) が動くことを確認
- [ ] **オプション**: drift があれば `pnpm prisma migrate resolve --applied <name>` で同期
```

**順序が重要**: SQL 適用は **マージ前** に実施する。Vercel は main マージで自動デプロイ
されるため、コード反映時に DB スキーマが旧状態だと本番が壊れる (本事例の構造)。

#### 横展開チェックリスト (migration を伴う PR を出す前に確認)

- [ ] PR description に上記「本番反映チェックリスト」セクションを含めたか
- [ ] migration SQL が `pnpm migrate:print` で出力されることを確認したか
- [ ] migration の動作確認: ローカルで `pnpm prisma migrate dev` を実行 → エラーなく完了
- [ ] **本番 DB に同等 SQL を SQL Editor で実行 (マージ前)**
- [ ] backfill が必要な列追加なら、UPDATE 文も migration.sql に含めて 1 トランザクション化

#### 自動化検討 (採用すれば本 KDD 不要になる)

OPERATION.md §3.4 に記載の「DIRECT_URL を Supavisor セッションモードに変更 →
`vercel.json` の buildCommand に `pnpm prisma migrate deploy` を追加」案を採用すれば、
Vercel ビルド時に自動適用される。**現時点では未採用**だが採用検討中 (T-XX 候補)。

#### 関連

- `docs/administrator/OPERATION.md` §3.3 (手動適用手順) / §3.4 (自動化検討)
- `scripts/print-migration.ts` (`pnpm migrate:print <name>` で SQL を stdout 出力)
- 事故事例: 2026-04-29 PR #190 マージ後の P2022 (本 §5.42 の起点)

### 5.43 ガントチャートの independent tab 化 + responsive プルダウン (2026-04-30 で確立)

直前の `feat/gantt-tab-restructure` (PR-C item 6) で WBS タブ内のトグルボタンに
集約していた Gantt を、ユーザ要望「○○一覧と同様に幅が広い時はタブ、狭い時は
プルダウン」に従って独立タブ化 + responsive 切替に再編。

#### 採用パターン (project-detail-client.tsx)

PC (lg+) では「WBS管理」「ガントチャート」を独立タブで並べ、Mobile (lg-) では
「進捗管理 ▼」プルダウンで集約する。「資産プルダウン」(リスク/課題/振り返り/
ナレッジ/参考) と同じ仕組みを再利用 (PR #167 / `dashboard-header.tsx` の 3 分類
プルダウン)。

```tsx
{/* PC: 個別タブ */}
<TabsTrigger value="tasks" className="hidden lg:inline-flex">{t('tabTasks')}</TabsTrigger>
<TabsTrigger value="gantt" className="hidden lg:inline-flex">{t('tabGantt')}</TabsTrigger>

{/* Mobile: 進捗管理プルダウン */}
<Menu.Root>
  <Menu.Trigger className="... lg:hidden">
    <span>{t('progressMenuLabel')}</span><ChevronDownIcon />
  </Menu.Trigger>
  <Menu.Portal>
    <Menu.Positioner>
      <Menu.Popup>
        <Menu.Item onClick={() => handleTabChange('tasks')}>WBS管理</Menu.Item>
        <Menu.Item onClick={() => handleTabChange('gantt')}>ガントチャート</Menu.Item>
      </Menu.Popup>
    </Menu.Positioner>
  </Menu.Portal>
</Menu.Root>
```

#### 設計判断

- WBS と Gantt は **同じ tasks tree + members** を使うため、`<LazyTabContent state={tasks.state}>`
  を 2 回ネストして両タブで共有する (重複 fetch なし)。
- TasksClient 側の `showGantt` state は不要になったため削除。`<GanttClient>` は
  project-detail-client の `<TabsContent value="gantt">` で直接 render。
- `t('progressMenuLabel')` / `t('progressMenuAria')` を新設 (project namespace)。

#### 関連

- `src/app/(dashboard)/projects/[projectId]/project-detail-client.tsx` (タブ + プルダウン UI)
- `src/app/(dashboard)/projects/[projectId]/tasks/tasks-client.tsx` (showGantt 削除)
- `src/i18n/messages/{ja,en-US}.json` の `tabGantt` / `progressMenuLabel` / `progressMenuAria`
- 既存パターン参照: §5.41 (○○一覧の責任プルダウン) / `dashboard-header.tsx` の `assetsMenuLabel`
- 修正例: feat/ux-improvements-batch6 Task 1 (2026-04-30)

### 5.44 リクエスト成功/失敗の Toast 通知パターン (2026-04-30 で確立)

#### 背景

ユーザ要望: 「リクエスト成功時、成功メッセージ表示。画面下部に成功可否によって
メッセージを表示します。緑色の帯で「{操作内容}が成功しました」、赤色の帯で
「{操作内容}が失敗しました」。メッセージ内容は人間が理解できる内容を表示」。

従来は `setError(...)` でローカル state にエラー文言を出すか `alert(...)` で
ブラウザネイティブダイアログを使用しており、**成功時のフィードバックが無かった**
(ユーザが操作完了を判断できず重複送信や不安につながる)。

#### 採用パターン: 共通 ToastProvider + useToast()

`src/components/toast-provider.tsx` を新設、dashboard layout に mount。
全 CRUD 呼び出しで以下の 3 行を追加することで対応:

```tsx
import { useToast } from '@/components/toast-provider';

const { showSuccess, showError } = useToast();

const res = await withLoading(() => fetch(url, { method: 'POST', ... }));
if (!res.ok) {
  setError(...);  // 既存の dialog 内インライン表示 (ローカル state) は維持
  showError('XX の作成に失敗しました');  // ★ 追加: 画面下部に赤帯通知
  return;
}
showSuccess('XX を作成しました');  // ★ 追加: 画面下部に緑帯通知
```

#### 設計判断

1. **新規ライブラリ追加なし**: sonner / react-toastify などは導入せず、
   LoadingProvider と同じ Context パターンで自前実装 (依存最小化)。
2. **メッセージ文字列は呼出側で決める**: i18n キーに集約せず call site で直書き。
   理由: メッセージは「{エンティティ名}を{動作}しました」型で文脈ごとに微妙に
   異なる (例: 「リスクの起票」vs「課題の起票」、「WPの作成」vs「アクティビティの
   作成」)。i18n を経由すると複合キーが乱立して保守性が下がる。
3. **既存 setError() / alert() を併用**: dialog 内のフォーム validation エラー
   表示 (赤帯はあくまで「リクエスト失敗」を表現するもの) はローカル state で
   inline 表示する従来パターンを維持。toast は 4 秒で自動ディスミス、ローカル
   inline は dialog を閉じるか再送信まで残る。
4. **showError と setError は **同時呼び出し****: dialog 内に詳細を出しつつ、画面下部にも
   要約を出すことで「dialog を閉じても気づける」一覧 → toast、「修正に必要な詳細を
   見たい」→ inline、と役割を分担。

#### 横展開チェックリスト (新規 CRUD 呼び出しを追加するときに確認)

- [ ] `useToast()` を import し `showSuccess` / `showError` を使う
- [ ] `if (!res.ok)` 分岐で `showError('〜に失敗しました')` を呼ぶ
- [ ] 成功直後に `showSuccess('〜しました')` を呼ぶ (form reset / dialog close 後でも可)
- [ ] メッセージは「主語+動作」を明示 (例: NG `'削除しました'` / OK `'メモを削除しました'`)
- [ ] エンティティが文脈で変わる場合は変数化 (例: `risk.type === 'risk' ? 'リスク' : '課題'`)
- [ ] 一括処理は件数を含める (例: `${total} 件のタスクを削除しました`)
- [ ] auth フロー (ログイン/パスワードリセット) は ToastProvider 未 mount のため対象外
- [ ] エラーページ (error.tsx / global-error.tsx) も対象外 (既にエラー UI が出ている)

#### 横展開実績 (2026-04-30 時点)

dialog (7): `knowledge-edit-dialog` / `risk-edit-dialog` / `retrospective-edit-dialog` /
`stakeholder-edit-dialog` / `user-edit-dialog` / `wbs-sync-import-dialog` /
`entity-sync-import-dialog`

client (13): `tasks-client` (TaskTreeNode + TaskMobileCard 内部含む) / `memos-client` /
`customers-client` / `customer-detail-client` / `projects-client` / `project-detail-client` /
`estimates-client` / `members-client` / `risks-client` / `retrospectives-client` /
`project-knowledge-client` / `stakeholders-client` / `admin/users-client` /
`settings-client` / `suggestions-panel`

shared (5): `attachment-list` / `single-url-field` / `cross-list-bulk-visibility-toolbar` /
`admin-delete-button` (3 entity) / `staged-attachments-input` は呼出側で create 後に
toast 出すため対象外

#### 関連

- `src/components/toast-provider.tsx` (Context + viewport + 自動ディスミス)
- `src/app/(dashboard)/layout.tsx` (LoadingProvider 内に ToastProvider を mount)
- 修正例: feat/ux-improvements-batch6 (2026-04-30)

### 5.45 既存スキーマカラムを UI のみで活かす任意入力フィールドの追加パターン (2026-04-30 で確立)

#### 背景

「ACT (Activity) に作業内容欄を追加したい」要望を受けたとき、調査で
**`Task.description` (Text, nullable, max 2000) は既に schema/validator/service/DTO に
全て揃っていた**ことが判明。migration / service / DTO 変更は不要、UI 4 箇所
(create form state / create body / edit form type+init+body / 両 dialog の textarea)
だけ追加すれば成立した。

「未使用カラムが既にある」というケースは、リリース時に予防的に切ったカラムや
過去 PR で追加されたまま UI に露出していないものなど散見される。同種要望が来た
ときに schema に列を増やす前にまず**既存カラムを grep で探す**べき。

#### 横展開チェックリスト (UI のみで完結する任意入力フィールドを追加するとき)

- [ ] `prisma/schema.prisma` で当該 entity に類似カラムがないか確認 (description /
      notes / content / detail / memo 等の汎用名)
- [ ] あれば validator / service / DTO で受理されているか確認 (今回は全て揃っていた)
- [ ] **任意項目の create/update 規約**:
  - create: 空文字なら `body` から省略 (`...(form.description.trim() ? { description: form.description.trim() } : {})`)
  - update: 空文字は `null` で送り **明示クリア** (validator 側で nullable() 必須)
- [ ] **type 別 UI 分岐**: WBS のように `type==='activity'` でのみ表示する場合、
      create form / edit form の **両方** で同条件 gating する (片方漏れ注意)
- [ ] form state の reset 関数 (`setForm({...})`) に新フィールドを忘れず含める
- [ ] i18n: ラベル / placeholder / hint の 3 セットを ja/en-US 両方に追加
      (任意項目は hint で「WP は不要」等の補足を入れると UX が上がる)
- [ ] **CSV export/import 連動**: 必要であれば本 PR と分離 (`docs/developer/...` の
      CSV 仕様書 / sync-import test と一緒に変更が必要なため)。本 PR で対象外なら
      PR description に「CSV 反映は対象外」と明記
- [ ] **一括編集連動**: 必要であれば bulk-update validator + bulk dialog の両方を
      更新。任意項目は通常一括編集に含めない方が UX が良い (見つけにくいため)

#### アンチパターン (避けるべき)

- ❌ 既存カラムを確認せず migration を追加する: drift / 重複カラムリスク
- ❌ create で空文字をそのまま `body.description = ''` で送る: validator が空文字を
      max(2000) で通すため null と区別できなくなる (今回は trim() で省略)
- ❌ edit で空文字をそのまま送る: validator の `.nullable()` を活かせず、
      「空文字 = 未指定」と「空文字 = 明示クリア」が区別できない

#### 関連

- `src/lib/validators/task.ts` (createActivitySchema / updateTaskSchema 共に description を含む既存定義)
- `src/services/task.service.ts` (description は既に DTO + create + update で受理済み)
- 修正例: feat/ux-improvements-batch6 commit `21471cb` (2026-04-30, ACT 作業内容欄)

### 5.46 外部提供スクリプトの導入と既存 skill 統合パターン (PR #196 で確立)

#### 背景

ユーザから外部で開発した `security-check.ts` (CWE 観点静的解析ツール) と
`security-check-skill.md` (skill 定義) の 2 ファイルを受領。

「skill 定義は **既存定義（セキュリティチェック）に盛り込む形で**」という指示があり、
`.claude/skills/security-check.md` を新規作成する素朴アプローチは取らず、既存資産に統合した。

#### 採用した統合方針

1. **スクリプト本体**: `scripts/security-check.ts` に **verbatim** 配置 (ユーザ提供物の改変は別 PR)
2. **skill 定義の取り込み先 1**: `CLAUDE.md` §2 セキュリティチェック (4 層多層防御)
   - 第 5 層「静的スキャン (Script)」を **1 行サマリ** で追加 (CLAUDE.md 150 行制限)
   - 詳細手順は次の skill ファイルに委譲する形のリンク
3. **skill 定義の取り込み先 2**: `.claude/skills/threat-model.md` (既存セキュリティ skill)
   - description を「STRIDE + 静的スキャン」に拡張
   - 既存内容を「Mode A: STRIDE 実装前」、新規追加分を「Mode B: 既存コード静的スキャン 実装後」として **2 モード構成**に再編
   - Mode A/B の補完関係 (B Finding を A 表に逆流) を明記
4. **生成物の扱い**: `docs/security/security-report.html` / `SECURITY-TASKS.md` は **`.gitignore` で除外**
   (毎回再生成 + 時刻入りで commit 差分が無意味)
5. **出力ディレクトリ**: `docs/security/README.md` に実行方法のみ簡潔に書き、skill 文書との二重管理を避ける

#### 抽出したルール (今後の同種導入で適用)

- [ ] 外部提供スクリプトは **verbatim 配置**、改変が必要なら本 PR から分離する
- [ ] 新しい skill ファイルを作成する前に **既存 skill (`threat-model.md` 等) を拡張できないか** 検討する
  - 拡張のメリット: CLAUDE.md / skill 一覧の見通しが良い、関連概念の合体で発見性が上がる
  - 新規のメリット: 単一責任、命名検索しやすい (該当ない場合のみ採用)
- [ ] 自動生成ファイル (時刻入りレポート / 統計 / cache) は **必ず `.gitignore`**
- [ ] 出力先ディレクトリには `README.md` を置き、**実行方法 1 セクションのみ** 書く (skill との重複は厳禁)
- [ ] CLAUDE.md への追記は **1 行サマリ + skill リンク** に留める (150 行制限)
- [ ] 初回スキャン結果は PR description に記録 (本 PR の場合: 9 Finding / score 30/100)

#### 関連

- `scripts/security-check.ts` (本ツール本体)
- `docs/security/README.md` (出力先 + 実行方法)
- `.claude/skills/threat-model.md` Mode B (skill 定義本体)
- `CLAUDE.md` §2 (5 層多層防御の参照ポイント)
- 修正例: feat/security-check-script (PR #196, 2026-04-30)

### 5.47 PR 作成ワークフローへの security-check 統合と score 90+ 維持戦略 (PR #197 で確立)

#### 背景・狙い

PR #196 で `scripts/security-check.ts` を導入したが、**「いつ実行するか」が定まっていなかった**ため運用が回らない懸念があった。
ユーザ要望: 「**開発のたびに最新の脆弱性 / 攻撃手法情報を取得し、それらを 90% という高いスコアでサービスに盛り込み、退行ない状態を維持し続けたい**」。

これに応えるため、**全 PR 作成時に必須実行する 5 ステップワークフロー** を `.claude/skills/threat-model.md` Mode B-1 として定義した。

#### 採用した 5 ステップワークフロー

1. **既存レポート削除** (`rm -f docs/security/{SECURITY-TASKS.md,security-report.html}`) — 古いスナップショット混在防止
2. **scan 実行** (`pnpm tsx scripts/security-check.ts`)
3. **score 判定**
   - score >= 90: 修正不要、Step 4 へ
   - score < 90: SECURITY-TASKS.md を読み CRITICAL/HIGH 順に修正 → テスト追加 → 横展開 grep → re-scan → score >= 90 まで loop
4. **PR 作成** (`gh pr create`)
5. **PR コメントにスコアレポートを投稿** (`gh pr comment` で score / counts / 残存 Finding サマリを Markdown で)

詳細は `.claude/skills/threat-model.md` Mode B-1 セクション参照。

#### 設計判断 (なぜこの形か)

1. **GitHub Actions/CI ではなく Claude のフロー側に組み込んだ理由**:
   - `pnpm audit` は registry 通信が要 → CI 環境で安定実行できる
   - しかし「修正までする」のは Claude の責務 (CI は検出のみ)
   - 一旦 skill 化して回し、慣れた段階で CI gate に昇格する 2 段階で展開
2. **HTML を PR コメントに直接貼らない**: GitHub PR コメントは HTML 描画が部分的、また 65k 文字制限あり。**Markdown サマリ + ローカル実行案内**に絞る
3. **score 90 の意味**: 100 - 重大度別減点 × カテゴリ重複排除。HIGH 1 件で 88、MEDIUM 1 件は 94 → 「HIGH を全消し + MEDIUM 1 件まで許容」を意図する閾値
4. **score >= 90 でも残存 Finding は記録**: PR コメントに残すことで、reviewer が過去 PR と比較して退行を検知できる (本要望の中核)

#### スクリプト本体の継続更新 (Mode B-2)

「最新の脆弱性 / 攻撃手法情報」の自動取得は **`pnpm audit` (CVE DB) 経由のみ完全自動化**。CWE パターン検出は手動更新が必須。

トリガー:
- CWE Top 25 / OWASP Top 10 更新時 (年 1 回)
- インシデント発生時 (再発防止)
- 新ライブラリ導入時 (固有罠の検出追加)
- Claude が修正中に「同パターン横展開チェックすべき」と判断した時

各トリガーで `scripts/security-check.ts` に `checkXxx()` 関数を 1 件追加 = 1 PR の方針。

#### 抽出したルール (今後の同種運用)

- [ ] **PR 作成前に必ず Mode B-1 の 5 ステップを完走**
- [ ] **score < 90 の状態で PR を出さない** (修正してから出す、スコア退行 PR は reject 想定)
- [ ] PR description / コメントには **その PR 起点の score** を必ず明記
- [ ] スクリプト改変 PR (Mode B-2) は **1 check function = 1 PR** + CWE/OWASP リンク必須
- [ ] **`SECURITY-TASKS.md` を git に commit しない** (時刻入りで差分ノイズ + 過去スコアは PR コメントから参照)

#### 関連

- `.claude/skills/threat-model.md` Mode B-1 / Mode B-2 (本ワークフローの詳細手順)
- `CLAUDE.md` §2 (5 層多層防御に「PR 作成のたびに必須実行」を明記)
- §5.46 (前提となるツール導入経緯)
- 修正例: docs/security-check-pr-workflow (PR #197, 2026-04-30)
- 後続: 初回ブリングアップ (score 30 → 90+) は別 PR で実施予定

### 5.48 セキュリティスコア初回ブリングアップ (30 → 94) と CI Gate 化 (PR #198 で確立)

#### 背景・狙い

PR #197 で「PR 作成のたびに score >= 90」運用を skill 化したが、当時の **実スコアは 30/100** で運用に乗らない状態だった。
ユーザ要望: 「**閾値 90% に達していないとデプロイできないように仕組み化** + **既存機能のデグレは許されない**」。

これに応える PR #198 で score を 30 → 94 に引き上げ、CI で deploy gate を強制した。

#### 実施した修正 (デグレリスクを最小化する優先順位)

| 項目 | 対応 | 影響範囲 | デグレリスク |
|---|---|---|---|
| Script 雑音除去 | `src/generated/`, `node_modules`, `.next` を walker で除外 | スキャナのみ | なし |
| Accept-list 機構 | `.security-check-acceptlist.json` で「設計判断として受容」を分離 score 対象外に | スキャナのみ | なし |
| F-01 callbackUrl 検証 (CWE-601) | `src/lib/url-utils.ts` に `sanitizeCallbackUrl` 新設、`/login`, `/login/mfa` の 3 箇所で適用 | 認証画面 | **低** — 同一オリジン (`/path`) は通すので既存挙動と等価 |
| F-04 SameSite=Lax → Strict (CWE-1275) | `src/lib/auth.config.ts` の cookie option を変更 | セッション cookie | **低** — Credentials provider のみで OAuth コールバック無、メール内リンク (setup-password / reset-password) は遷移先で別認証セッション確立 |
| F-05 Rate limit (CWE-307) | `src/lib/rate-limit.ts` を新設 (in-memory, 5min/10req)、`/api/auth/{reset-password, setup-password, lock-status}` に適用 | 公開認証 API | **低** — 既存リクエストは閾値内、超過時のみ 429 |
| F-06 MFA 暗号鍵 (CRYPTO MEDIUM) | **本 PR では accept せず留保** (DB 上の既存暗号化シークレットの後方互換移行が必要なため別 PR) | 既存 MFA 利用者 | **高 (回避)** — dual-key 移行戦略を別 PR で計画 |
| F-07 CSP unsafe-inline | accept-list で受容 (Next.js + next-intl の SSR 制約、別 PR で nonce 化検討) | XSS 防御深さ | なし (frame-ancestors / X-Frame-Options で clickjacking は維持) |
| F-01/A-01 next-auth@beta | accept-list で受容 (公式 stable 未リリース) | なし | なし |

最終スコア: **94/100** (MEDIUM 1 = F-06 のみ残存)

#### CI Deploy Gate の仕組み (本 PR で実装)

1. `scripts/security-check.ts` に `--min-score=N` フラグ追加。score < 閾値で `process.exit(1)`
2. `.github/workflows/security.yml` に `security-score-gate` job を追加: `pnpm tsx scripts/security-check.ts --min-score=90`
3. PR レビュー時の Required status checks に追加することで、score 90 未満の PR をマージ不可にする運用 (リポ設定で個別有効化)
4. レポート (HTML + Markdown) は `actions/upload-artifact@v4` で 30 日保管

#### 設計判断 (なぜこの形か)

1. **Vercel serverless での in-memory rate limit の限界を承認**: instance ごとに bucket 独立 → 完全な分散制限ではない。**多層防御の 1 層** として機能、必要に応じて Upstash Redis に置換可能と明記 (`src/lib/rate-limit.ts` doc コメント)
2. **F-06 を別 PR にした理由**: MFA_ENCRYPTION_KEY 単独鍵化は **既存 DB の暗号化シークレットの decrypt 失敗** を起こす可能性がある。dual-key (新鍵で encrypt / 旧鍵 fallback で decrypt) → 全件 re-encrypt → 旧鍵廃止 の 3 段階移行が必要。本 PR の「デグレ禁止」要件と独立に扱うべき
3. **SameSite=Strict が安全な根拠**: 本サービスは Credentials provider のみ (OAuth/SSO のクロスサイトコールバック無)。メール内リンクからのトップレベル遷移先 (setup-password / reset-password) は遷移先で別途認証フローを通すため、'strict' でも UX 影響なし。`src/lib/auth.config.ts` の cookies コメントに記載
4. **CallbackUrl の defense-in-depth**: 受け取り時点 (`useSearchParams().get('callbackUrl')` 直後) と redirect 直前 (`window.location.href = ...`) の **両方** で `sanitizeCallbackUrl()` を呼ぶ。将来コードが書き換わっても回帰しない安全性を優先
5. **`security-score-gate` job を attack-matrix の `needs` に追加**: 既存の `secret-scan / pnpm-audit / semgrep / codeql` と並列に独立 job として実行し、攻撃種別マトリクスにも結果が反映される

#### 抽出したルール (今後の同種運用)

- [ ] **CRITICAL/HIGH を残したまま PR を出さない** (HIGH 1 件で 88 → ゲート不通)
- [ ] **既存暗号化データを伴う変更は dual-key migration で別 PR**: 鍵切替・hash アルゴリズム切替は単独 PR にする
- [ ] **accept-list は `until` (見直し期限) と `owner` を必須**: stable 公開や upstream 改善で外せるかを定期レビュー
- [ ] **rate-limit は閾値を保守的に**: 5min/10req が UX を壊さない確認 (リカバリーコード入力等の正常フローは 1 セッション内で 1〜2 回が想定)
- [ ] **defense-in-depth でも redirect 直前に必ず sanitize**: 変数の出所は時間とともに変わり得る

#### 関連

- §5.47 (PR 作成ワークフローと閾値設定の前提)
- §5.46 (security-check.ts 導入)
- `.security-check-acceptlist.json` (設計判断記録の単一ソース)
- `src/lib/url-utils.ts`, `src/lib/rate-limit.ts` (新規ライブラリ)
- 残課題: F-06 MFA 暗号鍵単独化は別 PR で dual-key 移行戦略つきで実施予定

### 5.49 ポリモーフィックコメント機能の確立 (PR #199)

#### 背景・狙い

7 エンティティ (Issue / Task / Risk / Retrospective / Knowledge / Customer / Stakeholder) の
編集 dialog に **同一 UI/UX のコメント** を載せたい。当初 PR-α で `RetrospectiveComment`
専用テーブルが導入されたが UI が未実装のまま温存されていた (旧 `retrospectives-client.tsx`
コメント参照: 「将来計画: 横ぐしのコメント機能」)。本 PR で実現する。

ユーザ要件 (Q1〜Q6):
- 全 7 エンティティ対象
- 旧 `RetrospectiveComment` を `Comment` に統合 (data migration あり)
- 投稿後の編集 / 削除あり (投稿者本人 + admin)
- 「全○○」では非 ProjectMember もコメント可
- 並び順は新しい順

#### 採用したパターン (Attachment と同形の polymorphic 関連)

```
model Comment {
  id, entityType, entityId, userId, content, createdAt, updatedAt, deletedAt
  @@index([entityType, entityId, deletedAt])
}
```

- 既存の `Attachment` モデル (PR #64) と **同じ polymorphic 設計を踏襲**。
  `entity_type + entity_id` で 1 テーブル × N エンティティ。FK は持たず、削除時整合は
  アプリ層で担保する (project.service.ts 参照: retrospective 削除時に
  `prisma.comment.deleteMany({ where: { entityType: 'retrospective', entityId: { in: ... } } })`)。
- `attachment.service.ts` の `resolveProjectIds` パターンを **`resolveEntityForComment` として
  踏襲**。ただし戻り値型を判別ユニオン (`{ kind: 'open' | 'project-scoped' | 'admin-only' | 'not-found' }`)
  にして、entity ごとに異なる認可ポリシーをコール側で switch できるようにした。

#### 認可ポリシー (entity 別)

| entityType | comment 投稿/閲覧 | 編集/削除 |
|---|---|---|
| `issue` / `risk` / `retrospective` / `knowledge` (全○○ あり) | 認証済ユーザは誰でも | 投稿者本人 OR admin |
| `task` / `stakeholder` (全○○ なし、project-scoped) | project member or admin | 同上 |
| `customer` (admin only) | admin のみ | 同上 |

**狙い**: 既存の attachment は `checkMembership` 必須だったが、コメントは「全○○」横断の
コミュニケーション促進が目的のため、要件 Q4 に従い **member 制約を意図的に緩和**した。
admin は常に介入可 (誤投稿 / 不適切コメントの管理削除)。

#### UI 配線パターン (7 dialog 共通)

- `<CommentSection>` コンポーネントを **`<fieldset disabled={readOnly}>` の外側** に配置。
  これにより全○○ の readOnly モードでもコメント投稿フォームは有効化される。
- 既存の `DialogAttachmentSection` の §5.14 由来「readOnly 時に非表示」とは挙動が異なる
  ことに注意 (attachment は member 必須 → 非表示、comment は誰でも可 → 常時表示)。
- **nested form 禁止**: PR #64 Phase B 要件 4 で確立した「外側 `<form>` 内に `<form>` を入れない」
  ルールを適用。CommentSection 内のボタンは全て `type="button"`、textarea は Ctrl/Meta+Enter で投稿。

#### Migration 戦略 (data migration 含む)

```sql
-- 1. 新 comments テーブル作成 + index
-- 2. 旧 retrospective_comments の全行を entity_type='retrospective' で INSERT
INSERT INTO comments (id, entity_type, entity_id, user_id, content, created_at, updated_at, deleted_at)
SELECT id, 'retrospective', retrospective_id, user_id, content, created_at, created_at, NULL
FROM retrospective_comments;
-- 3. 旧テーブル DROP
DROP TABLE retrospective_comments;
```

`updated_at` には `created_at` を入れて「未編集」状態にする (UI 側で `edited` 判定可能)。
本 migration は **本番手動適用必須** (§5.42 ルール)。PR description チェックリストで明示する。

#### 抽出したルール (今後の同種運用)

- [ ] **既存 polymorphic パターンがあるなら踏襲する** (本件は Attachment と同型)。新規発明より既存の
      `entity_type + entity_id` インデックス + 削除時整合のアプリ層担保パターンを使うこと
- [ ] **エンティティ別の認可ポリシーは判別ユニオンで返す**: bool フラグや null/[] の意味に依存
      させず、`{ kind: 'open' | 'project-scoped' | 'admin-only' | 'not-found' }` のように **意味を型に書く**
- [ ] **dialog の readOnly と新セクションの可視性は要件で決まる**: attachment は readOnly→非表示、
      comment は readOnly→投稿可。**§5.14 を機械的に踏襲しない** (要件側を必ず確認)
- [ ] **旧専用テーブルは現役 PR で `comments`/`Attachment` 等の polymorphic 系に統合**: 「廃止予定」
      で残すと将来の整合確保コストが増える (本 PR ではちょうど好機があったため統合)
- [ ] **CommentSection のような新規共通部品は最初から `data-testid` を持たせる**: 後付けで
      e2e/unit で対象を取るとき DOM 構造変更で壊れる (将来の test 横展開での再利用性)

#### 関連

- §5.14 (readOnly な edit dialog の fetch gating — 本件は **同パターンを取らない反例**: comment は readOnly でも投稿可)
- §5.35 (dialog 内 component の nested form 回避 — CommentSection もこの規約に従い type="button" + onKeyDown)
- §5.36 (dialog の readOnly 分岐パターン — fieldset disabled の外配置はこの設計の延長)
- §5.41 (○○一覧 共通 UI 部品の抽出規約 — 本件と同じ「7 entity 同形 UI」パターン)
- §5.42 (migration 含む PR は本番手動適用必須)
- E2E_LESSONS_LEARNED §4.49 (本件の配線時の罠 — readOnly 振る舞いの要件決定 / 認可判別ユニオンの罠)
- DESIGN.md §5.10 (comments テーブル定義)
- 旧専用テーブル経歴: `RetrospectiveComment` (PR-α 段階で UI 削除済 → PR #199 で廃止 + 統合)
- 修正例: `prisma/migrations/20260430_unified_comments/migration.sql` (data migration の参考実装)

### 5.50 Stop hook の重処理 / prompt 型を skill 化して開発速度を回復 (2026-05-01)

#### 背景・症状

`.claude/settings.json` の `Stop` hooks に以下 4 つが登録されており、**Claude が応答するたび** 毎回発火していた:

1. `secret-scan.sh` (軽量、機密漏洩防止) — 数秒
2. **`pnpm lint && pnpm test`** — **約 24 秒** (lint 13.9 s + test 9.95 s)
3. `auto-commit.sh` (dev/YYYY-MM-DD ブランチ + 変更ありの guard 済) — 即時
4. **`type: "prompt"` の 6 観点チェック (横展開 / セキュリティ / パフォーマンス / テスト / ドキュメント / KDD)** — LLM 1 往復消費

##### 起きた問題

質問応答や調査だけのターンでも毎回 24 秒 + LLM 1 往復が浪費される。さらに **prompt 型 hook は LLM 応答後に Stop が再発火** するため、6 観点チェック要求が毎ターン再注入され、ループ的に再表示されて実装が一切進まないターンが発生 (15 ターン以上の例あり)。

#### 採用した修正

**Stop hook を `secret-scan` + `auto-commit` のみに削減**し、品質ゲートは `/quality-check` skill (`.claude/skills/quality-check.md`) に集約:

| 修正項目 | Before | After |
|---|---|---|
| `Stop` hook の commands | 3 + prompt 1 = 4 ステップ | **secret-scan + auto-commit の 2 ステップ** |
| ターン毎の追加待ち時間 | 約 24 秒 + LLM 1 往復 | **<1 秒** |
| `pnpm lint && pnpm test` | Stop 毎ターン | **`/quality-check` skill で実装完了時のみ** |
| 6 観点チェック | Stop prompt で毎ターン LLM 再注入 | **`/quality-check` skill 内 Step 2 として明示実行時のみ** |

##### 「仕組みを崩さない」ための保証

- 6 観点チェック / lint / test の **内容は完全維持** (skill 側に丸ごと移行)
- `secret-scan` は Stop に残し、機密漏洩は常時防御
- `auto-commit.sh` の test 実行は内部で維持 (commit 前の安全網は機能継続)
- CI side (`.github/workflows/security.yml` の `security-score-gate` PR #198) でも品質ゲートが二重防御として機能

##### 新フロー (2026-05-01 以降)

```
[Claude が実装する]
  ├─ コード変更 ── PostToolUse の prettier 自動整形 (継続)
  ├─ 実装が一区切り ── /quality-check skill (新設) で lint + test + 6 観点
  └─ Claude 応答終了 ── Stop hook: secret-scan + auto-commit (軽量のみ)
```

#### 抽出したルール (今後の hook 設計)

- [ ] **`type: "prompt"` を Stop hook に登録しない**: 応答ごとに LLM 再注入が起きるため、ターン消費が発散する。条件分岐が必要なチェックは skill or PostToolUse + command 出力で行う
- [ ] **重い処理 (>5 秒) を Stop hook に置かない**: ユーザの自然な会話 (質問・調査) でも毎回課金される。実装完了タイミング限定で skill 化
- [ ] **「自動でやってほしい」と「毎ターン強制」は別物**: 自動化したい意図は理解できるが、Stop は応答頻度に等しい発火回数。**PR 単位 / コミット単位の品質ゲートは skill or CI に置く** のが正解
- [ ] **改修時はバックアップを残す**: `.claude/settings.json.backup-YYYYMMDD_HHMMSS` を作成 (元に戻せる安全網)
- [ ] **CLAUDE.md の運用フロー記述を skill 構成と同期**: hook 改修時に CLAUDE.md「開発中」セクションも併せて更新する (今回 §運用フロー / §知識駆動開発 の 2 箇所を更新)

#### 関連

- `.claude/skills/quality-check.md` (本改修で新設、6 観点 + lint + test の集約 skill)
- `.claude/settings.json` (Stop hooks を 2 step に削減)
- `.claude/settings.json.backup-20260501_*` (改修前バックアップ、元に戻したい時の参照)
- CLAUDE.md §運用フロー (新フローを反映済)
- E2E_LESSONS_LEARNED §4.49 / §5.49 (本改修と同じ「重実行を毎ターン強制しない」原則の前例)

### 5.51 公開範囲 (visibility) と認可マトリクスの統合 (PR fix/visibility-auth-matrix, 2026-05-01)

#### 背景・症状

ユーザが「課題一覧」から課題を**起票**したところ、Toast「課題を起票しました」は表示されたが**画面上一覧に反映されず**、Console エラーもない状態が発生。調査の結果、視覚的バグは一覧の filter ロジックの **設計選択ミス** だった。

##### 旧設計の問題

| 動作 | 旧仕様 |
|---|---|
| 起票時のデフォルト visibility | `'draft'` (慎重な公開を促す意図) |
| 「○○一覧」の表示 filter | 非 admin: `visibility='public'` のみ (**自分の draft も除外**) |
| 結果 | 自分が作った draft は **どこからも視認できない** (個別 URL を覚えていれば直接アクセス可だが、UI 上の導線なし) |

旧仕様コメント: 「2026-04-24: 自分の draft も一覧には出さない方針」 — 設計判断としては記録されていたが、Toast PR (#194) で「成功通知 + 一覧未反映」のミスマッチが目立つようになり、UX バグとして顕在化した。

#### 新設計 — 認可マトリクスを「経路で分けず」OR で統合

ユーザ確定スペックを API レベルで OR 統合した認可マトリクス:

##### Entity 認可 (visibility あり: issue / risk / retrospective / knowledge)

| 操作 | 認可式 |
|---|---|
| 一覧表示 (project-scoped) | `visibility='public'` OR (`visibility='draft'` AND createdBy=自分) OR admin |
| 一覧表示 (cross-list 「全○○」) | `visibility='public'` のみ (現状維持) |
| 個別参照 (GET) | public OR createdBy=自分 OR admin |
| 更新 | createdBy=自分 のみ (**admin 不可**) |
| 削除 | createdBy=自分 OR admin (admin は cross-list の「ゴミデータ削除」用) |

##### Comment 認可 (entity の visibility に連動)

| entity 状態 | コメント参照 | コメント投稿 |
|---|---|---|
| visibility='public' (issue/risk/retro/knowledge) | 認証済全アカウント | 認証済全アカウント |
| visibility='draft' (issue/risk/retro/knowledge) | **作成者本人 + admin** (admin は read のみ) | **作成者本人のみ** (admin は投稿不可) |
| task / stakeholder | project member or admin | 同左 |
| customer | admin のみ | admin のみ |

##### Comment 編集/削除

| 操作 | 認可式 |
|---|---|
| 編集 (PATCH) | コメント投稿者本人のみ (**admin も不可**、PR #199 から仕様変更) |
| 削除 (DELETE) | コメント投稿者本人のみ |
| Cascade (entity 削除) | entity 側の delete service が `prisma.comment.updateMany({...deletedAt})` で連動 soft-delete |

#### 実装変更点

| カテゴリ | ファイル | 変更内容 |
|---|---|---|
| list filter | `risk.service.ts` / `retrospective.service.ts` / `knowledge.service.ts` | where 句に `OR [{ public }, { draft, createdBy=viewer }]` を追加 |
| 個別 entity 削除 | 上記 + `task.service.ts` / `stakeholder.service.ts` / `customer.service.ts` | $transaction に `prisma.comment.updateMany({entityType, entityId, deletedAt:null})` を追加 (cascade soft-delete) |
| project 全体削除 | `project.service.ts` `deleteProjectCascade` | risk / issue / knowledge / task の cascade 物理削除に `prisma.comment.deleteMany` を追加 (retrospective は PR #199 で対応済) |
| comment 認可 (route) | `/api/comments/route.ts` | `authorizeForComment(user, entityType, entityId, mode)` に `mode='read'\|'write'` を追加。public-or-draft では visibility と creatorId を見て分岐 |
| comment 認可 (resolve) | `comment.service.ts` `resolveEntityForComment` | 戻り値型 `{kind:'open'}` → `{kind:'public-or-draft', visibility, creatorId}` に変更 (判別ユニオン拡張) |
| comment 編集/削除 | `/api/comments/[id]/route.ts` `canMutate` | `systemRole === 'admin'` の救済を削除、投稿者本人のみに |
| Comment 個別 cascade ヘルパ | `comment.service.ts` `softDeleteCommentsForEntity` | 新規エクスポート (将来の追加 entity でも再利用可) |

#### 抽出したルール (今後の同種設計)

- [ ] **list filter で「自分のもの」を必ず可視に** — 自分が起票したのに画面に出ないのは UX バグ。可視範囲は **「自分のもの + 他人で公開されているもの」** が常識的 default
- [ ] **「○○一覧」と「全○○」は経路ではなく viewer の権限と entity の状態で分岐** — UI 経路で API を分けると認可が二重に分散して保守不能になる
- [ ] **判別ユニオンを拡張するときは新しい discriminator 値を追加** (`'open'` → `'public-or-draft'`) — bool フラグ追加でなく型に意味を書く (PR #199 §5.49 の延長)
- [ ] **admin 救済は entity に対しては「削除のみ」、コメント本文に対しては「無し」**: コメントは投稿者の個人的発言なので admin が編集/削除する正当性が弱い。誤投稿は entity ごと cascade で消す仕組みに委ねる
- [ ] **cascade soft-delete は entity の $transaction に並列で並べる** — `attachment.updateMany` / `comment.updateMany` を同 transaction に置けば atomic に削除できる
- [ ] **deletedAt=null フィルタはコメント検索の主索引と一致** (`idx_comments_entity (entity_type, entity_id, deleted_at)`) — cascade 後の一覧 query は自動で空になる

#### 関連

- PR #199 §5.49 (polymorphic comment + 判別ユニオン認可の前例)
- §5.41 (○○一覧 共通 UI 部品の抽出規約)
- E2E_LESSONS_LEARNED §4.50 (本仕様で確立した「list filter で自己起票が見えなくなるアンチパターン」の罠)
- DESIGN.md §5.10 (comments テーブル定義 + 認可マトリクス追記)
- 修正例: `src/services/comment.service.ts` `resolveEntityForComment` (visibility 連動の判別ユニオン)

### 5.52 バッチ API の lenient validation 設計 (PR fix/attachments-batch-400, 2026-05-01)

#### 背景・症状

ユーザレポート: 「何かデータを更新しようとしたとき、Vercel ログに `/api/attachments/batch` で StatusCode:400 が出力された」。
原因不明のまま log だけが流れ、具体的な拒否理由は記録されていなかった。

#### 旧設計の問題

```ts
// 旧: bodySchema で entityIds 全件に z.string().uuid() を要求
const bodySchema = z.object({
  entityType: z.enum(ATTACHMENT_ENTITY_TYPES),
  entityIds: z.array(z.string().uuid()).max(500),
  slot: z.string().max(30).optional(),
});
const parsed = bodySchema.safeParse(body);
if (!parsed.success) {
  return NextResponse.json({ error: ... }, { status: 400 });
}
```

問題点:

1. **All-or-nothing 失敗**: entityIds に **1 つでも非 UUID** が混じると **バッチ全体が 400 で破棄**。
   一覧画面では正常な行の添付列も表示できなくなる
2. **拒否理由が log に残らない**: Vercel log は status code のみで、どの field が rejected か不明
3. **UI 側の誘発要因**: 起票直後の optimistic UI / staging ID / 空文字 / null など、
   一時的な non-UUID 値が混じる可能性が複数経路で存在する

#### 新設計 — 「lenient body + 厳格 header + 構造化エラーログ」

```ts
// header (entityType / slot) は厳格 — UI 固定値、ミスマッチは即 400 で OK
const headerSchema = z.object({
  entityType: z.enum(ATTACHMENT_ENTITY_TYPES),
  slot: z.string().max(30).optional(),
});

// entityIds は lenient — 配列でない / 非 UUID 要素は filter して有効分のみ処理
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const rawIds = Array.isArray(body.entityIds) ? body.entityIds : [];
const entityIds = rawIds.filter((id) => typeof id === 'string' && UUID_RE.test(id)).slice(0, 500);

if (rawIds.length !== entityIds.length) {
  void recordError({ severity: 'info', source: 'server', message: 'filtered N/M invalid', ... });
}
```

##### 採用したパターンの 3 軸

| 軸 | 採用 | 理由 |
|---|---|---|
| **header / body の validation 厳しさを分離** | header 厳格 + body lenient | UI 固定値 (entityType) は契約として厳格。動的データ (entityIds) は環境要因で揺れる |
| **lenient フィルタは黙って切り捨てて 200** | yes | バッチ API は「ベストエフォート」セマンティクス。一部失敗で全体を破棄しない |
| **拒否は `recordError` で system_error_logs に構造化記録** | yes | `console.*` は no-console rule で禁止 + Vercel log は status のみ。DB に context 付きで残せば後追い分析可能 |

##### クライアント側でも同じ UUID 正規表現で事前フィルタ

`src/components/attachments/use-batch-attachments.ts`:

```ts
const validIds = useMemo(
  () => entityIds.filter((id) => typeof id === 'string' && UUID_RE.test(id)),
  [entityIds],
);
```

二重防御 (clean defense): クライアント側でも事前 filter することで、無駄な 400 ラウンドトリップを減らし、Vercel log のノイズも減らす。サーバ側は最終防壁として fallback を残す。

#### 抽出したルール (今後の同種 API)

- [ ] **「ベストエフォート」セマンティクスの API は body を lenient に**: 配列受信系 API は 1 件失敗で全体破棄しない。1 件失敗 → filter で除外 + ログ + 続行
- [ ] **header (固定値) は厳格 / body (動的データ) は lenient** という validation 二層構造を default にする
- [ ] **`console.*` を直接使わず `recordError` で system_error_logs に書く** (no-console rule + 構造化検索可能)
- [ ] **クライアント側でも事前 filter** (`useMemo` + 正規表現) で無駄なラウンドトリップを減らす
- [ ] **UUID 正規表現は server / client で同じ定数を使う** (将来的には `src/lib/validators/uuid.ts` 等に共通化候補 — 本 PR では route + hook の 2 箇所、3 箇所目が出たら抽出)
- [ ] **lenient フィルタの発動は info ログで残す**: 頻発する場合は呼出側のバグなので可視化しないと原因不明のまま放置される

#### 関連

- §5.51 (visibility 認可マトリクス — 同じく list 系 API の堅牢性パターン)
- DESIGN.md §22 / `src/services/error-log.service.ts` (`recordError` の使い方)
- E2E_LESSONS_LEARNED §4.51 (本件の Vercel log 解析の罠 / status code のみで原因不明だった経緯)
- 修正例: `src/app/api/attachments/batch/route.ts` (lenient + recordError パターンの参考実装)
- 関連 PR: #67 (本 API の初出) / #115 (IDOR 対策の認可強化)

### 5.53 一覧テーブルの sticky thead 横展開パターン (PR feat/sticky-table-headers, 2026-05-01)

#### 背景・要件

「○○一覧」「全○○」全画面で **Excel 風のヘッダー固定** を実現する要望。縦スクロール時に
`<thead>` の列ヘッダーが viewport 上端に貼り付き、データ行のみがスクロールする UX。

#### 採用したパターン

##### 1 箇所修正で全画面に伝播 (DRY 原則)

**共通 `<TableHeader>` コンポーネント** (`src/components/ui/table.tsx`) を 1 箇所修正するだけで、
これを使用する全 17+ 一覧画面に sticky 動作が自動的に伝播する。`cn()` (clsx + tailwind-merge)
を経由しているため、呼び出し側で `className` 上書きしても安全に共存。

```tsx
function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      className={cn(
        // sticky top-0: viewport 上端に固定
        // bg-card: 下行が透けないため必須
        // [&>tr>th]:bg-card: 一部ブラウザで thead 単独 bg が効かない場合の二重指定
        // z-10: dropdown / Toast / Dialog overlay (z-50) より下、行内の他要素より上
        "sticky top-0 z-10 bg-card [&>tr>th]:bg-card [&_tr]:border-b",
        className,
      )}
      {...props}
    />
  );
}
```

##### 2. raw `<thead>` を使う特殊画面の横展開

`<TableHeader>` を経由せず raw HTML `<thead>` を使う 3 箇所も個別に修正:

| ファイル | 場所 | 理由 |
|---|---|---|
| `app/(dashboard)/my-tasks/my-tasks-client.tsx` | `/my-tasks` (個人タスク一覧) | 独自 layout で raw thead |
| `app/(dashboard)/projects/[projectId]/tasks/tasks-client.tsx` | WBS 一覧 | 既存 `bg-muted` を維持 |
| `components/ui/responsive-table.tsx` | `ResponsiveTable` 共通部品 | md+ 用テーブル DOM の thead |

##### 3. 横展開チェック方法 (再発防止)

```bash
# raw thead が新規追加されていないか確認
grep -rn "<thead" src/app src/components | grep -v "test\." | grep -v "sticky"
```

検出結果が空であれば横展開漏れなし。新規追加時は **`<TableHeader>` を使うか、sticky クラスを明示** する。

#### 設計判断のポイント

1. **ページ全体スクロール vs 内部スクロール**: 既存設計はページ全体スクロール (`<main>` に max-h なし)。
   sticky は viewport 基準で動作 → DashboardHeader (非 sticky) がスクロールアウトしたあとに
   thead が viewport 上端を取る挙動。Excel に近い。
2. **`overflow-x-auto` との両立**: 共通 `Table` の wrapper は `overflow-x-auto` を持つが、
   実装上はモダンブラウザで sticky と両立する (Chrome 91+/Firefox 59+/Safari 14+)。
3. **bg 二重指定の理由**: 一部古いブラウザ (Safari 13 以前等) で thead 単独の background が
   効かないバグへの保険。`[&>tr>th]:bg-card` を併記して各 th セルにも背景色を設定。
4. **z-10 の選定**: Dialog overlay / Toast / dropdown は z-50 で動くため、それより下に固定。
   行内のリンクや tooltip より上にする。

#### 抽出したルール (今後の同種 UI)

- [ ] **共通 UI コンポーネントを 1 箇所修正で N 画面に伝播させる** が最優先 — raw HTML を使う
      特殊画面は個別対応で残務化、grep で再発防止
- [ ] **sticky element には必ず bg を入れる**: 透過すると「下行が透けてヘッダーが読めない」事故
- [ ] **z-index は既存の z-50 (Dialog/Toast) より低い値で固定** (z-10 推奨): モーダル系 UI に
      ヘッダーが被ると操作不能になる
- [ ] **`<TableHeader>` を経由しない raw `<thead>` の grep を CI 候補に**: 新規追加時の漏れ検出

#### 関連

- §5.41 (○○一覧 共通 UI 部品の抽出規約)
- DESIGN.md §3.3 (DRY 原則)
- 修正例: `src/components/ui/table.tsx` (共通部品 1 箇所修正、全 17+ 画面に伝播)
- 関連 raw thead: `my-tasks-client.tsx` / `tasks-client.tsx` / `responsive-table.tsx`

### 5.54 アプリ内通知機能 (in-app notifications) の MVP 実装 (PR feat/notifications-mvp, 2026-05-01)

#### 背景・要件

ユーザ要望: 画面右上 (アカウント名の左) に通知ベルを設置。完全無料 (アプリ内のみ、メール/push 不使用)。MVP は ACT の予定日リマインダ 2 種:

- **開始通知**: ACT で `status='not_started'` AND `plannedStartDate=today (JST)` AND `assigneeId IS NOT NULL`
- **終了通知**: ACT で `status≠'completed'` AND `plannedEndDate=today (JST)` AND `assigneeId IS NOT NULL`

将来 @mention 等への拡張余地ありの polymorphic 設計。

#### 採用したパターン

##### 1. polymorphic な `Notification` テーブル (Comment / Attachment と同形)

```prisma
model Notification {
  id, userId, type, entityType, entityId, title, link, dedupeKey, readAt, createdAt
  @@unique([dedupeKey])
  @@index([userId, readAt, createdAt(sort: Desc)])
}
```

`type` (例: `task_start_due`) と `entityType` (例: `task`) の 2 軸で polymorphic 拡張可。
`dedupeKey` の UNIQUE 制約で「同タスク × 同種別 × 同日」の 2 重生成を **DB レベルで** 弾く。

##### 2. flat query + partial index で全タスク seq scan 回避

cron が叩く query は階層 traversal 不要 (ACT のみ対象):

```ts
prisma.task.findMany({
  where: {
    type: 'activity', deletedAt: null, assigneeId: { not: null },
    status: 'not_started', plannedStartDate: today,  // 開始通知
  },
});
```

ユーザの「**WBS の階層構造で再帰探索しないように細心の注意**」要望に対応するため、partial index 2 本を追加:

```sql
CREATE INDEX idx_tasks_planned_start_due ON tasks (planned_start_date)
  WHERE deleted_at IS NULL AND type = 'activity'
    AND assignee_id IS NOT NULL AND status = 'not_started';

CREATE INDEX idx_tasks_planned_end_due ON tasks (planned_end_date)
  WHERE deleted_at IS NULL AND type = 'activity'
    AND assignee_id IS NOT NULL AND status <> 'completed';
```

partial index は **WHERE 条件に合致するレコードだけ** インデックス化するため、ACT 以外や担当者 null は
インデックスに入らず、サイズが本体の 1/3 以下に抑えられる。1 日の対象タスク数 (数十〜数百) を index range scan で
直接拾えるので、表サイズが N 万行に増えても query 時間は ms 単位で固定。

##### 3. JST 境界の TZ 処理

cron は UTC 動作 (`0 22 * * *` = JST 翌日 7:00) のため、`new Date()` をそのまま使うと「UTC の今日」になり 2026-05-02 を期待しているのに 2026-05-01 を取得する事故が起きる。

**`todayInJst(now: Date)` ヘルパ** を notification.service に新設し、UTC → JST のオフセット (+9h) を適用してから date 部分のみ抽出:

```ts
export function todayInJst(now = new Date()): Date {
  const jstMillis = now.getTime() + 9 * 60 * 60 * 1000;
  const jst = new Date(jstMillis);
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()));
}
```

単体テストで境界 (UTC 14:59 / 15:00) を検証して退行を防ぐ。

##### 4. cron 認可は `Bearer ${CRON_SECRET}` 統一

既存 `lock-inactive` cron と同方式。`process.env.CRON_SECRET` 未設定時は **fail-closed** (401) で即時拒否、運用ミスで認証経路が無防備になることを防ぐ。

##### 5. UI: ベル UI の polling 戦略

- 開いている間: **30 秒** polling (リアクティブ性を確保)
- 閉じている間: **5 分** polling (バッテリー / Vercel function 実行時間配慮)

WebSocket / SSE は Vercel serverless でコスト面で不向きのため polling で十分判断。

#### 抽出したルール (今後の通知系拡張)

- [ ] **新通知 type を追加するときは validators/notification.ts の `NOTIFICATION_TYPES` に追記**: 型安全に拡張する単一箇所
- [ ] **dedupeKey の形式は `{type}:{entityId}:{YYYY-MM-DD}` 等で時間粒度を必ず含める**: 同一トリガが同日に 2 回作られないよう DB UNIQUE で弾く設計を継承
- [ ] **cron 関連は flat query + partial index** で seq scan を避ける: WBS 階層探索を必要としない設計に分解
- [ ] **TZ 境界は `todayInJst` を経由**: cron が UTC 動作する事実を service 関数で吸収、テストで境界 (14:59/15:00) を必ず検証
- [ ] **cron 認可は `CRON_SECRET` 未設定で fail-closed**: 運用ミスでオープン状態にならないよう、existence チェック → 一致チェックの順
- [ ] **UI polling は open 状態で 30 秒、閉じている間 5 分** がベース指針 (リアクティブ性 vs コスト)

#### 関連

- §5.49 (polymorphic Comment テーブル — 本件と同パターン)
- §5.42 (migration 本番手動適用ルール — 本件もこれに従う)
- DESIGN.md §通知 (認可マトリクス + cron schedule)
- OPERATION.md §cron (CRON_SECRET 設定手順、JST 7:00 実行)
- 修正例: `src/services/notification.service.ts` `todayInJst` / `generateDailyNotifications`
- 関連 PR: #199 (polymorphic Comment) / `lock-inactive` cron (認可パターン)

### 5.55 sticky thead と readOnly 添付セクションの hotfix (PR fix/sticky-and-readonly-links, 2026-05-01)

PR #204 (sticky table headers) で「ヘッダーが固定されない」報告 + 全○○ 編集 dialog で「参考リンクが見えない」報告が同時に上がり、両方を 1 PR で修正した。共通因子は **「PR #204 の sticky 設計が不完全だった」+「PR #199 で確立した §5.14 readOnly 非表示パターンを cross-list で機械的に踏襲しすぎていた」**。

#### 症状 1: sticky thead が効かない

PR #204 では共通 `<TableHeader>` に `sticky top-0 bg-card` を追加したが、**親 wrapper が `overflow-x-auto` を持つため scrolling 動作しない** 構造だった。

##### 根本原因 (CSS 仕様の罠)

`overflow-x: auto` (片軸指定) は、CSS 仕様上 **両軸ともスクロールコンテナ化** する ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/overflow#description) "if overflow is mixed (one auto, one visible) then visible behaves as auto")。

つまり共通 Table の wrapper:
```tsx
<div className="relative w-full overflow-x-auto">  ← 両軸 auto 扱い、scrolling container
  <table>
    <thead className="sticky top-0">  ← wrapper に対して sticky
```

→ 1) wrapper はスクロールコンテナ。2) wrapper には `max-height` が無いので **垂直方向にスクロールしない**。3) sticky thead は「スクロールしない wrapper」に対して固定 → 何も起きない。4) ページ自体がスクロールすると wrapper ごと流れていく → thead も流れる。

##### 修正

wrapper に `max-h-[calc(100vh-12rem)]` + `overflow-auto` を追加し **真の縦スクロールコンテナ化**:

```tsx
<div className="relative w-full max-h-[calc(100vh-12rem)] overflow-auto">
  <table>
    <thead className="sticky top-0 z-10 bg-card"> ← wrapper 内で正常 sticky
```

`12rem` の根拠: DashboardHeader (3.5rem) + main padding (3rem) + 余白 (5.5rem)。テーブル外側のフィルタ/見出し領域はそのままページ内で残るが、テーブル領域内ではデータ行のみがスクロール、thead は固定 = **Excel 風 UX**。

WBS 一覧 (`tasks-client.tsx`) の raw `<thead>` 親 wrapper も同パターンで `max-h` を追加。my-tasks / responsive-table は `overflow` wrapper を持たないため fix 不要。

#### 症状 2: 全○○ 編集 dialog で 参考リンク が見えない

##### 根本原因 (§5.14 を機械的に踏襲)

`DialogAttachmentSection` は §5.14 (`fix/attachment-list-non-member-403`) で確立した「readOnly なら `return null`」パターンに従っていた:

```tsx
if (readOnly) return null;  // ← 旧仕様
```

§5.14 の元来の理由: 非メンバーが全○○ から開いた dialog で `/api/attachments` が 403 を返し Console エラー。だが **2026-04-27 (`fix/cross-list-non-member-columns`) で全○○ public エンティティの添付閲覧は非メンバーでも許可済** で、403 経路は既に解消されていた。にもかかわらず DialogAttachmentSection の return-null パターンだけが残置 = **stale な防御コードがユーザに見せるべき情報を隠していた**。

##### 修正

`canEdit={!readOnly}` に変更:

```tsx
// 新仕様
const canEdit = !readOnly;
return (
  <>
    {source && <SingleUrlField canEdit={canEdit} ... />}
    <AttachmentList canEdit={canEdit} ... />
  </>
);
```

`AttachmentList` / `SingleUrlField` は `canEdit={false}` で **読み取り専用表示** (リンク一覧は見える、追加/編集/削除 UI のみ非表示) を既にサポートしていたため、props を反転させるだけで対応完了。

#### 抽出したルール (再発防止)

- [ ] **`overflow-{x|y}-auto` を片軸だけ指定するときは `max-h` も合わせて設定**: 仕様上 visible→auto 変換が起きてもう片軸もスクロールコンテナになるため、sticky を中に置くなら必ず max-h で実スクロールを発生させる
- [ ] **「sticky が効かない」を見たら最初に親 wrapper の overflow / max-height を疑う**: CSS sticky の "scrolling ancestor" 解決ロジックは仕様が複雑、開発者ツールで動作中の scroll-clipping 親要素を確認する習慣をつける
- [ ] **過去の防御コード (return null / stub 等) が **依然有効か定期的に再評価**: 今回の §5.14 のように、根本原因が解消された後も防御コードだけ残ると、副作用で別のユーザ体験を壊す
- [ ] **「○○一覧と全○○で同じ dialog を再利用するときは readOnly の振る舞いを必ず確認**: data 編集と参考リンク表示は別軸の権限。readOnly は data 編集のみを止めるべきで、表示まで止めない設計が正しい (§5.49 でも同じ判断、E2E §4.49 1 番目の罠と同根)

#### 関連

- §5.14 (`fix/attachment-list-non-member-403` — 旧仕様の根拠、本 PR で前提が変わった)
- §5.49 / E2E §4.49 1 (readOnly を機械的に踏襲しない、本件は同じ系統の問題)
- §5.53 (PR #204 sticky thead — 本 PR で修正対象になった旧版)
- §5.41 (○○一覧 共通 UI 部品の抽出規約 — DRY 原則: 1 箇所修正で全画面伝播)
- 修正例: `src/components/ui/table.tsx` / `src/components/common/dialog-attachment-section.tsx`

---

### 5.56 コメントの @mention 機能 (PR feat/comment-mentions, 2026-05-01)

PR #205 (通知 MVP) で確立した polymorphic Notification 基盤の上に、**コメント本文の @mention** を追加。完全アプリ内通知のため追加コストは無し。
ユーザ要件 (Q1〜Q5):
- Q1: @ トリガ補完 UI (Slack/GitHub 風)
- Q2: 編集時は **追加分のみ** 通知 (削除分は何もしない)
- Q3: WBS で「全アカウント」をメンションしようとしても UI で隠す + サーバ側でも validation
- Q4: グループメンション `@all` 等は token のまま、配信時に展開
- Q5: 自分自身を mention しても通知しない

#### 採用したパターン

##### 1. Mention テーブル + Comment との cascade 削除

```prisma
model Mention {
  id, commentId (CASCADE delete), kind, targetUserId?, createdAt
  @@index([commentId])
}
```

mention は **コメントと一蓮托生** (コメント削除で物理削除) のため `onDelete: Cascade` を設定。

##### 2. kind 判別ユニオン (PR #199 §5.49 と同パターン)

```ts
type MentionKind = 'user' | 'all' | 'project_member'
                 | 'role_pm_tl' | 'role_general' | 'role_viewer'
                 | 'assignee';
```

`kind='user'` のみ `targetUserId` 必須、それ以外は配信時に動的展開。

##### 3. entityType 別の許容 kind (Q3 サーバ側 enforce)

| entity | 許容 kind |
|---|---|
| issue / risk / retrospective / knowledge | 全 kind (all 含む) |
| task / stakeholder | all 以外 (project スコープのため) |
| customer | user のみ (admin 専用エンティティ) |

UI 側でも同マトリクスでタブを出し分けるが、サーバ側で **二重防御** で必ず enforce する。

##### 4. context 概念の導入 (UI 経路ヒント)

「○○一覧」と「全○○」は同じ entity に対する access path が違うだけ。サーバ側 validation はもとから entityType ベースで OK だが、**UI のタブ表示は経路で変える** ためクライアントが `context` パラメータを送る:

```ts
function detectMentionContext(pathname: string): 'wbs' | 'project_list' | 'cross_list' {
  if (/^\/projects\/[^/]+\/tasks/.test(pathname)) return 'wbs';
  if (/^\/projects\/[^/]+/.test(pathname)) return 'project_list';
  return 'cross_list';
}
```

候補 API 側で context フィルタを追加掛けする (cross_list なら `all` / `assignee` のみ等)。

##### 5. 配信フロー (即時、cron 経由しない)

```
[ユーザがコメント投稿]
  └─ POST /api/comments (mentions[] を含む)
        ├─ サーバ側 validateMentionsForEntity (Q3 二重防御)
        ├─ Comment 作成
        ├─ Mention 一括 createMany
        └─ generateMentionNotifications で expandMention → recipient set 化 → Notification createMany (skipDuplicates)
              ※ dedupeKey = `comment_mention:${commentId}:${userId}` で 2 重通知防止
              ※ 投稿者本人 (Q5) は recipients から除外
```

##### 6. 編集時の差分処理 (Q2)

`mentionKey = ${kind}:${targetUserId ?? ''}` で同一性判定し、`diffMentions` で added/removedIds を算出。`updateComment` は added の通知のみ生成、removed は DB から削除するだけで通知なし。

##### 7. UI: @ トリガ補完 (Q1)

- カーソル直前の `@partial` を Unicode 対応正規表現 (`/(?:^|\s)@([\p{L}\p{N}_-]*)$/u`) で検出 (日本語名対応)
- debounced fetch (250ms) で `/api/mention-candidates`
- 候補クリック → `@partial` を `@<label> ` で置換 + mentions 配列に push
- group メンション (`@all` 等) と user メンション (`@<name>`) を同 dropdown に並べる

#### 抽出したルール (今後の同種拡張)

- [ ] **kind 判別ユニオンを拡張するときは `MENTION_KINDS` enum と `getAllowedMentionKinds` の両方を更新**: 単一箇所追加で型安全
- [ ] **server / UI で同じ許容マトリクスを enforce** (二重防御): UI のタブ隠蔽だけだと CLI / 直接 POST で抜けられる
- [ ] **dedupeKey は `comment_mention:${commentId}:${userId}` 形式**: 同一コメントに同一ユーザの 2 重通知を DB UNIQUE で弾く
- [ ] **Q5 自分宛除外は service 層で実施**: route 層で漏らすと将来別経路 (例: cron 配信) で抜ける
- [ ] **編集時は追加分のみ通知** (Q2): 削除分の通知は意味がない (受信側で消えても通知が残ると混乱)
- [ ] **context は UI ヒント、サーバ側は entityType ベース**: ○○一覧 / 全○○ の区別は path だけ、entity は同じ。サーバ側 validation を context 依存にすると security hole になる

#### 関連

- §5.49 (polymorphic Comment + 判別ユニオン認可 — 本件は同パターンの mention 拡張)
- §5.54 (PR #205 通知 MVP — 本件は通知の trigger 追加形式)
- §5.51 (visibility 認可マトリクス — 本件 Q3 の WBS 制約と同源)
- DESIGN.md §8.3.4 (mention 認可マトリクス)
- 修正例: `src/services/mention.service.ts` (kind 展開 + diff + 通知生成)

### 5.57 一覧画面 UX クリーンアップ + テキストフィルタの否定条件 (PR fix/list-export-and-filter, 2026-05-01)

ユーザレポート 3 件を 1 PR で対応:

#### Task 1: エクスポートボタンのラベル統一

旧仕様で 5 entity (task / risk / retro / knowledge / memo) の `syncExport` キーがバラバラに「上書き用 N 列」のような実装詳細を含んでいた。**一律「エクスポート」に統一**。csvFormatHint の参照テキストも合わせて更新。

旧:
```json
{ "syncExport": "WBSをエクスポート(上書き用)" }
{ "syncExport": "エクスポート (上書き用 16 列)" }
```

新: 全て `"syncExport": "エクスポート"`

#### Task 2: ナレッジ一覧のボタン位置を他一覧と揃える

ナレッジ一覧だけ:
- `justify-between` で count 表示 (`{N} 件`) が左、ボタン群が右
- ボタンが `size="sm"` で他より小さい

他一覧 (risks / retrospectives 等) はすべて `justify-end` + ボタン既定サイズ。**ナレッジを他一覧パターンに揃える** ことで一貫性回復。`countUnit` 表示は他一覧では持っていなかったので削除 (UI 簡素化、件数は一括選択ツールバーで間接的に確認可)。

#### Task 3: テキストフィルタに否定条件追加 (`-` プレフィックス)

旧仕様 (`splitKeywordTokens` + `matchesAnyKeyword`):
- 「ログイン エラー」 → 「ログイン」 OR 「エラー」を含むレコード

新仕様 (Google 検索風):
- 「重要 -完了」 → 「重要」を含み、「完了」を含まない レコード
- 「-完了」 → 「完了」を含まない レコード (negative-only)
- 「重要 緊急 -完了 -キャンセル」 → (重要 OR 緊急) AND NOT (完了 OR キャンセル)

実装 (新関数 `splitPositiveNegativeTokens`):

```ts
// `-` プレフィックスで positive / negative に分離
function splitPositiveNegativeTokens(query: string): { positive: string[]; negative: string[] } {
  const tokens = splitKeywordTokens(query);
  // ... `-foo` → negative に追加 (先頭の `-` を除去)
  // 単独の `-` は無視
}

function matchesAnyKeyword(query, fields): boolean {
  const { positive, negative } = splitPositiveNegativeTokens(query);
  // 1. 空クエリ → true
  // 2. negative がいずれかの field にヒット → false (除外)
  // 3. positive 無し → 通過
  // 4. positive のいずれかが field にヒット → true (OR)
}
```

`matchesAnyKeyword` の関数名は backward-compat のため保持。既存 callers は変更不要。新規テスト 10 件で positive-only / negative-only / 混在 / 複数 negative を網羅。

#### 抽出したルール

- [ ] **i18n キーの値に「実装詳細」を漏らさない**: 「上書き用 16 列」のような列数や用途は実装変動で陳腐化する。ラベルは UX 上の役割 (「エクスポート」) だけにする
- [ ] **○○一覧の UI 共通化を保つ**: `flex justify-end` + ボタン既定サイズ + count 非表示 が他一覧パターン。新規一覧追加時は同パターンを踏襲する (DRY 原則 / §5.41 の延長)
- [ ] **検索の拡張は「Google 検索風」が UX 学習コスト最小**: 既存ユーザの直感に合う syntax (`-` 否定 / 空白 OR) を採用、独自 syntax を作らない
- [ ] **Backward-compat を保ちつつ新仕様を加える時は関数名を据え置く**: `matchesAnyKeyword` は名前は OR を示唆するが、negation 拡張も含む。callers の影響ゼロを優先

#### 関連

- §5.41 (○○一覧 共通 UI 部品の抽出規約 — 本件 Task 2 の根拠)
- Phase C 要件 19 (空白区切り OR 検索 — 本件 Task 3 の前身)
- 修正例: `src/lib/text-search.ts` (negation 拡張)

### 5.58 一覧画面のカラムソート機能 横展開 (PR feat/sortable-columns, 2026-05-01)

#### 背景・要件

ユーザ要望: 「○○一覧」「全○○」全画面で **列ヘッダクリックでソート** したい。WBS (タスク階層) は階層構造があるため対象外。Q4-1〜Q4-5 で確定した仕様:

- Q4-1: WBS は対象外 (階層を崩さないため)
- Q4-2: チェックボックス・操作・添付列を除く全列ソート可
- Q4-3: 永続化は `sessionStorage` (タブを閉じるまで保持、ユーザ間で共有しない)
- Q4-4: 既定ソートは既存の `orderBy` (例: `createdAt DESC`) を保つ
- Q4-5: バッジ表示で複数列の優先度を可視化 (↑¹ ↓²)

#### 採用したパターン

##### 3 層構造の責務分離

| 層 | ファイル | 責務 |
|---|---|---|
| 純関数 | `src/lib/multi-sort.ts` | `applySort` / `getColumnSort` / `multiSort` の比較ロジック (テスト容易) |
| state hook | `src/components/sort/use-multi-sort.ts` | sessionStorage への load/save + `setSortColumn` |
| UI 部品 | `src/components/sort/sortable-header.tsx` | 列ヘッダ内のドロップダウン (昇順/降順/クリア) + バッジ表示 |
| 統合 | `src/components/sort/sortable-resizable-head.tsx` | `ResizableHead` + `SortableHeader` のショートカット (`columnKey` 重複指定を回避) |

##### `SortState` 配列が「優先度順」を表現

```ts
export type SortEntry = { columnKey: string; direction: 'asc' | 'desc' };
export type SortState = SortEntry[]; // index 0 が最優先
```

`applySort` は:
- 既存列の方向変更 → in-place 更新 (優先度維持)
- 新規列追加 → 末尾に追加 (低優先度)
- `clear` → 配列から除外

これによりユーザが「最初に title asc、次に priority desc」を選んだ順がそのままソート優先度になる (Q4-5 仕様)。

##### 値の比較規則 (`compareValues`)

- `null / undefined / 空文字` は **direction に関わらず末尾**: 昇順でも降順でも空欄は最下段に置く方が UX が安定。
- 数値 / Date / boolean はそれぞれ自然比較。
- 文字列は `localeCompare('ja', { numeric: true, sensitivity: 'base' })` で日本語混在 + 数字混在 (foo2 < foo10) を自然順に。

##### 横展開の手順 (12 画面)

1. **`ResizableHead` を使う一覧 (9 画面)**: `<SortableResizableHead columnKey=... defaultWidth=... label=... sortState=... onSortChange=... />` に置換。`attachments` / `actions` / `select` (チェックボックス) 列は **そのまま `ResizableHead`** で残す (sort 対象外)。
2. **plain `TableHead` を使う一覧 (customers / admin/users)**: `<TableHead><SortableHeader ... /></TableHead>` パターン。
3. **server component の一覧 (admin/audit-logs / admin/role-changes)**: テーブル部分を client component (`*-table.tsx`) に切り出して page.tsx は server fetch + 整形 → client component に渡す。`formatDateTimeFull` は session TZ 参照で server 側でしか動かないので **整形済 string と ISO 文字列を両方渡す** (display 用と sort 用を分離)。
4. **WBS (`tasks-client.tsx`)**: 対象外 (Q4-1)。階層構造が崩れるため。
5. **`getXxxSortValue(row, columnKey)` を一覧ごとに定義**: switch case で columnKey → row 値の getter を書く。null フィールドは `?? ''` で正規化 (compareValues が末尾に並べる)。

##### 不可視のハマりどころ

- **`ResizableHead` の `overflow-hidden` 削除**: `SortableHeader` のドロップダウン (絶対配置) が th 外側にはみ出す必要があるため、`resizable-columns.tsx` の th 外側 `overflow-hidden` を削除した。テキスト truncation は子の `<div className="truncate pr-2">` で完結するので不要。
- **storageKey の一意性**: `sort:all-risks` と `sort:project-risks` は別キー。`typeFilter` で risk/issue タブを分けている画面 (all-risks-table) は `sort:all-risks:${typeFilter}` のように suffix を付与し、タブごとに独立させる。
- **`useMemo` の依存に `sortState` を必ず追加**: filter useMemo で `multiSort(xs, sortState, ...)` を呼ぶなら `sortState` を deps に入れないと再ソートされない。
- **`my-tasks-client.tsx` の階層**: 各 `pg.tree` の **top-level** だけソートし `children` の順序は維持する (子タスクの順序を崩すと WBS の意味が壊れる)。

#### 抽出したルール (今後の同種 UI)

- [ ] **新規一覧画面追加時は 5 ステップで sort を組み込む**: ① import 3 行 ② `getXxxSortValue` 定義 ③ `useMultiSort('sort:UNIQUE-KEY')` ④ 描画前に `multiSort()` ⑤ 各 sortable header を `SortableResizableHead` (または `<TableHead><SortableHeader/>`) に置換
- [ ] **「ソート不可」列を見極める**: チェックボックス / 添付一覧 / 操作ボタン列はソート不可、明示的に従来の `ResizableHead` のまま残す
- [ ] **server component の一覧を sort 対応する場合は client 切り出し**: 整形済 string と ISO 文字列を両方渡す pattern (display と sort の分離)
- [ ] **null/空文字は常に末尾**: direction で反転しない (UX 一貫性)
- [ ] **WBS など階層型一覧は対象外**: 子要素の順序を崩すと意味が壊れる
- [ ] **storageKey は画面固有 + 必要ならサブキー**: タブ切替で sort 状態を独立させたい場合は `sort:all-risks:risk` / `sort:all-risks:issue` のように suffix

#### 関連

- §5.41 (○○一覧 共通 UI 部品の抽出規約 — 本件も同パターン)
- §5.53 (PR #204 sticky thead — 本件と同じく N 画面横展開パターン)
- DESIGN.md §3.3 (DRY 原則)
- 修正例: `src/lib/multi-sort.ts` (純関数 + 25 件のテスト) / `src/components/sort/*` (UI 部品)
- 横展開先: `all-risks-table.tsx` / `all-retrospectives-table.tsx` / `knowledge-client.tsx` / `all-memos-client.tsx` / `risks-client.tsx` / `stakeholders-client.tsx` / `memos-client.tsx` / `my-tasks-client.tsx` / `projects-client.tsx` / `customers-client.tsx` / `admin/users-client.tsx` / `admin/audit-logs/audit-logs-table.tsx` / `admin/role-changes/role-changes-table.tsx`

### 5.59 通知 deep link を「全○○」auto-open + entity 別メンション認可の細粒化 (PR feat/notification-edit-dialog, 2026-05-01)

#### 背景・要件

PR #205 (通知 MVP) + PR #207 (mention) で通知 link は **`/projects/[id]/...?xxxId=...`** (project 個別画面) を生成していたが、以下 2 つの問題が判明:

1. **mention 受信者が project member 以外でも届く** (kind='user' / 'all') ため、リンククリック時に `/projects/[id]/risks` の `notFound` 認可で 403/404 になり、mention に応答できない
2. **target query (`?riskId=...`) はどの画面でも消費されず**、list ページに着地するだけで dialog が auto-open しない (PR #205 が link 形式だけ用意し dialog 自動 open は実装漏れだった)

ユーザ要望:
> メンションによる通知をクリックすると、メンションがされた編集画面が直接開かれるようにロジックを修正
> Customer はシステム管理者のみ、Stakeholder は PM/PL のみ、WBS は ProjectMember のみメンション可能に

#### 採用したパターン

##### entity 別の到達戦略 (cross-list 寄せ vs project-page + 認可制限)

| entity | 通知 link | 到達戦略 | mention 認可 |
|---|---|---|---|
| risk / issue / retrospective / knowledge | **`/risks?riskId=`** 等 cross-list | 全○○ で auto-open (visibility=public のみ閲覧可、誰でもアクセスできる) | 認証済全員 (現状維持) |
| task | `/projects/[id]/tasks?taskId=` | project 個別画面 | **ProjectMember のみ** (新設) |
| stakeholder | `/projects/[id]/stakeholders?...` | project 個別画面 | **PM/TL のみ** (新設) |
| customer | `/customers/[id]` | admin 専用画面 | **admin のみ** (現状維持を確認) |

**設計の対称性**: mention 認可で書ける人 = mention 通知の to が必ずアクセスできる人、を担保することで「届かない通知」が原理的に発生しない。

##### `useAutoOpenDialog` 共通フック

各「全○○」画面で `?xxxId=...` を読み取って dialog を 1 度だけ open する共通ロジックを `src/components/common/use-auto-open-dialog.ts` に集約:

```ts
useAutoOpenDialog<AllRiskDTO>({
  queryKey: 'riskId',
  items: risks,
  onOpen: (r) => void handleRowClick(r),
});
```

仕様:
- mount 時に query 取得 → items から id 一致行検索 → onOpen 呼出
- 開いた後は URL から該当 query を削除 (`router.replace`)、戻るボタンで再 open しない
- `triggeredRef` で 1 度きり動作を担保 (filter / sort 変動で再発火しない)

##### `EntityResolveResult` への `requiredRole` 追加

`comment.service.ts` の `kind: 'project-scoped'` に **`requiredRole: 'any' | 'pm_tl'`** を追加して route 層で:

```ts
for (const pid of result.projectIds) {
  const m = await checkMembership(pid, user.id, user.systemRole);
  if (!m.isMember) continue;
  if (result.requiredRole === 'pm_tl' && m.projectRole !== 'pm_tl') continue;
  return null;
}
```

stakeholder は `requiredRole: 'pm_tl'`、task は `requiredRole: 'any'` を返す。admin は entity 種別に関わらず常に通る (super-user)。

##### CommentSection の `canPost` prop (防衛的パターン)

ページ/タブ表示の制御だけでは UI 二重防御が崩れた時に取り返せないため、CommentSection 自体にも `canPost?: boolean` prop を追加 (default true)。現在は呼出側全てが既に page/tab レベルで制御済のため未使用だが、将来 dialog を共有する画面が増えた場合の保険として残す。

#### 設計判断のポイント

1. **「全○○」寄せの妥当性**: mention で「誰でも対象になり得る」 entity (risk/issue/retro/knowledge) は、必然的に「誰でも閲覧可」の cross-list ページに着地させる必要がある。entity 自体の visibility は `public` のみ全○○ 表示なので、draft 投稿への mention は draft 作成者本人にしか届かない (これも対称的)
2. **task/stakeholder は project page を維持**: mention 認可を ProjectMember / PM/TL に絞ることで、mention 通知 to は必ず project 個別画面にアクセス可能。「全○○」を作る必要がない (= データが project 内のみで意味を持つので cross-list が概念的に存在しない)
3. **stakeholder の requiredRole 採用根拠**: ステークホルダ管理は計画責任者 (PM/TL) の業務領域。一般メンバーは閲覧のみで議論には参加しない (DESIGN.md 上の RACI)。mention 機能を開放すると意図しないコメント発生源が増えてノイズになる
4. **`useSearchParams` ではなく専用フック化した理由**: 各 list ページで微妙に違う「item を探す → dialog open → URL クリーンアップ」を 1 箇所に集約することで、将来 N+1 ヒット (遅延 fetch / 複数 entity 混在) 拡張時に一括変更可能

#### 抽出したルール (今後の同種 UI)

- [ ] **mention 通知の to は必ず該当画面にアクセスできる**: mention 認可で「投稿可能な人」= 「to を受け取り得る人」が完全に project / role / admin スコープに含まれることを設計時に確認する
- [ ] **link 構築 (entity-link.ts) と認可 (route layer) は対の設計**: link を変更したら認可マトリクスを再確認、認可を変更したら link を再確認
- [ ] **deep link は受信者が絶対にアクセスできる URL を返す**: 「項目が見つからない時は list ページに fallback」「list ページ自体は誰でも見える」が deep link の基本要件
- [ ] **auto-open は 1 度きり**: filter / sort 変動で再発火しないよう `useRef` でガード、開いたら URL クリーンアップで再 open を防ぐ
- [ ] **UI gating は防衛的パターンとして prop 化しておく**: 現在使ってなくても将来の経路拡張で必要になる可能性が高い、コストはほぼゼロ
- [ ] **page/tab レベルと API レベルの二重防御**: UI 制御を変えただけでは抜けられる経路 (URL 直打ち / 直接 fetch / 開発者ツール) が必ず残るため、両方で同じマトリクスを enforce する

#### 既知の制約 / 後続対応

- **`/projects/[id]/stakeholders/page.tsx` が存在しない**: stakeholder mention の deep link は形式上 `/projects/[id]/stakeholders?stakeholderId=...` だが現状 404。stakeholder dialog はプロジェクト詳細画面のタブからのみ到達可能。新規 mention 認可 (PM/TL のみ) では tab 自体が PM/TL + admin にしか出ないため実害は小さいが、URL 直打ちでは 404 になる。後続 PR で page.tsx 切り出し or `/projects/[id]?tab=stakeholders&stakeholderId=...` 形式への切替を検討
- **task の auto-open 未実装**: `/projects/[id]/tasks?taskId=...` の URL 自体は機能するが、tasks-client は WBS 階層描画のため auto-open ロジックが list 系と異なる。後続 PR で対応

#### 関連

- §5.54 (PR #205 通知 MVP — 本件は link 形式の修正)
- §5.56 (PR #207 mention — 本件と密接、認可マトリクスを更新)
- §5.51 (visibility 認可マトリクス — 本件と同源、`requiredRole` 設計のベース)
- DESIGN.md §22 (polymorphic comment / mention)
- 修正例:
  - `src/lib/entity-link.ts` (link 構築)
  - `src/components/common/use-auto-open-dialog.ts` (新設、共通フック)
  - `src/services/comment.service.ts` `EntityResolveResult.requiredRole` (型拡張)
  - `src/app/api/comments/route.ts` `authorizeForComment` (PM/TL 判定追加)

### 5.60 通知 deep link 完成 + コメント認可の mention/plain 分離 + 編集削除ボタン投稿者限定 (PR feat/notification-deep-link-completion, 2026-05-01)

#### 背景・要件

§5.59 (PR #211) で残した既知制約 2 件を解消し、ユーザ要望「メンション通知をクリック → 編集 dialog 直接 open」を完全実装。さらに 2 つの新要件を追加対応:

1. **WBS タスクのコメント認可緩和**: 「データ/実績更新は project member 制限のままだが、**コメント自体は認証済全員可**」(PMO や他チームレビュアーのコメントを許容)。ただし mention 機能は ProjectMember 限定 (mention 受信者を project 内に閉じる)
2. **コメント編集/削除ボタンの投稿者限定**: 旧 UI は admin override で他人コメントの編集/削除ボタンを表示していたが、API 側 (§5.51) は既に admin 救済を外しており UI が不整合だった。UI を API に合わせて投稿者本人のみに統一

#### 採用したパターン

##### 既知制約 1: stakeholder の専用 page.tsx 不在 → tab パラメータ方式

stakeholder 専用の `page.tsx` を作る案 A と、`/projects/[id]?tab=stakeholders&stakeholderId=...` で project 詳細画面の tab 切替を活用する **案 B** を比較し、後者を採用:

- 既存の lazy fetch + tab 構造を完全流用 (新規ルート追加なし)
- project header (タブ navigation) が引き続き表示される
- stakeholders / members の fetch を二重定義しなくて済む

実装ポイント:
- `entity-link.ts`: stakeholder の URL を `/projects/{pid}?tab=stakeholders&stakeholderId={id}` 形式に変更
- `project-detail-client.tsx`:
  - `useState` 初期値で `searchParams.get('tab')` を読み active tab を deep link から決定
  - `useEffect` で mount 時に initial tab のデータを `loadTabData()` で 1 度だけ強制 fetch (lazy fetch は user click でしか発火しないため deep link 着地では trigger されない)
- `stakeholders-client.tsx`: 既存の `useAutoOpenDialog` フックで `?stakeholderId=...` を読み dialog auto-open + URL クリーンアップ

##### 既知制約 2: WBS task の auto-open (階層折りたたみ展開を含む)

flat list の `useAutoOpenDialog` がそのまま使えない (task は tree 構造で、対象タスクが折りたたまれた親 WP の中にいると非表示)。

**`task-tree-utils.ts` に 2 関数追加**:
- `findTaskInTree(nodes, targetId)`: 再帰的にツリーから task を検出
- `findAncestorIds(nodes, targetId)`: 自身を除く祖先 id 列を root → 親の順で返す

**tasks-client.tsx に専用 useEffect**:
1. `?taskId=...` を読む
2. `findTaskInTree` で対象 task を取得
3. `findAncestorIds` で祖先列取得 → `expandedTaskIds` set に全追加 (折りたたみ展開)
4. `openEditDialog(task)` で dialog open
5. URL から `?taskId=...` 削除 (router.replace + scroll: false)
6. `useRef` で 1 度きり実行を担保 (filter 切替で再発火しない)

##### 新要件 1: task の plain コメント認可緩和

`EntityResolveResult` の `kind: 'project-scoped'` を 2 軸で再構成:
- `mentionRequiredRole: 'any' | 'pm_tl'` — mention 含む write の必須 role
- `plainCommentScope: 'public' | 'project-member'` — mention なし write / read の範囲

| entity | mentionRequiredRole | plainCommentScope | 結果 |
|---|---|---|---|
| task | `'any'` | `'public'` | plain は誰でも可、mention 含む write は ProjectMember 必須 |
| stakeholder | `'pm_tl'` | `'project-member'` | mention 有無に関わらず PM/TL のみ可 (= mentionRequiredRole を常に適用) |

route 層 `authorizeForComment` で:
```ts
const isPlainOperation = mode === 'read' || (mode === 'write' && !hasMentions);
if (isPlainOperation && plainCommentScope === 'public') return null; // task の早期通過
// それ以外: mentionRequiredRole で判定 (admin はトップで通過済)
```

##### 新要件 2: 編集/削除ボタンの投稿者限定

`comment-section.tsx` の `canMutate` 関数を `isAdmin || c.userId === currentUserId` から `c.userId === currentUserId` に変更。`isAdmin` 変数自体を削除。

理由: API (`/api/comments/[id]`) は §5.51 (PR fix/visibility-auth-matrix) で既に「投稿者本人のみ」に統一済 (admin 救済なし)。UI はそれに追随していなかったため、admin が他人コメントの編集ボタンを押しても 403 が返る矛盾があった。

横展開チェック: `<CommentSection>` の利用箇所を grep で確認 — 全 5 箇所 (knowledge-edit-dialog / retrospective-edit-dialog / risk-edit-dialog / stakeholder-edit-dialog / customer-detail-client / tasks-client) は **共通コンポーネントを参照するだけ**で、それぞれ独自にボタン判定していないことを確認済。1 箇所修正で全画面に伝播。

#### 設計判断のポイント

1. **stakeholder で page.tsx を作らなかった理由**: stakeholder UI はプロジェクト詳細画面のタブ ([SPECIFICATION §7.9.1](../developer/SPECIFICATION.md)) として定義されており、独立した URL を持たない設計。専用 page.tsx を作ると stakeholder data + member data + project meta + RBAC を二重定義することになり、§21.2 DRY 原則違反。tab 方式は既存構造との整合性が高い
2. **task の plainCommentScope='public' の根拠**: 「project member ではないが業務上コメントしたいケース」(PMO 横断 / 他チームレビュアー / 顧客リエゾン) を許容するため。一方 mention 機能を解放すると project 外の人に通知が飛んで「届かない通知」が発生するため mention は ProjectMember 必須を維持
3. **stakeholder の plainCommentScope='project-member' を「mentionRequiredRole 適用」と読む**: スコープを明示する代わりに「mentionRequiredRole を plain にも適用するか否か」のフラグとして機能させ、stakeholder は常に PM/TL ロールチェックが走る構造に
4. **`useEffect` で initial tab を fetch する理由**: lazy fetch は `handleTabChange` 経由でしか発火しないため、URL 直接遷移 (deep link) では tab UI を表示しても data が空の状態になる。mount 時に `loadTabData(initialTabFromUrl)` を 1 度呼ぶことで補完
5. **編集削除ボタンの`isAdmin`削除を「横展開」と判定した理由**: comment-section.tsx の 1 箇所修正で全 6 経路 (knowledge / retro / risk / stakeholder / customer / task) に自動的に伝播する DRY 構造。grep で個別実装が無いことを確認した上で「1 箇所修正で N 画面伝播パターン」(§5.53) と同じ恩恵を受ける

#### 抽出したルール (今後の同種 UI)

- [ ] **専用 page.tsx を作る vs tab パラメータ方式の判断**: tab UI で実装されたサブ画面に deep link を作るときは、URL の RESTfulness より既存構造との DRY 整合性を優先 (`?tab=...&xxxId=...`)。fetch / RBAC / metadata を二重定義しなくて済むことが大きい
- [ ] **lazy fetch + deep link の落とし穴**: lazy fetch は user click でしか発火しないため、deep link 着地時には mount effect で initial tab data を強制 load する必要がある
- [ ] **WBS 階層 deep link は祖先展開とセット**: tree 構造の entity に deep link する場合、対象が折りたたまれた親 WP 内にいる前提で、`findAncestorIds` 経由で祖先全展開してから dialog open
- [ ] **コメント認可の 2 軸モデル**: mention 有無 × plain スコープ の 2 軸で entity 別認可を表現 (`{mentionRequiredRole, plainCommentScope}`)。「mention は厳しく、plain は緩く」という非対称認可を素直に表現できる
- [ ] **UI gating と API gating の整合**: API で admin 救済を外したら、UI 側の `isAdmin || ...` も同時に外す。1 箇所の見落としで「ボタンは見えるが押すと 403」の不整合 UX が発生する。grep で `isAdmin\s*\|\|` を点検

#### 関連

- §5.59 (PR #211 通知 link cross-list 化 — 本件で残課題を解消)
- §5.51 (visibility 認可マトリクス — 編集削除ボタン投稿者限定の根拠)
- §5.53 (sticky thead 1 箇所修正で N 画面伝播パターン — 本件のコメントボタン修正と同パターン)
- DESIGN.md §22 (polymorphic comment / mention)
- 修正例:
  - `src/lib/entity-link.ts` (stakeholder URL 形式変更)
  - `src/lib/task-tree-utils.ts` (`findAncestorIds` / `findTaskInTree` 追加)
  - `src/services/comment.service.ts` (`EntityResolveResult` 2 軸再構成)
  - `src/app/api/comments/route.ts` (`authorizeForComment` の plain/mention 分岐)
  - `src/components/comments/comment-section.tsx` (`canMutate` の admin 救済削除)
  - `src/app/(dashboard)/projects/[projectId]/project-detail-client.tsx` (`?tab=` 読み + initial fetch)
  - `src/app/(dashboard)/projects/[projectId]/tasks/tasks-client.tsx` (`?taskId=` auto-open + 祖先展開)

#### 追補: DB 上の旧通知 link 互換レイヤー (Vercel runtime log で発覚した本番障害対応)

**症状**:
PR #211 マージ直後 (2026-05-01T06:12) 〜 数分後の Vercel runtime log で `GET /projects/<pid>/knowledge` への **404 アクセスが多発**。ユーザ報告「メンション通知から該当ナレッジに遷移したときにエラー」と整合。

**根本原因**:
PR #207 (mention) 〜 PR #211 の間、`entity-link.ts` は knowledge / stakeholder 通知 link に `/projects/[id]/knowledge?knowledgeId=...` 形式を生成していたが、**該当 page.tsx が存在しないため恒常的に 404** だった。PR #211 で新規 link は cross-list 形式 (`/knowledge?knowledgeId=...`) に変更済だが、**既に DB に保存された Notification.link は旧 URL のまま残存** していた。Notification は cron 自動削除がまだ未整備のため、DB に長期間残る。

**対応**:
旧 URL を恒久救済する **互換ルート (redirect-only page.tsx) を 2 本追加**:

```
/projects/[id]/knowledge/page.tsx     → redirect to /knowledge?knowledgeId=<query>
/projects/[id]/stakeholders/page.tsx  → redirect to /projects/[id]?tab=stakeholders&stakeholderId=<query>
```

実装は `next/navigation` の `redirect()` を使った server component 数行のみ。認可は redirect 先で再判定される (cross-list は public のみ閲覧可、project page は ProjectMember/admin 必須)。

**抽出した教訓 (新規ルール)**:

- [ ] **link 構築ロジック変更時は DB 上の永続化済 link データも考慮する**: `entity-link.ts` のような link generator を変更したとき、古い link が DB に残るケース (Notification / Email / Audit ログ等) は必ず棚卸しし、互換レイヤー (redirect) または backfill migration のいずれかで救済する
- [ ] **`page.tsx` 不在 URL を link generator が生成していないか CI/Lint で検出**: `entity-link.ts` のテストで「生成された URL が `app/` ディレクトリ構造と整合する」ことを assert する単体テストを追加するのが理想。または `pnpm tsx scripts/check-link-routes.ts` 的なヘルパー
- [ ] **本番 deploy 後 30 分は Vercel runtime log を grep する**: `level:error` だけでなく `responseStatusCode:404` の急増もチェック対象。link generator 変更時は特に
- [ ] **redirect-only page は最小実装で OK**: 認可ロジック / data fetch は不要、`redirect(newUrl)` を呼ぶだけ。本ルートを通過した後 redirect 先で標準の認可が動くため二重防御の心配なし

#### 関連 (互換レイヤー)

- E2E_LESSONS_LEARNED §4.44 (PR マージ後 migration 適用忘れ — 本件と同類「DB と code が乖離する罠」)
- §11 T-14 / T-24 (Notification / audit_logs の自動削除バッチ — 整備されれば本互換レイヤーも将来不要に)
- 修正例: `src/app/(dashboard)/projects/[projectId]/{knowledge,stakeholders}/page.tsx` (redirect-only)

### 5.61 /api/attachments の visibility-aware 認可 + memo にコメント機能を追加 (PR #213, 2026-05-01)

#### 背景

ユーザレポート 2 件:
1. **「全振り返り」一覧画面で作成者ではないユーザが編集 dialog を開くと `/api/attachments` GET が 403** (Vercel runtime log で観測)
2. **全メモにはコメント機能がない** ので他「全○○」と同様に追加してほしい

調査結果、両者は **DialogAttachmentSection コメントの「fix/cross-list-non-member-columns で開放済」が嘘** だった (batch endpoint のみ修正で singular GET は対応漏れ)、および **memo は PR #199 でポリモーフィック comment 対象外になっていた** ことが原因。

#### Task 2: `/api/attachments` の 403 を visibility-aware 認可で解消 (regression fix)

**症状**: cross-list 画面 (`/risks` `/retrospectives` `/knowledge`) から非 project member が public な entity の readOnly dialog を開くと、`<AttachmentList>` が `GET /api/attachments?entityType=...&entityId=...` を発火して 403 (Console エラー)。

**根本原因**:
- batch endpoint (`/api/attachments/batch`) は `fix/cross-list-non-member-columns` (2026-04-27) で `visibility='public'` の risk/retrospective/knowledge を非メンバーに開放済
- **しかし singular endpoint (`/api/attachments?entityType=...`) は対応漏れ** で project member 必須のまま
- DialogAttachmentSection の docstring は「開放済」と記載されていたが事実と乖離 (「動くと思っていたら動いていなかった」典型)

**修正**:
- `attachment.service.ts` に `getEntityVisibility(entityType, entityId)` ヘルパー追加 (visibility 概念を持つ risk/retrospective/knowledge のみ visibility + creatorId を返す。それ以外は null)
- `route.ts` の `authorize()` を mode 別に分岐:
  - `read` mode + visibility='public' → 認証済全員可 (project member 不要)
  - `read` mode + visibility='draft' → 作成者本人のみ (admin はトップで通過)
  - `write` mode → project member 必須 (visibility 関係なく、書き込みは厳格)
  - `read` mode で visibility 概念なし (project/task/estimate) → project member 必須 (現状維持)

batch route と singular route の認可ロジックが完全に対称化。

#### Task 1: memo にコメント機能を追加

**設計判断**:
- memo は user-scoped (project 紐付けなし) なので、knowledge と同じ `kind: 'public-or-draft'` を再利用 (visibility-based 認可)
- mention 許容 kind は `['user', 'all']` (`project_member` / `role_*` / `assignee` は memo に概念がないため不可)
- 通知 link は `/all-memos?memoId=...` (cross-list、auto-open)

**実装した拡張ポイント** (5 箇所):
| ファイル | 変更内容 |
|---|---|
| `src/lib/validators/comment.ts` | `COMMENT_ENTITY_TYPES` に `'memo'` 追加 (7→8) |
| `src/lib/validators/mention.ts` | `getAllowedMentionKinds('memo')` で `['user', 'all']` を返す case 追加 |
| `src/services/comment.service.ts` | `resolveEntityForComment('memo')` で `kind: 'public-or-draft'` を返す case 追加 |
| `src/services/mention.service.ts` | `getMentionContext('memo')` で `{projectId: null, assigneeId: null}` を返す case 追加 |
| `src/lib/entity-link.ts` | `buildEntityCommentLink('memo')` で `/all-memos?memoId=...` を返す case 追加 |

**UI 統合** (2 箇所):
- `all-memos-client.tsx`: 詳細 dialog に `<CommentSection entityType="memo" entityId={...} />` 追加 + `useAutoOpenDialog` で `?memoId=...` から auto-open
- `memos-client.tsx` (個人メモ): 編集 dialog に同様の `<CommentSection>` 追加

memo へのコメント認可は `kind: 'public-or-draft'` を流用するため `comment-section.tsx` / `route.ts` 側の追加変更は不要。

#### 設計判断のポイント

1. **batch と singular の認可は対称化が大原則**: 同じ entity への異なる ENDPOINT は同じ認可マトリクスでなければならない。片方だけ緩和すると本件のような「動くはずが動かない」UX が出る
2. **`getEntityVisibility` を attachment.service と comment.service で別実装にした理由**: comment 側は `creatorId` の比較、attachment 側は `creatorId` でも比較するが、責務が異なるため重複は許容。1 関数に統合すると AttachmentEntityType と CommentEntityType の差 (memo は両方 / customer は comment のみ / project/estimate は attachment のみ) で型分岐が複雑化する
3. **memo の mention kind を `['user', 'all']` に絞った理由**: memo は user-scoped で project 概念がないため、`project_member` / `role_*` / `assignee` の mention は意味的に不可能。validator で弾くことで誤った UI 露出を防ぐ
4. **DialogAttachmentSection の docstring 修正**: 「fix/cross-list-non-member-columns で開放済」という嘘の記述を実態に合わせて修正。docstring が正しいと思い込んで詳細調査をスキップしていた、本件の遅延要因でもある

#### 抽出したルール

- [ ] **batch endpoint と singular endpoint の認可は必ず対称化**: 横展開チェックを CI/Lint で強化することが望ましい (将来の TODO)
- [ ] **docstring の主張を実装で検証する**: 「○○で対応済」のようなコメントを書く際は、実装にテストで担保があるか確認。テスト無しで docstring を信用してはいけない
- [ ] **新しい comment 対象 entity の追加は 5 拡張ポイント パターン**: `COMMENT_ENTITY_TYPES` / `getAllowedMentionKinds` / `resolveEntityForComment` / `getMentionContext` / `buildEntityCommentLink` の 5 箇所を更新する。漏れがあると「コメントは投稿できるが mention できない」「mention できるが通知 link が壊れる」など UX 不整合
- [ ] **visibility-based 認可は `kind: 'public-or-draft'` で統一**: 新しい entity を追加するとき、既存の visibility-aware kind を流用すれば認可ロジックが自動で適用される (DRY)
- [ ] **Vercel runtime log の 403 急増は週次で監視**: `responseStatusCode:403` を grep し、特定 endpoint で急増していたら認可マトリクスの抜けを疑う

#### 関連

- §5.59 / §5.60 (本件の前段、通知 deep link 系の改修)
- §5.51 (visibility-aware 認可マトリクスの根拠 — 本件は同パターンを attachment にも適用)
- §5.14 (`/api/attachments?entityType=risk` 403 の旧 hotfix。`{!readOnly && ...}` で gating したが本件で発覚した通り読み取りパスは依然として 403 を踏んでいた、本 PR が完全解消)
- 修正例:
  - `src/services/attachment.service.ts` (`getEntityVisibility` 新設)
  - `src/app/api/attachments/route.ts` (`authorize()` の visibility 分岐)
  - `src/lib/validators/{comment,mention}.ts` (memo enum 追加)
  - `src/services/{comment,mention}.service.ts` (memo case 追加)
  - `src/lib/entity-link.ts` (memo 通知 link)
  - `src/app/(dashboard)/{all-memos,memos}/...client.tsx` (`<CommentSection>` 統合)

### 5.62 提案エンジン v2 の設計議論と意思決定ログ (T-03 設計フェーズ, 2026-05-01)

本セクションは、提案エンジン v2 (T-03) の設計フェーズで行われた約 5 時間にわたる対話的設計議論の意思決定を、後から再現可能な形で記録する。実装は明日 (5月2日) から着手予定であり、本記録は実装中の判断根拠として、また将来の振り返りで「なぜこの設計を選んだか」を辿るための一次資料となる。

#### 議論の出発点

本サービスのリポジトリには PR #65 で実装された提案エンジン v1 が存在し、`pg_trgm` による文字 n-gram 類似度とユーザ手動入力タグの Jaccard 係数を半々の重みで合成してスコアを算出していた。これは外部依存なし・追加コストなしという美徳がある一方で、文章の意味的な近さを捉えられず、新規ユーザほど提案精度の低さを体験するという根本的な弱点を抱えていた。これを T-03 として課題登録しており、本リリース戦略において「外部展開前必須」と位置付けていた。

ユーザは本機能を「サービスの核心機能であり、世の中のタスク管理アプリにはない独自の機能で、最大の差別化ポイント」と明確に位置付け、「多少コストがかかっても大幅に検索性能が向上するのであれば検討材料としたい」と方針を示した。この姿勢が議論の前提となり、ゼロコスト運用に縛られず、外部 LLM API への継続的な金銭コストを許容する設計に踏み出すことになった。

#### 技術選択肢の比較 (議論の核心)

4 つの選択肢を比較した。語彙辞書を手書きする方式 (A) は、辞書メンテが永続的負債となるため不採用。形態素解析 (kuromoji.js) (B) は、Vercel Edge との相性が悪く、辞書ロードでコールドスタートが悪化するため不採用。LLM ベース (C) は推論精度が極めて高い一方でコストとレイテンシのトレードオフがある。Embedding ベース (D) は安価かつ高速で意味類似が捉えられる。

最終的に **「D を主軸に C を載せる」3 段階構成** を採用した。これは Notion / Linear / Slack などの主要 SaaS のセマンティック検索が採用するデファクト構成であり、本サービスがこのトレースをすることに技術的・事業的な妥当性が高いと判断した。

#### コスト試算と事業判断

3 段階構成のランニングコストを、ユーザ規模別 (1 / 5 / 10 / 25 / 50 / 100 人) に試算した結果、Haiku 構成で 100 人規模で月 1,400 円、Sonnet 構成で月 4,000〜5,000 円と算定した。書き込み時の embedding 生成コストは無視できるレベルで、コストの大半は提案表示時の LLM Re-ranking で発生する。この試算をユーザは「月数千円なら核心機能への投資として十分許容できる」と判断し、本格運用前提の設計に進めることを決定した。

Haiku と Sonnet の差は単価 3 倍だが、実体験上の差は「並び替え精度はほぼ同じで、説明文の質が劇的に違う」と分析した。これに基づき、「**初期は Haiku で開始、ユーザフィードバックで Sonnet 化を判断**」という段階移行戦略を採用した。

#### 事業戦略との統合

ユーザから「OSS として基本無料で展開、データ蓄積で価値を実感させ、Sonnet 化の Pro プラン課金で UX を最大化する」というシナリオが提示された。これは Notion / Linear / Figma / Sentry / Plausible が歩んだ典型的な OSS-with-managed-cloud モデルで、本サービスの差別化と完全に整合することを確認した。

主要な合意事項として、コードベース全体を **AGPL ライセンス** で公開する (競合 SaaS の商用クローン阻止)、`User.subscription_tier` カラムによる **論理コンテナ分離** で Free/Pro を切り替える、無料ユーザの体験を「劣化版」ではなく「十分なベースライン」として設計する、初期データとして資格試験事例や著名な法則の独自要約を投入してコールドスタート問題を緩和する、を確定した。

#### 悪用防止の最重要視

ユーザの強い指示「**この機能は運用コストが発生するうえ、悪用されると経済破綻を引き起こす可能性が高い。手を抜いてはいけない**」を最重要事項として受け止め、**5 層悪用防止アーキテクチャ** を設計した。シークレット保護 / 認証強化 / ユーザ単位レート制限 + トークン上限 / プロンプトインジェクション対策 / workspace 上限の 5 層で、各層は独立して機能し、ある層が破られても他の層で被害を抑え込む構造とする。

特に注目すべきは、**Anthropic workspace の月間予算ハード上限** が「最終的な経済的損失の天井」を決定するという観察である。これを想定使用量の 1.5〜2 倍 ($30 = 約 4500 円) に設定することで、上記 4 層がすべて破られても損失は $30 に制限される。

コミット履歴の API キー漏洩調査も実施し、727 コミット全履歴に対して Anthropic / OpenAI / Voyage / GitHub PAT / AWS / JWT 等の典型パターンで網羅的検査を行い、**実際のシークレット混入は 1 件もないことを確認** した。これは `.gitignore` を最初から適切に設定する習慣が貫かれていた結果であり、出発点として極めて健全な状態にある。

#### 主要な意思決定の記録

第一に、**LLM プロバイダは Anthropic Claude を採用**。本サービスが Claude Code で開発されており API key 管理が既存、日本語精度が高く、prompt caching でコスト最適化可能、の 3 点を根拠とする。

第二に、**Embedding プロバイダは Voyage AI の voyage-4-lite (1024 次元) を第一候補、OpenAI text-embedding-3-small を代替候補**。Voyage は Anthropic 推奨で API 形式が OpenAI 互換。**voyage-4-lite は 200M トークンが無料** で v1 規模では無料運用可。当初検討した voyage-3-lite は 2026 年時点で旧世代化し無料枠が失効したため 4 系に切替 (PR #4 で更新)。

第三に、**ベクトル DB は Supabase pgvector 拡張を採用**。既存 Postgres に閉じることで追加サービスを増やさない。

第四に、**初期実装の LLM モデルは Haiku 一本**。Sonnet 化はバージョンアップで Pro プランの提供時に行う。

第五に、**Phase 3 (LLM Re-ranking) は 6月1日リリースから外す**。Phase 2 までで核心的な差別化体験は成立し、Phase 3 は後続でリリースした方が「進化し続けるアプリ」というシグナル効果がある。

第六に、**ユーザ単位月間トークン上限は Free 10万 / Pro 100万** で開始、運用しながら調整。

第七に、**監視・異常検知は v1 で最小実装、観測ダッシュボード UI は v1.x で追加**。Phase 3c の `/admin/observability` の一部として組み込む。

#### 実装着手前のチェックリスト

明日からの実装着手前に、以下の準備を完了しておく必要がある。

設計ドキュメントの執筆は本 PR (`docs/suggestion-engine-spec`) で完了する。SUGGESTION_ENGINE_PLAN.md / REQUIREMENTS.md §13 / SPECIFICATION.md §26 / DESIGN.md §34 / SUGGESTION_ENGINE_THREAT_MODEL.md がすべて整備されたことを確認。

Anthropic workspace の月間予算ハード上限 ($30) と通知設定はリリース前 (5月末) に必ず実施。Voyage AI も同様の上限設定を実施。

git pre-commit hook (Husky / lefthook + gitleaks) の整備は PR #2 (経済的安全性の基盤実装) で実施。GitHub Push Protection の有効化は repo settings UI から admin 操作で実施。

Upstash Redis の Vercel 連携は PR #2 のタイミングで Vercel ダッシュボードから有効化。無料 tier (10K commands/day) で開始し、必要に応じて拡大する。

#### 抽出したルール

- [ ] **核心機能の設計は「ユーザにとっての価値」と「悪用された場合のリスク」を同等に重視**: 本機能の設計議論で 6:4 の比率で悪用防止に時間を割いた。これが正しい配分であり、後から痛い目を見ない設計を作る基本姿勢
- [ ] **OSS 公開する機能は「コードを読まれている前提」で防御を設計**: プロンプトの内容が公開される、攻撃手法が研究される、ことを前提に多層防御を組む
- [ ] **段階的リリースは「ユーザに進化し続けるシグナル」を送る武器**: 一度に全部リリースせず、リリース後の継続的な機能追加でユーザに「成長するアプリ」と感じてもらう設計判断は SaaS リテンションに大きく寄与する
- [ ] **コスト試算は「ユーザ像 × 規模」のマトリクスで考える**: ライト / ミディアム / ヘビーの 3 ユーザ像に分解し、人数規模別の月額試算を出すことで、事業判断のための具体的な根拠が得られる
- [ ] **5 層防御の最後の砦は workspace 月間ハード上限**: アプリ層・認証層・rate limit 層・プロンプト層をすべて破られても、最終的に外部 API 側の予算上限で必ず止まる、という設計を持つことが致命的損失を防ぐ

#### 関連ドキュメント

- 実装計画: [SUGGESTION_ENGINE_PLAN.md](./SUGGESTION_ENGINE_PLAN.md)
- 要件定義: [REQUIREMENTS.md §13](./REQUIREMENTS.md)
- 機能仕様: [SPECIFICATION.md §26](./SPECIFICATION.md)
- 技術設計: [DESIGN.md §34](./DESIGN.md)
- 脅威モデル: [docs/security/SUGGESTION_ENGINE_THREAT_MODEL.md](../security/SUGGESTION_ENGINE_THREAT_MODEL.md)
- リリース計画: [RELEASE_ROADMAP.md §2.6](../administrator/RELEASE_ROADMAP.md)

#### 5.62 補強: マルチテナント運用前提の追加意思決定 (2026-05-01 同日中の補正)

設計議論を初回完了した直後、ユーザから「外部公開後の運用フローを反映した設計に補正してほしい」という重要なフィードバックがあり、提案エンジンの設計を **マルチテナント SaaS 前提** に再構築した。これは設計の根本に関わる変更だったため、追加の意思決定として本セクションに記録する。

#### マルチテナント化を決定した背景

外部ユーザの利用申し込み → テナント作成 → 初期データ投入 → 利用 → サブスク契約 (Sonnet 化) → 利用停止 (テナント削除)、という一連の運用フローが明確化された。これに対応する設計上の選択は、**「論理コンテナ (テナント) ごとにデータと認可を分離する」** マルチテナント アーキテクチャ採用が唯一の合理解だった。

採用根拠は 4 点ある。第一に、**外部ユーザの心理的安全性**: 機密性の高い業務情報を扱うサービスとして、運用者および他テナントから自分のデータが見えない構造であることが、法人ユーザの導入障壁を下げる決定的要因となる。第二に、**経済的安全性のスコープ限定**: 悪用された場合の被害をテナント単位で閉じ込めることで、サービス全体への波及を防げる。第三に、**契約モデルとの整合**: 個人利用でも組織利用でも「契約 = テナント」と統一できることで、課金プロバイダ連携が単純化する。第四に、**自然なデータ削除権の実現**: ユーザが利用停止を選んだ際、その意思を物理削除で実現することで、退会後の API 悪用を構造的に防げる。

#### 追加の意思決定

第一に、**データ分離方式は「shared DB + tenantId column」(soft isolation)** を採用。Postgres スキーマ単位の分離 (hard isolation) や RLS (row-level security) も検討したが、運用と実装の複雑度を考えると tenantId フィルタの徹底で十分。RLS 導入は v1.x 以降の追加防衛線として再検討。

第二に、**トークン上限と subscription_tier は User ではなく Tenant に配置**。当初 User に配置する設計だったが、契約単位 = テナント単位の原則と矛盾するため、すべて Tenant に移動。テナント内の複数ユーザが予算を共有する形になる。

第三に、**初期シードデータはテナント単位で複製**。すべてのテナントが同じ参照データを共有する設計も可能だったが、テナント独立性の担保 (削除時の整合性、テナント側の編集自由度) を優先して、テナント作成時にシードデータを clone する設計を採用。embedding ベクトルもコピーすることで再生成コストを節約する。

第四に、**v1 では「単一 default-tenant 運用」に絞る**。マルチテナント完全対応のコードを書きつつ、運用上は 1 テナントのみが存在する状態で 6月1日にリリースする。テナント管理 UI / 招待メール / Stripe 連携などは v1.x で順次追加。これは当初スコープを超える機能であり、6月1日リリース必達の範囲を守るための判断。

第五に、**提案機能多用に対する 3 段階コスト保護を追加**。Phase 3 結果のキャッシュ、テナント単位の日次 LLM 呼び出しキャップ、月間トークン上限と workspace 上限の組み合わせで、最悪ケースでも 1 テナントあたりの月間損失が数百円〜千円に収まる設計とする。

第六に、**インフラ移行判断のトリガー条件を明文化**。Vercel Function timeout 1% 超 / Supabase 80% 超 / API 月額 \$100 超 / ユーザ体感悪化、のいずれかが発生した時点で AWS / Azure / GCP への移行を評価する。これは早期過剰投資と判断遅延の両方を避けるための仕組み。

#### スケジュールへの影響

マルチテナント基盤の追加によって、PR #2 の規模が当初 3〜4 日から 5〜7 日に拡大した。これに伴い後続 PR も若干後ろ倒しとなり、判断キータイミングが 5月25日 → **5月22日 (Week 3 前半)** に前倒しとなった。Week 3 前半時点で PR #5 (Phase 2 統合) まで完成していなければ、6月8日延伸 Plan B を発動する。

縮退オプションとして、Phase 2 の HNSW インデックス最適化、詳細な異常検知ロジック、初期シードデータの量、を後続化する優先順位を明記。逆に **マルチテナント基盤、5 層悪用防止、最小限の監視は縮退対象から除外**。これらはセキュリティと経済的安全性の根幹であり、後続化を許容しない。

#### 追加された脅威分析

[SUGGESTION_ENGINE_THREAT_MODEL.md](../security/SUGGESTION_ENGINE_THREAT_MODEL.md) に「マルチテナント前提での追加脅威」として 6 項目を追加。テナント間データ漏洩 (MT-1)、テナント認可境界のバイパス (MT-2)、テナント削除時のデータ漏れ (MT-3)、テナント単位コスト追跡の改ざん (MT-4)、初期シードデータを通じた漏洩 (MT-5)、Pro プラン契約状態の不正改ざん (MT-6) の各脅威について、対策と実装担当 PR を明記。

特に MT-1 (テナント間データ漏洩) はマルチテナント SaaS で最も致命的な脆弱性類型であり、すべての DB クエリへの tenantId フィルタの徹底、`requireSameTenant()` ユーティリティの全 API ルートでの呼び出し、統合テストでの「テナント境界越境攻撃」の再現、を必須とする。

#### 抽出した追加ルール

- [ ] **マルチテナント設計は「契約 = テナント」を中心に据える**: ユーザ単位ではなく契約単位でデータと予算を分離することで、課金モデル・データ削除権・経済的安全性が一貫した形で実現される
- [ ] **soft isolation (tenantId column) と hard isolation (DB schema) の中間として、RLS は強力な追加防衛線**: v1 では tenantId フィルタの徹底で十分だが、RLS は将来の選択肢として保持する
- [ ] **初期シードデータはテナント単位で複製、共有は避ける**: ストレージ重複は微小だが、独立性とテナント削除時の整合性が大きく改善する
- [ ] **「単一 default-tenant 運用」は段階移行の優れた中間状態**: マルチテナント完全対応のコードを単一テナントで稼働させることで、外部ユーザ受け入れの瞬間に運用モードを切り替えられる
- [ ] **インフラ移行判断は明確なトリガー条件で機械的に評価**: 直感ではなく定量的な指標で判断することで、早期過剰投資と判断遅延の両方を避ける

#### 5.62 補強 2: 課金モデルの確定 — 3 プラン構成 + 従量課金 (per-API-call) (2026-05-01 同日中の最終決定)

マルチテナント アーキテクチャの議論からさらに踏み込み、**課金モデルを per-seat (席数比例) ではなく per-API-call (従量課金)** にすることで最終確定した。これは設計初期 (per-token / per-seat 等を検討した段階) から再々検討の議論を重ね、ユーザの直感とサービス特性に最も適合するモデルとして選ばれた。

#### per-seat ではなく per-API-call を選んだ理由

per-seat 課金モデル (1 席あたり N トークン) を中間案として検討したが、**ユーザ削除タイミングによる悪用** と **未使用ユーザ分の運用者損失** という 2 つの構造的問題が解消できなかった。具体的には、月末ぎりぎりに席数を減らすことで集計を誤魔化す不正利用パターンが発生しうる、また MAU (月間アクティブユーザ) ベースに変えても「使ってないが在籍するユーザ」のコストが運用者にしわ寄せされる構造が残る。

これに対し per-API-call (実際に使った機能呼び出し回数による課金) は、**「使った分だけ払う」**という素朴な公平性を提供し、ユーザの削除タイミングや活動状態に依存しない。さらにユーザに「自分のクリック数 ≒ 課金額」という直感的な予測可能性を与える点で、Stripe / Twilio などの主要な従量課金 SaaS と同じパターンに乗ることになる。

#### 確定した 3 プラン構成

**Beginner プラン (無料)**: 最大 5 席、Claude Haiku、月間 100 回までの API 呼び出し上限。試験運用と上位プランへのアップセル誘導の入り口として機能する。100 回到達時は提案機能が縮退モード (embedding ベース並びのみ表示) に切り替わり、月初に自動リセット。

**Expert プラン (席数無制限・従量課金)**: Claude Haiku、API 呼び出し 1 回あたり ¥10 (初期値、運用中に調整)。月間使用量に上限なし。

**Pro プラン (席数無制限・従量課金、Sonnet)**: Claude Sonnet、API 呼び出し 1 回あたり ¥30 (初期値)。深い説明文付きの最上位プラン。

価格は初期値であり、**実運用データを見ながら段階的に調整** する想定。Tenant テーブルの `pricePerCallHaiku` / `pricePerCallSonnet` カラムに保存し、admin による外部から調整可能。

#### 「1 回」の課金単位の定義

API 呼び出しの「1 回」は **ユーザに見える機能単位** で定義する。新規プロジェクト作成時の自動タグ抽出 + 初回提案生成は内部的に複数の LLM / Embedding 呼び出しを伴うが、ユーザから見て 1 操作なので 1 回としてカウントする。embedding 生成 (バックグラウンド処理) は課金対象外で運用者が吸収する。

これによってユーザは「自分のクリック数 ≒ 課金額」と予測でき、Phase 3 のキャッシュヒット率向上などの内部最適化を進めても請求額に影響しない設計となる。

#### 月次予算上限の自己設定とリアルタイム使用量ダッシュボード

pure metered billing の最大の弱点である「請求額の予測不可能性」を、**ユーザ自身が月次予算上限を設定できる仕組み** で解消する。例: 「月最大 ¥10,000 まで」と設定すると、その金額に達した時点で API 呼び出しが縮退モードに自動切替される。法人ユーザの導入障壁を大きく下げる重要機能で、Stripe / Twilio など主要な従量課金 SaaS が採用する標準パターンである。

加えて **リアルタイム使用量ダッシュボード** をテナント管理者設定画面で公開し、当月の API 呼び出し回数・課金額・予算比率・日次推移グラフ・機能別内訳を可視化する。これにより、月末まで請求額が不明な不安を取り除き、突発的な使用量増加 (= 異常パターン) をユーザ自身が発見できる窓口を提供する。

#### プラン変更フローの制御 (特にダウングレード)

テナント管理者は自テナントのシステム管理者設定画面でプラン変更を行えるが、ダウングレード時には **システム側で必ず制御を加える**。

第一に、Expert / Pro → Beginner へのダウングレードは、現席数が 5 を超えるテナントに対しては **システムが拒否** する。「先に席数を 5 以下に減らしてください」という警告を表示し、API レベルでも拒否する二重防御とする。

第二に、ダウングレードは **当月末まで現プラン継続、翌月 1 日から Beginner 適用** とする。これは月末ぎりぎりにダウングレードして当月分の従量課金を 0 円にする悪用を防ぐ仕組みで、`Tenant.scheduledPlanChangeAt` と `Tenant.scheduledNextPlan` フィールドで遅延適用を実現する。

第三に、ダウングレード操作前の確認 UI で「ダウングレードはこの月の月末から適用されます。当月分の従量課金は通常通り発生します」という注意事項を **明示的に確認させる** 設計とする。

アップグレード (Beginner → Expert / Pro) と Expert ↔ Pro 切替は即時反映する。

#### 抽出した追加ルール

- [ ] **per-API-call の「1 回」はユーザに見える機能単位で定義**: 内部 API 呼び出し数とは独立させることで、内部最適化が請求額に影響しない設計を実現
- [ ] **pure metered billing には月次予算上限の自己設定機能を必ず併設**: 「使った分だけ」の公平性は、「いくら請求されるか分からない」不安と表裏一体。予算上限機能でこの不安を解消することが法人ユーザの導入を可能にする
- [ ] **ダウングレードは月の途中に適用しない**: 月末ぎりぎりの操作で当月分の課金を回避する悪用を、遅延適用 (翌月から有効) で構造的に防ぐ
- [ ] **「1 操作 = 1 課金」の単純化はユーザの心理的障壁を下げる**: per-token のような技術的計算ではなく、ユーザが直感的に予測できる単位で課金することで、機能利用への躊躇を最小化する
- [ ] **価格設定は外出し化して運用中に調整**: 初期値はあくまで叩き台で、実運用データを集めて柔軟に変更できる構造を設計初期から組み込む

---

## 5.X ログイン失敗系メッセージは「失敗カテゴリごとに UI を分岐」させる (PR fix/login-failure / 2026-05-03)

### 背景

本番運用中、ユーザから「正しい認証情報なのにログインできない」報告が発生。Vercel ログ上は `POST /api/auth/callback/credentials` が **200** を返しており、HTTP レベルでは成功扱いだったが、UI には「メールアドレスまたはパスワードが正しくありません」と表示されていた。

調査の結果、根本原因は以下:

1. NextAuth の `authorize()` は失敗時に `null` を返すと、HTTP レスポンス自体は 200 だが内部的に「認証失敗」扱い
2. login UI は `signIn()` の `result.error` を見て `/api/auth/lock-status` を呼び、ロック判定 (永続/一時/none) でメッセージを分岐
3. ところが **`is_active=false` (非活性) の場合、`lock-status` は `none` を返していた**
4. 結果、UI は「パスワード間違い」のメッセージを表示し、ユーザは原因不明のままログイン試行を繰り返す UX バグになっていた

### 抽出したルール

- [ ] **「ログイン失敗 = パスワード間違い」と決め打ちしない**: 失敗カテゴリ (パスワード間違い / 永続ロック / 一時ロック / 非活性 / ユーザ不在) は本質的に異なる事象で、ユーザへの対処指示も異なる。「メールアドレスまたはパスワードが正しくありません」を fallback として、それ以外の確定可能な失敗理由は専用メッセージで分岐させる
- [ ] **enumeration リスクと UX 改善はトレードオフではない場合がある**: 既に `permanent_lock` でユーザ存在を露出しているなら、`inactive` を追加しても新規漏洩リスクはゼロ。「enumeration が怖いから非活性を非表示にする」という判断は、既存の漏洩面を見落とした過剰な保守化になり得る
- [ ] **本番障害は `auth_event_logs` のような構造化監査ログがあれば即特定可能**: HTTP レスポンスコードや UI メッセージだけでは原因切り分けに時間がかかる。失敗系イベントは「detail.reason に列挙値で理由を残す」設計にしておけば、SQL 1 本で特定できる。サーバ console.error は補助 (DB 接続不能時のみ機能)
- [ ] **ログイン失敗ログには認証情報を絶対に出さない**: パスワードはもちろん、email も完全形では出さず `tep***@gmail.com` 形式でマスクする。enumeration を促進せず、診断には十分な情報量を保つ妥協点
- [ ] **UX バグの調査は「UI に出ているメッセージから DB に到達する経路」を全部辿る**: 今回は UI の `invalidCredentials` →`lock-status` の `none` →`is_active` を見ていなかった、というルートを辿って初めて特定できた。「正しいパスワードなのに失敗」という症状から最初に疑うべきは「パスワードが本当に正しいか」ではなく「失敗判定が誤っていないか」

---

## 5.X+1 schema.prisma の変更は本番 DB に自動反映されない (PR fix/missing-migrations / 2026-05-03)

### 背景

本番でログイン全停止の障害が発生。Vercel ログには `CallbackRouteError` が出ており、Prisma クエリが「`The column users.tenant_id does not exist`」エラーで失敗していた。

DB クエリで User 行を確認すると `is_active=true / permanent_lock=false / locked_until=NULL` と問題なし。コード上 `prisma.user.findFirst({ where: { email, deletedAt: null } })` は **明示的な `select`** が無いため SELECT * 相当で全カラムを取得しに行く。schema.prisma 上は `tenant_id` が存在するが、本番 DB には未追加だったためクエリ自体が失敗していた。

調査の結果、以下 3 つの設定の組み合わせで「schema.prisma の変更が本番に届かない」状態になっていた:

1. **vercel.json の buildCommand に `prisma migrate deploy` がない**: 本番デプロイ時に migration が自動適用されない
2. **`prisma.config.ts` の `datasource.url` に DIRECT_URL fallback はあったが、buildCommand から呼ばれない設定だった**: DIRECT_URL 自体は認識される構造になっていたが、Vercel build がそもそも `prisma migrate deploy` を呼んでいなかったため意味をなしていなかった。Prisma 7 では `url` / `directUrl` を `schema.prisma` に書けず (P1012)、`prisma.config.ts` で集約管理する仕様変更にも要注意
3. **手動運用ドキュメントだけが存在**: 「Supabase SQL Editor で SQL を貼り付ける」運用が前提だったが、PR が増えるにつれ抜け漏れが構造的に発生

### 抽出したルール

- [ ] **schema.prisma の変更は単独で本番に届くと思わない**: Prisma migration ファイルが repo に commit されても、それは「適用予定の SQL」であって「適用済みの SQL」ではない。`_prisma_migrations` テーブルの状態と分けて考える
- [ ] **Vercel build に `prisma migrate deploy` を組み込むなら、`prisma.config.ts` で DIRECT_URL を fallback 指定 + Vercel 環境変数 `DIRECT_URL` (port 5432) の両方が必要**: Prisma 7 では `url`/`directUrl` を schema.prisma に書けず prisma.config.ts に集約。pgbouncer 経由 (port 6543) では DDL が失敗するため Session Pooler (port 5432) を使う必要あり
- [ ] **「手動 SQL Editor 運用」は migration 件数が増えると確実に抜け漏れる**: マイグレーションが累積する状況では人手作業はスケールしない。自動化を前提に最初から組み立てる方が事故を防げる
- [ ] **本番障害の症状が「特定の DB クエリだけ失敗」ならスキーマ drift をまず疑う**: 認証 (毎回 SELECT *) は失敗するが、明示 `select` を持つクエリ (lock-status の `select: { permanentLock: true, lockedUntil: true }` 等) は通る — この症状が出たら 100% スキーマ drift
- [ ] **Prisma の `_prisma_migrations` テーブルは本番調査の最初の確認先**: `SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 10;` で適用履歴が一目で分かる。コード側の `prisma/migrations/` ディレクトリ内容と突合すれば未適用 migration がすぐ特定できる

