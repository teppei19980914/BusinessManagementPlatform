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

**Beginner プラン (無料)**: 最大 5 席、Claude Haiku、月間 100 回までの API 呼び出し上限。試験運用と上位プランへのアップセル誘導の入り口として機能する。100 回到達時は **縮退モード**（[docs/business/TENANT_AND_BILLING.md §34.14.4](../business/TENANT_AND_BILLING.md) / NF-13.14、エンティティ作成・更新は継続、AI 裏方処理のみ一時停止、提案エンジンは NULL 候補をタグ：テキスト = 5：5 で評価、月初バッチで補完）に切り替わり、月初に自動リセット。

**Expert プラン (席数無制限・従量課金)**: Claude Haiku、API 呼び出し 1 回あたり ¥5 (2026-05-15 改定: ¥10 → ¥5)。月間使用量に上限なし。

**Pro プラン (席数無制限・従量課金、Sonnet)**: Claude Sonnet、API 呼び出し 1 回あたり ¥15 (2026-05-15 改定: ¥30 → ¥15)。深い説明文付きの最上位プラン。

価格は初期値であり、**実運用データを見ながら段階的に調整** する想定。Tenant テーブルの `pricePerCallHaiku` / `pricePerCallSonnet` カラムに保存し、admin による外部から調整可能。

#### 「1 回」の課金単位の定義

API 呼び出しの「1 回」は **ユーザに見える機能単位** で定義する。新規プロジェクト作成時の自動タグ抽出 + 初回提案生成は内部的に複数の LLM / Embedding 呼び出しを伴うが、ユーザから見て 1 操作なので 1 回としてカウントする。embedding 生成 (バックグラウンド処理) は課金対象外で運用者が吸収する。

これによってユーザは「自分のクリック数 ≒ 課金額」と予測でき、Phase 3 のキャッシュヒット率向上などの内部最適化を進めても請求額に影響しない設計となる。

#### 月次予算上限の自己設定とリアルタイム使用量ダッシュボード

pure metered billing の最大の弱点である「請求額の予測不可能性」を、**ユーザ自身が月次予算上限を設定できる仕組み** で解消する。例: 「月最大 ¥10,000 まで」と設定すると、その金額に達した時点で **縮退モード** に自動切替される（詳細は [docs/business/TENANT_AND_BILLING.md §34.14.4](../business/TENANT_AND_BILLING.md) / NF-13.14 参照）。法人ユーザの導入障壁を大きく下げる重要機能で、Stripe / Twilio など主要な従量課金 SaaS が採用する標準パターンである。

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

---

## 5.X+2 Supabase の DIRECT_URL は「Direct connection」ではなく「Session Pooler」を使う (PR fix/missing-migrations 続編 / 2026-05-03)

### 背景

PR #234 で `vercel.json` に `prisma migrate deploy` を組み込んだが、Vercel build がエラー `P1001: Can't reach database server at db.[ref].supabase.co:5432` で失敗した。

調査の結果、Supabase Dashboard の Connection string ページには **3 種類の URL** が表示されており、ユーザは「Direct connection」(host=`db.[ref].supabase.co`) を `DIRECT_URL` に設定していた。これは **IPv6 のみ**で公開されており、Vercel build 環境 (IPv4 のみ) からは到達できない。

正解は **Session Pooler** (Supavisor、host=`aws-1-[region].pooler.supabase.com:5432`) を使うこと。同じ host で port 5432 が Session、6543 が Transaction。Session は DDL 可、Transaction は DDL 不可。

### URL 種別の整理

| URL 種別 | Host | Port | IP | 用途 |
|---|---|---|---|---|
| Direct connection | `db.[ref].supabase.co` | 5432 | **IPv6 のみ** | ローカル開発 (IPv6 環境) |
| Session Pooler | `aws-1-[region].pooler.supabase.com` | **5432** | IPv4 互換 | **Vercel migrate (DIRECT_URL)** |
| Transaction Pooler | `aws-1-[region].pooler.supabase.com` | 6543 | IPv4 互換 | アプリ runtime (DATABASE_URL, `?pgbouncer=true`) |

### 抽出したルール

- [ ] **Supabase の DIRECT_URL は「Session Pooler」を使う (Direct connection ではない)**: `db.[ref].supabase.co` は IPv6 のみで Vercel から使えない。同じ port 5432 でも host が異なる: `aws-1-[region].pooler.supabase.com:5432` が正解
- [ ] **「Connection string ページに 3 種類ある」事実を最初に把握**: Direct / Session Pooler / Transaction Pooler。それぞれ用途が異なり、UI 上のタブで切替えて表示する。Supabase の docs を読まずに Dashboard で適当にコピーすると Direct を選んでしまいがち
- [ ] **Vercel build エラー `P1001: Can't reach ... db.[ref].supabase.co:5432` を見たら 100% IP プロトコル不整合**: ホスト名が `db.` で始まっている時点で Direct connection (IPv6 only)。`pooler.supabase.com` に書き換えれば解消する。他のエラーパターン (DNS / firewall / credentials) と混同しないこと
- [ ] **`.env.example` の Supabase サンプル URL は `pooler.supabase.com` で書く**: `db.[ref].supabase.co` のサンプルを `.env.example` に書くと、ユーザがそのまま Vercel に登録して事故る。本番想定なら必ず Session Pooler 形式 (本リポジトリの `.env.example` も誤った Direct connection サンプルが残っていたため、フック保護を解除のうえ修正対象)

---

## 5.X+3 LLM 機能の本番投入には「緊急停止フラグ」を最初から仕込む (PR #8 / T-03 リリース準備 / 2026-05-03)

### 背景

T-03 提案エンジン v2 のリリース準備 (PR #8) で、**外部 LLM API (Anthropic / Voyage) に依存する機能を本番投入する以上、緊急時に即座に停止できる仕組み**が必須と判断。

想定される緊急停止シナリオ:
- LLM API の障害で大量エラーが発生し、ユーザ体験が劣化している
- 月次予算超過で全テナントへの課金を即座に止めたい
- リグレッション (新リリースでのバグ) を切り分けるため一時無効化したい
- 想定外の使用量スパイクで Voyage 200M 無料枠を食い潰しそう

DB ベースのフラグだと「DB アクセス不能時に効かない」ジレンマがあるため、**環境変数 (`SUGGESTION_ENGINE_DISABLED=true`) で即時切替**できる仕組みを採用。Vercel 環境変数 + Redeploy で 2 分以内に全停止可能。

### 抽出したルール

- [ ] **外部 API に依存する機能は「緊急停止フラグ」を最初から実装する**: 後付けで追加すると、緊急時に「実装してからデプロイ」で間に合わない。最初の PR で env var チェックを 1 行入れておく
- [ ] **緊急停止フラグは環境変数ベース、DB ベースは避ける**: 障害時に DB にアクセスできない可能性がある。Vercel 環境変数なら build artifact に含まれるため DB 障害でも有効
- [ ] **緊急停止時の挙動は「空配列を返す」が安全**: error throw だと連鎖障害を起こすため、UI に対しては「候補なし」と同等の応答を返すのが優雅
- [ ] **緊急停止フラグの切替手順を運用ドキュメントに必ず明記**: コードを書いた人だけが知っている状態だと、緊急時に他のメンバーが対応できない。`docs/operations/T-03_RELEASE_NOTES.md §緊急停止手順` に scenario 別の SQL/env var 操作を文書化
- [ ] **テスト時は環境変数を beforeEach で reset、afterAll で原状復帰**: グローバル状態を変える feature flag のテストは並列実行で他テストに影響する。明示的に save/restore を記述する

## 5.X+4 推移的依存 (transitive dependency) の脆弱性は `pnpm.overrides` で force-upgrade する (PR #283 hotfix / 2026-05-09)

### 背景

PR #283 で Security Scan (`.github/workflows/security.yml` の `pnpm audit --audit-level=high` ステップ)
が **HIGH 2 件で fail**。発見された脆弱性は両方とも `fast-uri` (3.1.0) の経由問題:

- GHSA-q3j6-qgpj-74h6: path traversal via percent-encoded dot segments (<=3.1.0, fixed in >=3.1.1)
- GHSA-v39h-62p7-jpjc: host confusion via percent-encoded authority delimiters (<=3.1.1, fixed in >=3.1.2)

依存パスは `prisma > @prisma/dev > @prisma/streams-local > ajv > fast-uri` の **5 段ネスト**。
`prisma` のメジャー更新を待っても fast-uri のパッチには到達しない可能性が高く、また
`shadcn > @modelcontextprotocol/sdk > ajv` 経由でも同じ ajv@8.18.0 を使っているため
両エコシステム同時に救済する必要があった。

### 対応 (2 行 diff)

`package.json` の `pnpm.overrides` に 1 行追加:

```diff
   "overrides": {
     "@hono/node-server": ">=1.19.13",
     "hono": ">=4.12.16",
     "postcss": ">=8.5.10",
-    "ip-address": ">=10.1.1"
+    "ip-address": ">=10.1.1",
+    "fast-uri": ">=3.1.2"
   }
```

その後 `pnpm install` で `pnpm-lock.yaml` を再生成し、`pnpm audit --audit-level=high` で
"No known vulnerabilities found" を確認。これで 5 つ目の override 運用となり、
**「transitive 脆弱性 → overrides 1 行追加」というワークフローが本リポジトリで定着** した。

### 抽出したルール

- [ ] **`pnpm audit` failure を見たら最初に `pnpm why <package>` でパスを確認**: 直接依存なら通常の version bump、transitive なら overrides。「どの直接依存が古いのか」を特定するのが先決
- [ ] **`pnpm.overrides` は **patched version の最小値** で書く**: `">=3.1.2"` のように下限のみ指定し、メジャー上限は付けない。CI が次の advisory を拾った時に自動で最新パッチを取り込める
- [ ] **複数経路 (ajv が 2 つ以上の dep tree から呼ばれる等) でも overrides は 1 つで足りる**: pnpm の overrides は **resolved 結果** に効くため、すべての経路の同名パッケージが同じバージョンに収束する
- [ ] **過去の overrides を消さない (= migration ノートとして残す)**: `@hono/node-server` / `hono` / `postcss` / `ip-address` / `fast-uri` の 5 件は本リポジトリでの脆弱性履歴そのもの。直接依存の更新で不要になった override も残しておくと、再発時の調査ヒントになる
- [ ] **PR 作成前にローカルで `pnpm audit --audit-level=high` を 1 回実行する習慣を**: CI でしか気付かないと「PR 作成 → CI fail → 修正 → 再 push」で往復が発生する。Vulnerability advisory は時間で増えるため、commit 時点では問題なくても push 時点で fail することがある
- [ ] **CI Gate (`security.yml`) を絶対にスキップしない**: HIGH 以上は build を止める運用。例外的に「依存元側にしかパッチがない」case でも、最低限 issue を切ってトラッキングする (silent ignore は厳禁)

## 5.X+5 認可仕様 (MFA 強制対象) を緩和したら E2E アサーションと visual baseline 両方を更新する (PR #283 hotfix / 2026-05-09)

### 背景

PR #283 (#11 「テナント管理者の MFA を任意化」) で MFA 強制対象を `admin` → `super_admin` に
変更したところ、E2E 2 系統が連鎖 fail した:

1. **機能 spec** `01-admin-and-member-setup.spec.ts:114` Step 2 が
   `await expect(page.getByText('強制有効化 (解除不可)')).toBeVisible()` で fail。
   → 旧仕様 `systemRole === 'admin'` 前提のアサーション。新仕様では admin にこのバッジは出ない。
   この test が fail した結果、`mode: 'serial'` で連鎖する Step 2b〜Step 6b が **6 件 skip**
   され、見かけ上「7 件 fail」相当の影響に拡大。
2. **視覚回帰** `dashboard-screens.spec.ts:74` (settings-light) と `settings-themes.spec.ts:68`
   (10 テーマ × 設定画面) が pixel diff で fail。`admin` ユーザのスナップショットだったため
   バッジ消失分の差分が出た。

### 対応 (2 つを 1 PR で完結させる)

1. **Step 2 アサーションを新仕様に書き直し** (この test は admin = テナント管理者なので、
   有効化後の状態は「`MFA を有効化する` ボタン消失 + `有効` バッジ + `MFA を無効化する`
   ボタン表示」で確認する。super_admin 強制の確認は別 spec に分ける):

```diff
- await expect(page.getByText('強制有効化 (解除不可)')).toBeVisible({ timeout: 10_000 });
+ await expect(page.getByText('有効', { exact: true })).toBeVisible({ timeout: 10_000 });
+ await expect(page.getByRole('button', { name: 'MFA を無効化する' })).toBeVisible({
+   timeout: 10_000,
+ });
```

2. **空コミットで baseline 再生成 workflow をトリガ**:

```bash
git commit --allow-empty -m "chore: regenerate visual baselines after MFA optional UI change [gen-visual]"
git push
```

`[gen-visual]` タグ付き push は `.github/workflows/e2e-visual-baseline.yml` を発火し、
`pnpm exec playwright test e2e/visual --update-snapshots` を CI で実行 → 差分があった
PNG を `Update visual baselines (e2e-visual-baseline workflow)` commit で自動 push する。

### 抽出したルール

- [ ] **認可ロールの分岐文言を変えたら、文言にマッチする E2E test を `grep` で総当たり確認**: `'強制有効化'` / `'解除不可'` / `'MFA 必須'` 等のマジック文字列は、機能 spec / visual spec / i18n message の 3 箇所に散らばる。コード変更時に `git grep` で全箇所を洗い出すルーチンを徹底
- [ ] **`mode: 'serial'` の test ファイルでは「最初の fail が連鎖 skip を起こす」**: skip された test は CI 上は別 line item に見えるが原因は 1 箇所。fail の根本原因 1 件を直せば連鎖 skip も解消するため、まず先頭 fail を fix することに集中する
- [ ] **UI 変更を伴う認可緩和の PR は `[gen-visual]` を最初の commit から含めるか、PR 作成直後に空コミットで発火させる**: PR 作成 → e2e fail → `[gen-visual]` push → 再実行 で 1 サイクル余分にかかる。事前に「視覚スナップショットを取る画面 (settings, dashboard 等) に触る変更か?」を判断し、touch するなら CI 一発目から baseline 再生成を組み込む
- [ ] **新旧の認可挙動を別 spec に分けて両方カバーする**: 旧仕様 (`super_admin` 強制) を消さず別 test として残すと、後から「super_admin の MFA 強制が壊れた」regression を catch できる。`#11` 緩和後は admin spec で「任意化済」、super_admin spec で「強制継続」を別々にアサートする
- [ ] **連鎖 skip の影響範囲を PR description に明記**: 1 件 fail → 6 件 skip のような場合、原因と修正箇所を「失敗 1 件、skip 6 件 (= 同一原因)」と書くことで、レビュアが何を見ればよいか即時に判断できる



## 5.X+6 新テーブル追加時は cascade 削除パスの全洗い出しが必須 (P-3 / 2026-05-08 → 本番障害 / 2026-05-09)

### 背景

P-3 (PR #259 / 2026-05-08) で `SuggestionExplanation` テーブルを新設した際、
**cascade 削除のパスを更新し忘れ** て本番で project 削除が 500 エラーで失敗:

```
PrismaClientKnownRequestError: Foreign key constraint violated on the constraint:
  `suggestion_explanations_project_id_fkey`
prisma.project.delete() invocation
```

`SuggestionExplanation` は `project_id` / `tenant_id` / `generated_by` の 3 経路で
FK を持っており、それぞれ Project / Tenant / User の物理削除前に明示的に
deleteMany する必要があった。`deleteProjectCascade` (project-level) と
`purgeOldDeletedTenants` (tenant-level) のどちらも漏れていた。

ON DELETE CASCADE を FK に付与する選択肢もあったが、本リポジトリの既存パターン
(他の child テーブル: Comment / Attachment / TaskProgressLog 等) は **manual cleanup**
で統一されているため、踏襲した。

### 対応

1. `deleteProjectCascade` の `prisma.project.delete()` 直前に
   `prisma.suggestionExplanation.deleteMany({ where: { projectId } })` を追加
2. `purgeOldDeletedTenants` の `$transaction` 内、`project.deleteMany` の前に
   `suggestionExplanation.deleteMany({ where: { tenantId } })` を追加
3. 回帰テストで「project.delete 前に suggestionExplanation.deleteMany が呼ばれる」を verify

### 抽出したルール

- [ ] **新テーブル追加 PR には「cascade 削除パスの更新有無」をレビューチェックリストに含める**: 単体テストでは検出できない (削除対象テーブルが空なら通る)。本番でデータが入って初めて顕在化する罠
- [ ] **FK を持つテーブル新設時は 3 経路 (parent table A / B / C) の **全ての** delete code path を grep で洗い出す**: `grep -rn 'project.delete\|project.deleteMany' src/services/` のように grep で複数箇所を一気に拾い、漏れチェックする
- [ ] **「delete cascade is implicit」と思い込まない**: Prisma schema 上 `relation` を書いただけでは Postgres FK には `ON DELETE NO ACTION` が設定される。`onDelete: Cascade` を schema 側で明示するか、application 側で manual cleanup を書くかの **どちらかが必須**
- [ ] **本番で再現した cascade 漏れバグは `deleteProjectCascade` テストの「呼出順序」テストで再発防止**: `expect(prisma.suggestionExplanation.deleteMany).toHaveBeenCalledWith({ where: { projectId } })` のような mock 呼出検証で「次の新設テーブル追加時に同じ罠を踏む」を防ぐ
- [ ] **`purgeOldDeletedTenants` の `$transaction` 配列は順序が FK 依存関係**: 順序を間違えると別の FK が先に火を吹くため、変更時は `git diff` で行追加位置を慎重に確認する

## 5.X+7 ブランチカバレッジ閾値 (70%) 維持戦略 (PR #289 hotfix / 2026-05-09)

### 背景

PR #289 (PR E ダッシュボード強化) で **branches 69.66% < 70% 閾値** で CI fail:

```
ERROR: Coverage for branches (69.66%) does not meet global threshold (70%)
```

PR E は `super-admin.service` に新規 3 関数 (Voyage / Anthropic / Beginner サマリ) を
追加し、それぞれが内部で複数の if 分岐 (status='ok'/'warn'/'alert' 等) を持つため、
**コードの追加に対してテストがない = ブランチ未到達** が増えて閾値を割った。

### 対応

1. **ブランチ未到達の上位ファイルを特定**:
   ```
   pnpm test --coverage
   ```
   出力をブランチ % 昇順でソートし、最も低いファイルから着手。

2. **今回の上位ターゲット**:
   - `tenant-self.service.ts` (18.86% → 80%+) - **最大インパクト**: テスト未作成だった
   - `super-admin.service.ts` (新規 3 関数) - 各関数の 3-4 分岐をテスト

3. **追加テスト**:
   - `tenant-self.service.test.ts` を新規作成 (18 件)
     - getTenantSelfInfo: テナント不在 / 取得成功 + 派生フィールド
     - updateBillingContact: 部分更新 / individual 切替時の null クリア / null 値クリア
     - updateTenantSelf: budget 単独 / seedDataEnabled 単独 / 同一プラン / アップグレード /
       ダウングレード予約 / Beginner ダウングレード禁止
     - cancelScheduledPlanChange: 予約クリア
   - `super-admin.service.test.ts` に 12 件追加
     - getVoyageUsageSummary: ok/warn/alert 3 段階 + null fallback + 除外フィルタ
     - getAnthropicUsageSummary: 通常 / null fallback / where OR 検証
     - getBeginnerUsageSummary: 0 件 / 60/75/expired 分類 / 除外フィルタ

   結果: branches **69.66% → 71.15%** (+1.49pt) で閾値クリア。

### 抽出したルール

- [ ] **新規関数を追加する PR には**「対応する unit test を同 PR で追加」**を必須化**: PR 説明に test コミット ID を明記。あとから補完すると忘れがち
- [ ] **branch coverage は新規 if/switch 分岐を入れるたびにストレスがかかる**: 既存ファイルの分岐は tested 済が多いが、**新規ファイル / 新規関数は 0% から始まる** ため、コード追加直前のスコアからの劣化幅が大きい
- [ ] **branch coverage 80% に上げる前に 70% を必達ライン化**: 防御的 if (= defense-in-depth) は実用上テストしづらく 80% は過大負荷。70% で「主要分岐は全て tested」が保証されればトレード OK (vitest.config.ts §thresholds 参照)
- [ ] **集計関数 (aggregate / groupBy) のテストは where 句の検証が肝**: 値の正しさだけでなく `notIn: [MANAGEMENT, DEFAULT]` の包含を `expect(...).toMatchObject({ where: { id: { notIn: [...] } } })` で検証する。回帰: テナント除外漏れは集計値の誤りに直結する
- [ ] **現在時刻に依存する関数は `daysAgo(N)` のような相対日付ヘルパで再現**: `Date.now()` を直接モックすると beforeEach での復元忘れによる他テスト汚染リスクがある。今回は `getBeginnerExpiryState` のテストで採用
- [ ] **PR 提出前にローカルで `pnpm test --coverage` を実行**: CI で発覚すると 1 サイクル余分 (CI fail → 修正 → 再 push)。ローカル実行 1 分で同じ情報が得られる

## 5.X+8 1:N → M:N への asset 紐付けモデル変更パターン (PR feat/asset-multi-project-linking / 2026-05-09)

### 背景

`Knowledge` は当初から M:N (`KnowledgeProject` 中間テーブル) で複数プロジェクトに紐付け可能だったが、
`RiskIssue` / `Retrospective` は単一 `projectId` の 1:N で「1 リスク = 1 プロジェクト専属」だった。
ユーザ要件: 「**A プロジェクトで作成した資産を B でも紐付けたい。A 削除でも B が参照中なら資産は残す。
最後の紐付けプロジェクト削除時に cascade 選択した場合のみ物理削除する**」を満たすため、
リスク/課題/振り返りも Knowledge と同じ M:N モデルに統一した。

### 移行で踏んだ落とし穴

#### 落とし穴 1: `project_id` を NOT NULL のまま残すと cascade 削除で FK 違反

旧スキーマでは `risks_issues.project_id` は NOT NULL + RESTRICT FK。M:N 化後も「作成元プロジェクト」
(audit 用) として残置したかったが、project 削除時に「資産は残し createdInProjectId を NULL に」
を実現するには **nullable + ON DELETE SET NULL** に変更が必要。NOT NULL のままだと FK 違反で
project.delete が失敗する。

#### 落とし穴 2: 「このプロジェクトの一覧」query の where 句

旧 `where: { projectId }` は「作成元一致」を意味する別概念になる。新仕様では「このプロジェクトに **紐付け済**」
を意味する `where: { riskIssueProjects: { some: { projectId } } }` に置換する必要がある。
影響範囲は service / API / sync-import / data-export と広い。**全件検索で `where: { projectId }` を
置き忘れると「自プロジェクトで作ったレコードしか見えなくなる」regression** が起きる。

#### 落とし穴 3: DTO の projectId 型変更が UI 型まで波及

`RiskDTO.projectId: string` → `string | null` にすると、`RiskLike` / `RetroLike` などの dialog 用
小型インターフェイスにも null 化を伝播させないと TS error 連鎖。**DTO 変更時は依存型を grep で全件
洗い出して同 PR で修正**。

#### 落とし穴 4: API ルートの「このプロジェクトのレコードか」判定

`GET /api/projects/:projectId/risks/:riskId` 等で `existing.projectId !== projectId` で「他プロジェクト
の risk を弾く」していた。新仕様では `!existing.linkedProjectIds.includes(projectId)` に置き換え。
`linkedProjectIds: string[]` を DTO に追加する必要がある (`include: { riskIssueProjects: { ... } }`)。

### 抽出したルール

- [ ] **1:N → M:N への移行は 5 つのレイヤーをすべて触る**: ① Schema (中間テーブル + nullable + SET NULL) → ② Migration (既存データを M:N にコピー + ALTER COLUMN) → ③ Service (where 句を `riskIssueProjects: { some: { projectId } }` に) → ④ API ルート (`linkedProjectIds.includes(projectId)` チェックに) → ⑤ DTO/UI 型 (projectId を nullable に + linkedProjectIds 追加)
- [ ] **Knowledge 既存実装をリファレンスに**: 同型移行 (RiskIssueProject / RetrospectiveProject) は KnowledgeProject の cascade ロジック / linkXxx pattern をコピペベースで進められる。差分はエンティティ名のみ
- [ ] **「作成元プロジェクト」を残すなら必ず SET NULL FK**: NOT NULL + RESTRICT のままでは project 削除時に FK violation が発生し、cascade 選択しなかった場合の orphan 化が成立しない
- [ ] **新中間テーブル追加時は data-export.service と sync-import.service も忘れずに更新**: tenant export ZIP に新中間テーブル JSON を含める / sync-import の `existing` 取得を M:N 経由に変更。漏れると「export 後の re-import で紐付けが消える」silent data loss
- [ ] **「最後の紐付けが消えたら物理削除」ロジック**: deleteProjectCascade で `prisma.X.count({ where: { Yid } }) <= 1` なら delete、超えていれば unlink のみ。Knowledge §752-784 の既存ロジックを横展開

## 5.X+9 ローカル必須チェックの整理 — セキュリティ/パフォーマンスを CI / 都度対応に分離 (2026-05-09)

### 背景

旧運用では CLAUDE.md「コミット前チェック」に **7 項目** が並んでおり、毎回の実装完了時に
全項目を確認する負荷が大きく、開発効率を圧迫していた。特に下記 2 項目は冗長:

- **セキュリティチェック**: 既に GitHub Actions `.github/workflows/security.yml` が PR ごとに
  `pnpm tsx scripts/security-check.ts --min-score=90` で自動実行 (§5.46〜§5.48 で確立済)。
  ローカル手動チェックと CI チェックの **二重実行** になっていた。
- **パフォーマンスチェック**: 予防的 N+1 検査は実コード変更との関連が低く、ユーザリクエスト時に
  ピンポイントで対応する方が効果的。

一方で、ソースコード規模の拡大に伴い **退行 (リグレッション) の検出コスト** が増えており、
退行テスト (単体 + E2E) の徹底にリソースを集中させたい背景がある。

### 対応

CLAUDE.md「コミット前チェック」を **5 項目に再編** し、退行チェックを最重点項目化:

| 旧 (7 項目) | 新 (5 項目) | 変更 |
|---|---|---|
| 横展開チェック | 横展開チェック | 維持 |
| セキュリティチェック | — | **撤廃 → CI 自動 (security.yml)** |
| パフォーマンスチェック | — | **撤廃 → ユーザリクエスト時 都度対応** |
| デプロイチェック | デプロイチェック (lint/tsc/test/build) | 維持 + tsc 明記 |
| 単体テスト | **退行（リグレッション）チェック (重点)** | 単体 + E2E 統合 (両観点併記) |
| E2E カバレッジ横展開 | (退行チェック内に統合) | — |
| ドキュメント最新化 | ドキュメント最新化 | 維持 |
| — | E2E ローカル実行 (任意) | **新設** (CI 待ちの往復削減) |

連動更新:
- `.claude/skills/quality-check.md` Step 2 を 6 項目 → 4 項目に整理 (security/performance を除外)
- `.claude/skills/fix-issue.md` 観点別レビューエージェント並列実行を必須から外し、ユーザ依頼時のみ実行に変更
- `.claude/skills/threat-model.md` Mode B-1「全 PR で必須」を「ユーザ依頼時のみ」に変更 (CI 自動に一本化)
- `.claude/agents/performance-reviewer.md` ヘッダに「ユーザリクエスト時のみ呼出」を明記

### 抽出したルール

- [ ] **「ローカル必須」 vs 「CI 自動」 vs 「都度対応」を年に 1 回見直す**: ツールが CI 自動化されたら
      ローカル必須から外す。二重実行は開発効率を下げる
- [ ] **退行テスト (単体 + E2E) は別観点で両方残す**: 単体は分岐ロジック / 認可マトリクスを高速 (~12 秒) に
      検出、E2E は画面 → API → DB の統合動作を検出。E2E で単体を代替するのは非効率 (UI 経由で全分岐を
      網羅するシナリオを書くと数十分かかる)
- [ ] **撤廃する仕組みは「代替手段の所在」を明記**: 「セキュリティはどこで担保?」と聞かれて即答できる
      ように、撤廃時の代替 (CI workflow の path / agent 名) を CLAUDE.md / skill に書き残す
- [ ] **ローカル必須チェックの数は最小化**: 開発効率は (項目数 × 実行頻度) の関数。「毎回必須」は
      本当に毎回必要か疑い、`pnpm test` レベルの高速・幅広いものに絞る

### 関連

- CLAUDE.md「コミット前チェック」(本改訂の最終版)
- §5.46 〜 §5.48 (security-check.ts 導入と CI gate 化の経緯)
- 修正例: 2026-05-09 (本セクション、CLAUDE.md + .claude/skills/* + .claude/agents/* 一斉更新 PR)

## 5.X+10 GitHub Actions の脆弱なアクションを避け公式 install スクリプトで CI 化する (PR #296 hotfix / 2026-05-09)

### 背景

PR #296 で OSV-Scanner / Trivy を CI に追加したところ、3 つの fail が発生:

1. **OSV-Scanner**: `google/osv-scanner-action@v1` で `Unable to resolve action ... unable to find version 'v1'`
   → Marketplace のパス命名 (`/osv-scanner-action/osv-scanner-action@vX.Y.Z`) が変動し、`@v1` major タグが存在しない
2. **Trivy**: `aquasecurity/trivy-action@0.28.0` が **GHSA-69fq-xp46-6x23 (Trivy ecosystem supply chain was briefly compromised, CRITICAL)** にヒット
   → アクションそのものが公式に汚染認定され、安全な version の判定もリリースノートを跨ぐ手間が生じる
3. **Dependency Review**: 上記 Trivy アクションのバージョンを CI が `fail-on-severity: high` で検知し PR 全体が block

### 対応

両アクションとも **公式バイナリの install スクリプト経由に切替** て、Marketplace アクションへの依存を撤廃:

```yaml
# OSV-Scanner: GitHub API から最新リリースの linux_amd64 binary URL を解決して直接インストール
- name: Install osv-scanner
  run: |
    DL_URL=$(curl -sSfL https://api.github.com/repos/google/osv-scanner/releases/latest \
      | grep -oE '"browser_download_url": "[^"]*linux_amd64[^"]*"' \
      | head -n1 | sed -E 's/.*"(.*)"/\1/')
    curl -sSfL "$DL_URL" -o /usr/local/bin/osv-scanner
    chmod +x /usr/local/bin/osv-scanner
- name: Run osv-scanner
  run: osv-scanner --lockfile=pnpm-lock.yaml --recursive --skip-git .

# Trivy: 公式 install.sh で最新版 (stable) を取得
- name: Install trivy
  run: |
    curl -sSfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh \
      | sudo sh -s -- -b /usr/local/bin
- name: Run trivy fs
  run: |
    trivy fs --severity CRITICAL,HIGH --ignore-unfixed \
      --format sarif --output trivy-results.sarif --exit-code 1 .
- uses: github/codeql-action/upload-sarif@v3   # 公式 GitHub アクションは安全
  with: { sarif_file: trivy-results.sarif, category: trivy }
```

これにより:
- アクションのサプライチェーン汚染リスクを排除 (`actions/checkout` / `github/codeql-action` 等の **GitHub 公式 Verified アクションのみ使用**)
- 同時に「常時最新バイナリを使う」要件も満たせる (install スクリプトが latest を解決)
- Dependency Review の `fail-on-severity: high` も clean に通過する

### 抽出したルール

- [ ] **GitHub Marketplace の third-party アクションを採用する前に、Dependency Review の advisory DB と
      OSSF Scorecard を必ず確認する**: 過去に supply chain 汚染を起こしたアクション (例: `tj-actions/changed-files`、
      `aquasecurity/trivy-action` 等) は今後も risk が伴う。同等機能の **公式 install スクリプト** が
      存在する場合はそちらを優先
- [ ] **「最新を使う」要件はバージョン pin より install スクリプトが向く**: `@vX.Y.Z` pin は Dependabot
      週次更新でも反応が遅れがち。公式の `latest` 解決ロジック (curl + GitHub Releases API) なら
      毎ジョブで最新版が確定する
- [ ] **CI で利用するアクションは「`actions/*` (GitHub 公式) + `github/codeql-action`」のみを基本とし、
      それ以外は curl ベースインストールを優先する**: アクションが破壊された時の影響範囲を最小化
- [ ] **アクションの version error (`Unable to resolve action`) はパス命名規則を疑う**: monorepo 構成の
      アクション (`org/repo/subpath@vX`) は major tag が存在しないことがあるので、Marketplace ページで
      正確な uses 形式を確認 — または curl 化を検討する
- [ ] **PR の Dependency Review が fail したら advisory ID を必ず確認**: GHSA-* で過去のサプライチェーン
      事案を引いていることが多く、その場合はバージョン bump ではなく **アクション自体の置き換え** が必要

### 関連

- 修正例: PR #296 hotfix (2026-05-09)
- §5.46 〜 §5.48 (security-check.ts CI gate)
- §5.X+9 (ローカル必須 → CI 自動への分離方針)
- §5.X+11 (本セクションの install スクリプトが踏んだ次の罠 = `api.github.com` レート制限)

## 5.X+11 GitHub Actions から `api.github.com` を未認証で叩くと共有 IP の 60 req/hour 制限に当たる (PR #296 hotfix 続編 / 2026-05-09)

### 背景

§5.X+10 で OSV-Scanner を `api.github.com/repos/google/osv-scanner/releases/latest` の JSON を curl + grep で
解析して latest バイナリ URL を解決する方式に切り替えたが、**初回実行で install ステップが 245ms で死亡**:

- `set -euo pipefail` 配下なのに stderr/stdout に出力ゼロ
- `::error::Could not resolve ...` の echo にも到達せず
- `Downloading: ...` の echo にも到達せず

切り分けの結果、原因は **GitHub API の未認証レート制限 (IP 単位 60 req/hour)**:

- GitHub Actions ホストランナーは Azure の **共有 IP プール** を使用するため、自リポジトリが初めて API を叩いても
  同 IP の他テナントが先に枠を消費していると即 `403 rate limit exceeded` を踏む
- `curl -sSfL` は HTTP 4xx で exit 22 だが、`-f` の "Fail silently on server errors" によりエラー本文が出ず、
  さらにパイプ末尾の `head -n1` が早期 close → 上流に SIGPIPE を送る組み合わせで pipefail が即発火し
  ログ痕跡なしで step が die する

### 対応

GitHub が公式提供する **`https://github.com/<owner>/<repo>/releases/latest/download/<asset>` の安定リダイレクト URL**
に切り替え、`api.github.com` 経由の解決を撤廃:

```yaml
# Before (api 解析方式 — レート制限で fragile)
DL_URL=$(curl -sSfL https://api.github.com/repos/google/osv-scanner/releases/latest \
  | grep -oE '"browser_download_url": "[^"]*linux_amd64[^"]*"' \
  | head -n1 | sed -E 's/.*"(.*)"/\1/')
curl -sSfL "$DL_URL" -o /usr/local/bin/osv-scanner

# After (公式安定 URL 経由 — レート制限を受けない)
DL_URL="https://github.com/google/osv-scanner/releases/latest/download/osv-scanner_linux_amd64"
curl --retry 3 --retry-delay 2 -sSfL "$DL_URL" -o /usr/local/bin/osv-scanner
```

`releases/latest/download/<asset>` は github.com 側で 302 を返してくれるため:

- API 認証不要 (rate limit に該当しない通常の Web リクエスト)
- JSON parse 不要 (sed/grep 失敗の余地なし)
- pipefail + SIGPIPE 罠を踏まない (パイプを使わない)
- アセット名さえ stable なら **常に最新の stable リリース** に解決される

### 抽出したルール

- [ ] **CI ジョブ内で `api.github.com` を未認証で叩かない** — 共有 IP の rate limit (60 req/hour) は
      自プロジェクト由来でなくても枯渇する。代替は (a) `releases/latest/download/<asset>` の安定 URL、
      または (b) `secrets.GITHUB_TOKEN` を Authorization ヘッダで付与 (5000 req/hour に拡張)
- [ ] **`curl -sSf` + `head -n1` のパイプは pipefail と相性が悪い** — `head` の早期 close で上流に
      SIGPIPE が飛ぶため、`set -euo pipefail` 配下では非ゼロ終了の伏線になる。回避策: パイプを使わず
      安定 URL に直行する / `awk 'NR==1; {exit}'` で head の代替にする / pipefail を局所的に外す
- [ ] **CI step が「ログを残さず die」したら共有環境のリソース制限を疑う** — GitHub Actions の場合は
      `api.github.com` rate limit、Docker Hub anonymous pull limit、HashiCorp registry limit など。
      ローカル再現できないがランナーで再現する事象はだいたいこの系統
- [ ] **`-f` (fail silently) と `-S` (show errors) の組み合わせでも HTTP 4xx は黙殺されることがある** —
      curl のドキュメント上 `-S` は "connection error" にしか効かないケースが含まれる。診断時は
      `-w '%{http_code}\n'` や `--fail-with-body` (curl 7.76+) を使うとレスポンス本文が出て便利
- [ ] **GitHub の Releases には常に `latest/download/<asset>` の安定リダイレクト URL がある** — Marketplace
      にもベンダ自前 install.sh にも依存せず最新を取れる。サプライチェーン経路を最小化したい場合の第一候補

### 関連

- 修正例: PR #296 hotfix 続編 (2026-05-09)
- §5.X+10 (action 撤廃 → install スクリプト方針 — 本件はその install スクリプトが踏んだ次の罠)
- §5.X+12 (本セクションで「常に最新を取得」した結果、CLI 仕様変更を踏んだ)
- 公式 doc: <https://docs.github.com/ja/repositories/releasing-projects-on-github/linking-to-releases>
  ("最新リリースのファイルへのリンク")

## 5.X+12 「常に最新を取得」する設計は upstream の breaking change を直撃する — メジャーバージョン跨ぎ CLI を本番起動時に検出する仕組みが必要 (PR #296 hotfix 第三弾 / 2026-05-09)

### 背景

§5.X+10 / §5.X+11 で OSV-Scanner を「毎ジョブで最新 stable バイナリを取得 → 実行」する設計に統一した直後、
PR #296 の次の CI 実行で **OSV-Scanner v2.3.8 が `--skip-git` フラグを認識せず exit 127** で fail した。

```
Run osv-scanner --lockfile=pnpm-lock.yaml --recursive --skip-git .
Incorrect Usage: flag provided but not defined: -skip-git
##[error]Process completed with exit code 127.
```

事象解析:

- v1 系で有効だった `--skip-git` は v2 で **削除** された (Cobra → urfave/cli/v3 への移行と同時に CLI 仕様が再構成)
- 同等機能は **デフォルト挙動** に組み込まれた: `osv-scanner scan source` のフラグ `--include-git-root` (default `false`)
  → git root スキャンはデフォルトで OFF。v1 の `--skip-git` を渡す必要そのものがなくなった
- 我々の workflow は「latest stable を毎回取得」する設計のため、**OSV-Scanner v2 が released された瞬間に
  既存の起動オプションが breaking** した

### 対応

v2 系の正式サブコマンド形式に書き換え:

```yaml
# Before (v1 syntax — v2 では `--skip-git` 不存在で fail)
osv-scanner --lockfile=pnpm-lock.yaml --recursive --skip-git .

# After (v2 syntax — `scan source` サブコマンドに明示)
osv-scanner scan source --lockfile=pnpm-lock.yaml --recursive .
```

公式ソース ([cmd/osv-scanner/scan/source/command.go](https://github.com/google/osv-scanner/blob/main/cmd/osv-scanner/scan/source/command.go))
で v2 が受け付けるフラグを確認:

- `--lockfile` (`-L`): 残存
- `--recursive` (`-r`): 残存
- `--skip-git`: 削除 (代替: デフォルト挙動 + `--include-git-root` opt-in)
- `--no-ignore`: 新設
- `--data-source`: 新設 (`deps.dev` / `native`)

### 抽出したルール

- [ ] **「常に最新を取得」する CI 設計には breaking change 検出ステップを併設する** — `<tool> --version` で
      バージョンを echo + 失敗時のフラグ一覧 echo (`<tool> --help` を `|| true` で必ず流す) を install ステップに
      入れておくと、メジャーアップデート時の原因特定が秒で終わる
- [ ] **CLI ツールは「コマンド全体」を一次ソース (公式 git の cmd/.../command.go や cobra/cli 定義) で確認する** —
      Web ドキュメントは反映遅延がある。OSV-Scanner v2 のフラグ確認は
      `https://raw.githubusercontent.com/google/osv-scanner/main/cmd/osv-scanner/scan/source/command.go`
      を curl するのが最速・最確実
- [ ] **メジャーバージョン跨ぎ前提の install ピン候補を残しておく** — どうしても安定運用したい場合は
      `releases/download/<v_pinned>/<asset>` で **明示版 pin** する選択肢を残す。Dependabot は「実行ファイルの
      バイナリ pin」を更新できないので運用はマニュアルになるが、突発 fail を避けられる。
      本プロジェクトは「最新追従」を優先するためデフォルト stable URL のままだが、トレードオフは認識しておく
- [ ] **`exit code 127` (command not found / 不明オプション) は CLI 仕様変更を最優先で疑う** — Go の `flag` /
      `cobra` / `urfave/cli` はいずれも未知フラグで exit 1〜127 を返す。バイナリそのものの欠落 (PATH 通っていない)
      なら "command not found" を伴う bash メッセージが出るので区別がつく
- [ ] **CLI 起動オプションは「現バージョン公式の subcommand 形式」に揃える** — レガシー top-level 形式は
      compat layer で残ることはあるが breaking 対象になりやすい。`osv-scanner scan source ...` のように
      明示する方が将来の breaking に強い

### 関連

- 修正例: PR #296 hotfix 第三弾 (2026-05-09)
- §5.X+10 / §5.X+11 (本件の前段 — 同 PR の連続 hotfix 3 連鎖)
- 公式 ソース (一次): <https://github.com/google/osv-scanner/blob/main/cmd/osv-scanner/scan/source/command.go>
- 公式 doc: <https://google.github.io/osv-scanner/usage/>

## 5.X+13 マルチテナント越境バグの恒久対策パターン + 「過去指示が反映されない」根本原因と再発防止 (PR feat/issues-from-feedback-2026-05-09)

### 背景

ユーザから 2026-05-09 セッションで報告された 5 件のフィードバックのうち 2 件が「以前のセッションで指示済だが反映されていない」事例 (Defaultテナントのデータ非表示 / スマホ編集画面のリンク名 UI 崩れ)。

調査の結果:

1. **テナント越境バグ**: `listAll{Risks,Retrospectives,Knowledge}ForViewer` および `listProjects` / `listMyMemos` / `listPublicMemos` が `tenantId` フィルタを持たず、複数テナント運用時に他テナントのデータが漏れる重大バグだった。**個人情報漏洩 + 情報完全性侵害** に該当する severity-1 級。
2. **既存のフィルタは `isSampleData=false` のみ** = シードデータの除外しかしておらず、**テナント越境**の制御は別物。
3. リンク名 overflow は `linked-projects-section.tsx` (PR #294 で新設) に対策が抜けていた (truncate / min-w-0 / shrink-0 の欠落)。

「指示が反映されていない」根本原因は 3 通りに分解できた:

- (a) **会話だけで完結し、ナレッジ化されなかった (KDD Step 4 抜け)** — commit message のみに残り、後続セッションで `/recall` しても拾えない。本件の指示2 (mobile リンク UI) はこのパターン。
- (b) **指示は実装されたが、後続 PR で新コンポーネント (例: linked-projects-section.tsx) が追加された際に「同じ罠を再現させない」原則が適用されなかった (横展開漏れ)**。
- (c) **そもそも該当箇所が無く、別観点 (シード除外) で対応した気になっていた**。本件の指示1 (テナント越境) はこのパターン。

### 対策実装

1. **listAll 系すべてに `viewerTenantId` 引数を必須化** ([risk.service.ts:245](../../src/services/risk.service.ts#L245), [retrospective.service.ts:85](../../src/services/retrospective.service.ts#L85), [knowledge.service.ts:206](../../src/services/knowledge.service.ts#L206), [memo.service.ts:58-79](../../src/services/memo.service.ts#L58), [project.service.ts:121](../../src/services/project.service.ts#L121))。`where.tenantId = viewerTenantId` で自テナント限定。

2. **API ルート / Server Component で `user.tenantId` を必ず渡す** — 引数省略時は型エラーで気付ける (defense via 型システム)。

3. **旧 `super_admin` bypass (`isSampleData=false`) は削除** — super_admin は MANAGEMENT_TENANT_ID 所属のため、テナントフィルタだけで自然にシードデータが見える。bypass ロジックの撤廃により認可境界が単純化。

4. **linked-projects-section.tsx の chip 内テキストに `min-w-0 flex-1 truncate` + 親 li に `max-w-full overflow-hidden` を適用** ([linked-projects-section.tsx:104-147](../../src/components/common/linked-projects-section.tsx#L104))。Badge / Button は `shrink-0` で縮小防止、tooltip でフルネーム露出。

### 抽出したルール

- [ ] **テナント越境チェックはサービス層で必須**: 一覧系 (`list*ForViewer`) は viewer の `tenantId` を引数で受け取り、`where.tenantId = viewerTenantId` を **すべての findMany** に必ず付ける。引数省略時は型エラーになるよう必須引数で受ける (オプショナルにしない)。
- [ ] **`isSampleData` フィルタは「シード v.s. 実データ」の区別であり、テナント分離の代替にならない**: シードと実データは tenantId が異なる別物として配置 (シード = MANAGEMENT_TENANT_ID 配下) し、表示制御は `tenantId` 一本で行う。
- [ ] **新規コンポーネント / 新規エンドポイントを追加する際は同種の既存実装の overflow / truncate / 認可ガードを `grep` で確認し、同パターンを適用する**: 本件 PR #294 で新設した linked-projects-section.tsx は attachment-list.tsx の min-w-0+truncate を踏襲できなかった事例。新規追加 = 横展開チェックの起点と心得る。
- [ ] **「以前のセッションで指示した」が拾えない事象を見つけたら KDD ナレッジに必ず追記する**: commit message だけでは将来の `/recall` で拾えない。`docs/knowledge/KDD_PATTERNS.md` または `docs/test/E2E_LESSONS_LEARNED.md` に新セクションを切る。
- [ ] **テナント越境バグの severity は最高位 (個人情報漏洩 + 情報完全性侵害)** — 単一テナント運用 (v1) では実害が見えにくいが、v1.x マルチテナント解放と同時に顕在化する。コードフリーズ前に**必ず**塞ぎ切る。CI gate (E2E) で別テナントの user で別テナントのデータが API から取れないことを検証する仕組みを追加検討。
- [ ] **「全○○」画面のような横断ビューは「テナント横断」ではなく「自テナント内のプロジェクト横断」と再定義する**: テナント壁を超えるのは super_admin の MANAGEMENT_TENANT 内の挙動だけ。コメントで「横断」と書く時は必ずスコープを明示する (テナント内 / 全体)。

### 関連

- 修正例: PR feat/issues-from-feedback-2026-05-09
- §5.62 (提案エンジン v2 の設計議論 — シード管理テナント方針の起点)
- `src/lib/tenant.ts:46` (MANAGEMENT_TENANT_ID 定数 / `isManagementTenant()` ヘルパー)
- `prisma/schema.prisma:188` (User.tenantId カラム / DEFAULT default-tenant)
- 公式 doc (Next.js multi-tenant の概念): <https://nextjs.org/docs/app/guides/multi-tenant>

## 5.X+14 テナント越境バグ全網羅監査と Phase 1 修正 + Phase 2 残課題 (PR feat/issues-from-feedback-2026-05-09 hotfix)

### 背景

§5.X+13 でテナント越境の核心 (listAll 系 / 全○○画面) を塞いだ後、ユーザから「**全ソースコードをフルスキャン**して個人情報漏洩・情報完全性侵害の可能性を網羅的に洗い出せ」と severity-1 緊急要請。auth-reviewer エージェント 4 並列 + Prisma クエリ全件 grep で監査した結果、**約 80 箇所の越境経路** が発見された。

### Phase 1 で塞いだ最重要箇所 (本 PR で対応完了)

#### A. 中核ヘルパー (1 箇所修正で十数ルートを波及防御)

[src/lib/permissions/membership.ts:62](../../src/lib/permissions/membership.ts#L62) `checkMembership(projectId, userId, systemRole, userTenantId)` に **`userTenantId` を必須化**。`project.tenantId !== userTenantId` の場合は admin であっても `isMember: false` を返す。super_admin (MANAGEMENT_TENANT 所属) のみ越境管理を bypass。

これにより、`checkProjectPermission` 経由のすべてのルート (`/api/projects/[projectId]/**` 配下の数十本) と `/projects/[projectId]/**` 配下の Server Component (8 ファイル) が **1 ヘルパー修正で一括防御**される。

#### B. PII 大量漏洩経路

- [src/services/user.service.ts:95](../../src/services/user.service.ts#L95) `listUsers(viewerTenantId)`: 旧仕様は全テナント全ユーザの氏名 + メール + MFA 状態 + ロック状態を返していた (テナント A の admin が テナント B の組織情報を全閲覧可)
- [src/app/api/mention-candidates/route.ts:96-155](../../src/app/api/mention-candidates/route.ts#L96): メンション補完 API が認証済ユーザ誰でも全テナントのユーザ氏名 + メールを取得可能だった

#### C. 越境管理ログ閲覧

- [src/app/(dashboard)/admin/audit-logs/page.tsx:16](../../src/app/(dashboard)/admin/audit-logs/page.tsx#L16): `where: { user: { tenantId: session.user.tenantId } }` で自テナント user の audit_log のみに限定
- [src/app/(dashboard)/admin/role-changes/page.tsx:16](../../src/app/(dashboard)/admin/role-changes/page.tsx#L16): `where: { targetUser: { tenantId } }` で同様に限定

#### D. アカウント乗っ取り経路

[src/lib/api-helpers.ts](../../src/lib/api-helpers.ts) に `requireSameTenantUser(user, targetUserId)` ヘルパーを新設し、以下 4 ルートで対象 user の越境チェックを enforce:

- `PATCH /api/admin/users/[userId]` (氏名/ロール/isActive 編集)
- `DELETE /api/admin/users/[userId]` (論理削除)
- `POST /api/admin/users/[userId]/recovery-codes` (リカバリーコード再発行 → 旧仕様は他テナント user のコード再発行で **MFA 完全乗っ取り可能** だった)
- `POST /api/admin/users/[userId]/unlock` (パスワード/MFA ロック解除)

#### E. customer.service 主要関数

[src/services/customer.service.ts](../../src/services/customer.service.ts) の `listCustomers` / `getCustomer` / `createCustomer` (data に tenantId 明示) / `updateCustomer` / `deleteCustomer` / `deleteCustomerCascade` 全関数に `viewerTenantId` を必須引数化。

### Phase 2 残課題 (本 PR では未着手、別 PR で順次対応)

監査で発見されたが **本 PR で着手しなかった** 越境経路。各々ナレッジに残し、Phase 2 (severity-1 残対応) として別 PR で対応する。**v1.x マルチテナント解放前に必ず塞ぎ切る**。

#### B-Class HIGH (admin が他テナントの ID を直叩きできる経路)

1. **project.service.ts**: `getProject` / `updateProject` / `changeProjectStatus` / `deleteProject` / `deleteProjectCascade` (※ `checkMembership` 強化で大半は防御されるが、二重防御として where に tenantId 必須化)
2. **risk.service.ts**: `listRisks` / `getRisk` / `updateRisk` / `bulkUpdateRisksFromList` / `deleteRisk` / `unlinkRiskFromProject`
3. **knowledge.service.ts**: `listKnowledge` / `listKnowledgeByProject` / `getKnowledge` / `updateKnowledge` / `deleteKnowledge` / `bulkUpdateKnowledgeVisibilityFromList`
4. **retrospective.service.ts**: `listRetrospectives` / `getRetrospective` / `confirmRetrospective` / `updateRetrospective` / `deleteRetrospective` / `bulkUpdateRetrospectivesVisibilityFromList` / `unlinkRetrospectiveFromProject`
5. **memo.service.ts**: `getMemoForViewer` / `updateMemo` / `deleteMemo` / `bulkUpdateMemosVisibilityFromList`
6. **task.service.ts (最大の盲点 — tenantId フィルタ皆無)**: 全関数 `listTasks` / `listTasksFlat` / `listTasksWithTree` / `getTask` / `getAssigneeDailyWorkload` / `createTask` / `updateTask` / `deleteTask` / `bulkUpdateTasks` / `updateTaskProgress` / `recalculateAllProjectWps` / `exportWbs` / `listMyTaskProjects`
7. **comment.service.ts**: 全関数 (`listComments` / `getComment` / `createComment` / `updateComment` / `deleteComment` / `resolveEntityForComment` / `softDeleteCommentsForEntity`)
8. **stakeholder.service.ts**: 全 5 関数
9. **attachment.service.ts**: 全 8 関数 (添付ファイル URL 漏洩は機密情報直結)
10. **estimate.service.ts**: 全 6 関数 (契約金額 / 見積根拠の漏洩は致命的)
11. **member.service.ts**: 全 4 関数 (`addMember` で他テナント user を pm_tl で追加 → 権限昇格攻撃)
12. **user.service.ts (B 拡張)**: `createUser` / `updateUserStatus` / `updateUser` / `updateUserRole` / `deleteUser` / `lockInactiveUsers` (cron 経路は意図的横断、手動経路は要分離)
13. **suggestion.service.ts**: `loadProjectContext` / `suggestForProject` の where 全箇所に `tenantId` 必須 + `excludeManagementTenant` を「追加許可」に書き換え (`tenantId: { in: [ctx.tenantId, MANAGEMENT_TENANT_ID] }`)、`adoptPastIssueAsTemplate` / `linkKnowledgeToProject` / `suggestRelatedIssuesForText`
14. **mention.service.ts**: `getMentionContext` / `expandMention` (kind='all') / `generateMentionNotifications`
15. **notification.service.ts**: `setNotificationRead` / `getNotification` (二重防御)
16. **sync-import 系 5 ファイル** (task / knowledge / risk / retrospective / memo): 全 `applySyncImport` / `computeSyncDiff` に `viewerTenantId` 必須 + projectId の tenant 検証
17. **`/api/admin/audit-logs`, `/api/admin/role-change-logs`, `/api/admin/usage-summary`** API ルートに同様の自テナント限定を追加 (Server Component は塞いだが API は別経路で漏洩中)
18. **`POST /api/attachments/batch`** の admin 分岐 (`filteredIds = entityIds`): 親 entity の tenantId 検証を入れる

#### B-Class MEDIUM (構造的脆弱性 — 監査ログ / トークンの tenant 帰属)

19. **audit.service.ts**: `recordAuditLog` / `recordAuditLogBulk` の data に `tenantId` 明示 (現状 schema DEFAULT に依存)
20. **email-verification.service.ts**: `EmailVerificationToken.create` / `RecoveryCode.createMany` の data に `tenantId` 明示
21. **comment.service.ts createComment**: `data.tenantId` 明示 + `mention.createMany` も同様
22. **attachment.service.ts createAttachment**: `data.tenantId` 明示
23. **memo.service.ts createMemo**: `data.tenantId` 明示
24. **task.service.ts createTask**: `data.tenantId` 明示 (project から導出)
25. **project.service.ts createProject**: 既存引数の tenantId を `data.tenantId` に明示

### 抽出したルール (今後の必須遵守事項)

- [ ] **新規 list 系関数 / API ルートを追加する際、`viewerTenantId` を必須引数として宣言する**: オプショナルやデフォルト値は不可。型システムで呼び忘れを構文的に検知する設計を維持する。
- [ ] **新規 entity 取得関数で `findUnique({ where: { id } })` を書かない**: 必ず `findFirst({ where: { id, tenantId: viewerTenantId } })` または `findUnique` の後に `requireSameTenant(viewerTenantId, entity)` を併記する (二重防御)。
- [ ] **`where: { id: someId }` だけの update / delete / updateMany / deleteMany を書かない**: 必ず `tenantId` 条件を併記する。Prisma 5+ の compound where が使えない場合は `findFirst` で先に所有確認する。
- [ ] **新規 create / createMany の data に `tenantId` を必ず明示する**: schema DB DEFAULT に依存しない。マルチテナント時に DEFAULT_TENANT_ID への暗黙書込が事故を誘発する。
- [ ] **`requireAdmin` 直後に対象 entity の越境チェックを実施する**: admin でも他テナントの ID を直叩きで操作できないこと。`requireSameTenantUser()` / `requireSameTenant()` を一律使用する。
- [ ] **テナント越境テストを E2E に追加する**: 「テナント A の admin が テナント B の {project,user,risk,...} ID で各 API を叩いた際 404 / 403 が返ること」を CI gate 化する。
- [ ] **`checkMembership` / `checkProjectPermission` を経由しないルートを追加する場合は警告コメントを書く**: cron 系 / super_admin 系で意図的に越境するときのみ。intentional であることを明記。
- [ ] **`isSampleData` フィルタはテナント分離の代替にならない**: 「シード v.s. 実データ」の制御と「テナント分離」は直交する別概念。混同しない。
- [ ] **severity-1 セキュリティ事象は即時 PR + 即時 main マージで対応する**: 段階リリースの誘惑に負けず、発見したら最優先で塞ぐ。サービス利用停止や事業継続リスクに直結する。

### 関連

- 修正例: PR feat/issues-from-feedback-2026-05-09 (Phase 1 hotfix)
- §5.X+13 (本件の前段、listAll 系の越境塞ぎ)
- 公式 OWASP IDOR (Insecure Direct Object Reference): <https://owasp.org/www-community/attacks/Indirect_Object_Reference>
- `src/lib/permissions/tenant.ts` (`requireSameTenant` / `tenantScope` ヘルパー — 全 service で活用すべき)

## 5.X+15 `pnpm tsc --noEmit` と `pnpm build` (Next.js TypeScript) は別物 — コミット前 build 実行が必須 (PR #297 hotfix)

### 背景

PR #297 Phase 1 commit を push 直後、Vercel / GitHub Actions / Playwright E2E がすべて Next.js build の TypeScript チェックで fail した。**ローカルでは `pnpm tsc --noEmit` がパスしていた** ため発見が遅れ、CI 1 サイクル (約 90 秒) を消費した。

検出された 2 種類のエラー:

1. **内部ヘルパー型シグネチャ非互換** (3 箇所):
   - `authorize`/`authorizeForAttachment`/`authorizeForComment` のローカル user 引数型 `{ id: string; systemRole: string }` に `tenantId` がない
   - Phase 1 で `checkMembership` 引数に `user.tenantId` を渡したため、ヘルパー内部で `Property 'tenantId' does not exist on type` エラー

2. **Prisma Where 型違反** (1 箇所):
   - `prisma.task.findFirst({ where: { tenantId: ... } })` を書いたが、**Task モデルには tenantId 列が無い**
   - Task は `project.tenantId` 経由で絞る関連フィルタが正解 (`where: { project: { tenantId } }`)
   - 既存 schema を grep せずに「全 entity に tenantId 列がある」と暗黙仮定したのが原因

### なぜ `pnpm tsc --noEmit` で検出できなかったのか

調査の結果、両者には実装上の差異がある:

- **`tsc --noEmit`**: tsconfig の `incremental: true` キャッシュを再利用するため、依存関係のみ再チェック。一部の関数引数型推論を skip する場合がある
- **`next build` の TypeScript チェック**: `next-env.d.ts` を含む完全プロジェクトで `tsc --noEmit` を fresh 実行 + 環境変数 (`NEXT_TYPESCRIPT_TYPECHECK`) 経由で**型チェックが厳格化**されるケースがある (Turbopack 環境含む)
- 結果: ローカル `pnpm tsc --noEmit` で OK でも CI で fail する非対称が発生する

公式 doc 一次ソースとしては Next.js が `tsc` を内部呼び出しすることは明記されているが ([Next.js TypeScript](https://nextjs.org/docs/app/api-reference/config/typescript)), `tsc --noEmit` 単独実行との差異の詳細は未文書化のため**経験的検証**に依存。

### 対処したルール

- [ ] **コミット前は必ず `pnpm build` を実行する**: `pnpm tsc --noEmit` だけでは Next.js build の型チェックを完全代替できない (= 90 秒 CI サイクルを消費するリスク)。`pnpm tsc --noEmit && pnpm build` を seq で実行するのが防衛的
- [ ] **新規エンティティに対して `where.tenantId = ...` を追加する前に schema を確認する**: 全 entity に tenantId 列があるとは限らない (Task / TaskProgressLog / TaskKnowledge 等は project 経由で絞る設計)。grep `model X` で確認するか、Prisma 型エラーで気付くしかない (= build が必須)
- [ ] **Task のように tenantId 列が無い entity は `project: { tenantId }` の関連フィルタで代替する**: Prisma の relational filter は indexed JOIN として最適化されるため性能影響軽微。schema をマイグレーションで tenantId 列追加するか、関連フィルタを使うかは設計判断 (本件は後者を採用)
- [ ] **API ルート内のローカル `authorize*` ヘルパーの user 引数型は `getAuthenticatedUser()` の戻り型と完全一致させる**: `AuthenticatedUser` 型を直接 import する方が安全。今回の `{ id; systemRole }` のような部分型は将来の必須引数追加で同種のエラーを誘発する。可能なら `import type { AuthenticatedUser }` で揃える
- [ ] **CI fail を検出したら最初に Vercel / GitHub Actions のログを確認**: ローカル再現手順を確立してから fix を書く。盲目的な「とりあえず修正 push」は CI 消費とコンテキストスイッチコストが大きい

### 関連

- 修正例: PR #297 hotfix (e8a9701 push 後の build fix commit)
- §5.X+13 / §5.X+14 (本件の前段、テナント越境バグ恒久対策)
- 公式 doc: <https://nextjs.org/docs/app/api-reference/config/typescript>
- 公式 doc (Next.js Build Output): <https://nextjs.org/docs/app/api-reference/cli/next#next-build-options>

## 5.X+16 CodeQL の user-controlled な認可 dispatch 偽陽性は **switch 文** で構造的に解消する (PR #302 で 3 段階の試行錯誤を経て確立)

### 背景

PR #302 (Phase 2-5: comment / attachment / stakeholder のテナント越境フィルタ) で
GitHub Advanced Security の **CodeQL チェックが連続 fail**。**異なる rule の偽陽性を 2 連続**で踏んでから
最終解にたどり着いた経緯を記録する。

### 試行 1: 元コード (`if (entityType === 'memo')`) → `js/user-controlled-bypass` で flagged

```
Rule: js/user-controlled-bypass (CWE-290 / CWE-807, severity high)
File: src/app/api/attachments/route.ts:60
Title: User-controlled bypass of security check
Message: This condition guards a sensitive [action], but a [user-provided value] controls it.
```

```ts
async function authorize(user, entityType, entityId, mode) {
  if (entityType === 'memo') {           // ← この行が flagged
    const { ok } = await authorizeMemoAttachment(entityId, user.id, mode, user.tenantId);
    ...
  }
  // project member 経路 (project / task / estimate / risk / retrospective / knowledge)
  ...
}
```

CodeQL の懸念: `entityType` (URL `searchParams.get('entityType')` 由来 = user-controlled) で
**認可関数 (`authorizeMemoAttachment` vs `checkMembership`) を切り替え** している → user が
choose できる security check は bypass 経路になり得る (CWE-290 認証バイパス / CWE-807 信頼できない入力に基づく
セキュリティ判断)。

### 試行 2: constant-record dispatch (`obj[entityType](...)`) → `js/unvalidated-dynamic-method-call` で flagged

試行 1 を解消するため `Record<AttachmentEntityType, Authorizer>` のテーブル lookup に置換:

```ts
const ATTACHMENT_AUTHORIZER: Record<AttachmentEntityType, ...> = {
  memo: (user, entityId, mode) => authorizeMemoEntity(user, entityId, mode),
  project: (user, entityId, mode) => authorizeProjectScopedEntity(user, 'project', entityId, mode),
  // ... 他 5 種
};
async function authorize(user, entityType, entityId, mode) {
  return ATTACHMENT_AUTHORIZER[entityType](user, entityId, mode);   // ← この行が flagged
}
```

しかし新たな alert が発生:

```
Rule: js/unvalidated-dynamic-method-call (CWE-94, severity high)
File: src/app/api/attachments/route.ts:179
Title: Unvalidated dynamic method call
Message: Invocation of method with [user-controlled] name may dispatch to unexpected target and cause an exception.
```

CodeQL の懸念: user-controlled `entityType` が **動的プロパティアクセスのキー**として使われる →
未知のキーで `undefined()` 例外、もしくは prototype-pollution 経由の意図しない関数呼び出しの懸念。
TypeScript の `Record<EnumKey, ...>` 型注釈は **コンパイル時の網羅性チェック**には効くが、
**ランタイムの値域は CodeQL データフロー解析からは見えない**ため flag される。

### 試行 3 (最終解): **switch 文** + TypeScript exhaustive `never` ガード

```ts
async function authorize(user, entityType, entityId, mode) {
  switch (entityType) {
    case 'memo':
      return authorizeMemoEntity(user, entityId, mode);
    case 'project':
    case 'task':
    case 'estimate':
    case 'risk':
    case 'retrospective':
    case 'knowledge':
      return authorizeProjectScopedEntity(user, entityType, entityId, mode);
    default: {
      // TypeScript exhaustiveness check: 新 entityType 追加時は本 default 節で
      // compile error になるため、authorize() の case 漏れを構造的に防ぐ。
      const _exhaustive: never = entityType;
      throw new Error(`Unhandled attachment entityType: ${String(_exhaustive)}`);
    }
  }
}
```

### なぜ switch なら通るのか

CodeQL JS のクエリは「user-controlled な if-condition で security 関数を gate」「user-controlled キーで
動的プロパティアクセス」を flag する一方、**switch 文の case label は静的 string literal**
として扱われ、以下 2 点で「構造的安全」と判定される:

1. **case label の値域がコンパイル時に確定** — `'memo'` `'project'` 等は AST 上の string literal で、
   user-controlled value が「label を選ぶ」のではなく「事前定義された label の中から match
   するものに飛ぶ」semantics。CodeQL の dispatch tracker は switch を「table-driven dispatch on
   typed enum」として認識する経験則がある。
2. **動的プロパティアクセスが存在しない** — `obj[entityType]` のような computed lookup が無く、
   各 case の関数呼び出しは **静的に解決**される。`js/unvalidated-dynamic-method-call` の
   data-flow tracker が引っかからない。

### TypeScript exhaustive `never` ガードが組み合わせとして必須

```ts
default: {
  const _exhaustive: never = entityType;
  throw new Error(`Unhandled attachment entityType: ${String(_exhaustive)}`);
}
```

- `AttachmentEntityType` enum に新 entity 種別 (例: `'comment'`) を追加すると、
  `_exhaustive: never = entityType` で **compile error** になる (= 全 case が網羅されていない)
- ランタイムで万一未知 entityType が来たら **throw で fail-fast** (silent bypass を防ぐ)
- これにより constant-record dispatch の「型レベル網羅性強制」と同等の保護を維持しつつ、
  静的 dispatch の利点を得る

### 抽出したルール

- [ ] **user-controlled value で認可関数を dispatch する場合は最初から `switch` 文で書く**:
      `if (x === 'literal') { ... }` でも `obj[x]()` でも CodeQL に flagged される。
      `switch (x) { case 'literal': ... default: assertNever(x) }` のみが両方を回避できる
- [ ] **switch + exhaustive `never` ガードの組合せが TypeScript / CodeQL 両方に対する黄金パターン**:
      新 enum 値の追加が compile error で検出され (silent bypass なし)、
      かつ CodeQL の「dispatch on validated enum is safe」ヒューリスティックに乗る
- [ ] **CodeQL 偽陽性 fix は「別の偽陽性」を呼びがち**: PR #302 では if → record dispatch で
      別 alert が発生した。**fix のたびに実 push して CodeQL の判定を確認する**フィードバック
      ループが必要 (机上で「これで通るはず」と決め打ちしない)
- [ ] **`Record<EnumKey, Handler>[userKey]()` は便利だが認可 dispatch には使えない**:
      動的プロパティアクセスが CodeQL `js/unvalidated-dynamic-method-call` のメイン検出対象。
      認可以外の dispatch (例えば formatter / serializer など security に直接関係ない用途) は OK
- [ ] **CodeQL JavaScript は inline 抑止コメント (`// lgtm[...]` / `// codeql[...]`) を公式サポートしない**
      (2026-05 時点。C/C++/Java/C# のみ)。**コード refactor が JS では唯一の解**
- [ ] **dismiss は GitHub UI で `security_events: write` 権限が必要**: gh CLI の `repo` scope では不可。
      CI を通したい場合はコード refactor が現実解
- [ ] **既存 alert と同じ rule + 同じ file + 同じ line でも PR で「new alert」扱いになり得る**:
      CodeQL のフィンガープリントは周辺コード変更で揺れる (call-site の引数追加で変わる例を本件で観測)
- [ ] **横展開チェック**: `git grep -E "if \(.*=== '.*'\)" src/app/api/` で user-controlled な
      if-dispatch を検出し、認可周りでは予防的に switch 文に書き換える

### 横展開対象 (本 PR では未着手、将来対応候補)

- `src/app/api/attachments/[id]/route.ts:43` — 同じ `if (entityType === 'memo')` パターン
  (現状は CodeQL 未 flag、`existing.entityType` が DB 由来で user-controlled tracker に乗らないため)
- `src/app/api/attachments/batch/route.ts` — 多数の `if (entityType === '...')` 分岐
  (但し dispatch ではなく entity 個別 query なので別 pattern)

### 関連

- 修正例: PR #302 (feat/tenant-isolation-phase2-comment-attachment-stakeholder)
  - 試行 1 (元コード): commit 008a138 — main 同等の if-condition
  - 試行 2 (record dispatch): commit 54933e7 — `js/user-controlled-bypass` 解消も別 alert 発生
  - 試行 3 (switch 文、本ナレッジ確立): 本 PR の最終 commit
- CodeQL alert 番号:
  - #14: PR #302 試行 1 が flagged
  - #5: main 既存・同 rule/同 file/同 line (試行 1 と本質的に同じ)
  - 試行 2 で発生した alert (commit 54933e7 head)
- CodeQL rule docs:
  - `js/user-controlled-bypass`: <https://codeql.github.com/codeql-query-help/javascript/js-user-controlled-bypass/>
  - `js/unvalidated-dynamic-method-call`: <https://codeql.github.com/codeql-query-help/javascript/js-unvalidated-dynamic-method-call/>
- CWE 番号:
  - CWE-94 (Improper Control of Generation of Code / 'Code Injection'): <https://cwe.mitre.org/data/definitions/94.html>
  - CWE-290 (Authentication Bypass by Spoofing): <https://cwe.mitre.org/data/definitions/290.html>
  - CWE-807 (Reliance on Untrusted Inputs in a Security Decision): <https://cwe.mitre.org/data/definitions/807.html>

## 5.X+17 同一ファイルを **複数開発中 PR が並行更新する場合の merge conflict 対策** (PR #306 で確立)

### 背景

Phase 2 テナント越境対策を 9 個の独立 PR (#298〜#306) に分割して並行進行した結果、**全 PR が同じドキュメント `docs/security/TENANT_ISOLATION_PHASE2_TODO.md` を更新**する設計となり、後発の PR が先行 PR のマージ後に必ず conflict を起こした。

PR #306 (Phase 2-9) の場合:
- 作成時点 (2026-05-09): main は #297-#300 までマージ済
- マージ時点 (2026-05-10): main は #301-#305 + #307 までマージ済 ← **5 PR 分の進捗が main 側に書き込まれている**
- PR #306 自身も「Phase 2-9 完了マーク」を doc に追加していた → 3 箇所で衝突

```
docs/security/TENANT_ISOLATION_PHASE2_TODO.md
  3 箇所 conflict (knowledge/retrospective/memo セクション + memo の createMemo 行 +
                    comment/stakeholder/attachment/estimate/member/user セクション)
```

### 観測された衝突パターン

| パターン | 例 | 解消方針 |
|---|---|---|
| 同じセクションを **両方が完了マーク** | knowledge.service.ts: HEAD は `(PR #301 Phase 2-4)`、main は `(PR Phase 2-4, 2026-05-09)` で文言違い | **main を採用** (実際に merge されたバージョン) |
| 一方が後続項目を追加 | memo.service.ts に main 側で `createMemo` 行が追加 | **main を採用** (情報が増えている) |
| 一方が完了状態を更新 | user.service.ts の `lockInactiveUsers` を HEAD は `[x]`、main は `[ ] (Phase 2-9 で対応予定)` | **実態を確認**: コードを grep して既に実装済みなら `[x]` を採用 (HEAD の認識が正しい)、未実装なら main を採用 |
| **後続フェーズ PR が前フェーズの暫定実装を最終形に置換** | PR #307 (Phase 2-10) で `audit-logs/route.ts`: HEAD は `where: { tenantId: user.tenantId }` (直接列フィルタ、Phase 2-10 schema 列追加が前提)、main は `where: { user: { tenantId } }` (Phase 2-9 暫定対応の relation 経由) | **HEAD を採用** (Phase 2-10 schema 列追加で初めて有効になる最終形)。Phase 2-9 は schema 制約下の暫定 fallback だったため、Phase 2-10 が完成したら HEAD の方が技術的に正解 |

### 採用したルール

- [ ] **進捗 doc は「PR 番号で完了マーク」をやめ「日付ベース」に揃える**: `(PR #301 Phase 2-4)` ではなく `(PR Phase 2-4, 2026-05-09)` のように **日付** を主キーにする。PR 番号は merge 順で前後するが、日付は単調で衝突解消の判断基準として一意
- [ ] **同 doc を更新する PR が並行する場合、後発 PR は冒頭で `git pull origin main` してリベースを試す**: `gh pr view <n> --json mergeStateStatus` で `DIRTY` (= conflict) を検出したら即対応する。マージ直前に発覚すると CI 再実行で +30 分のロス
- [ ] **conflict 解消の判断基準**: 「**実際に main にマージされた状態が真**」が原則。HEAD 側の文言が古い情報 (PR 作成時点の認識) で、main 側の文言が最新の実装状況を反映している。ただし「完了マーク `[x]/[ ]`」については、対応する **コードの grep で実態を確認**してから判断する (= doc が間違っている可能性も考慮)
- [ ] **Phase 並行型 PR では doc 更新を別 PR にまとめる選択肢もあり**: 今回は各 PR が自分の進捗を doc に書き込む方式だったが、これだと N 並行 PR で N-1 回 conflict を踏む。代替案として **進捗 doc 更新だけを別 PR で月末バッチ更新**にすると衝突 0 にできる (但し各 PR の進捗が他 PR からは見えないトレードオフあり)
- [ ] **進捗 doc に書く粒度を制御する**: 「全 7 関数」のような略記より「個別関数名 + 一行説明」の方が衝突しても merge tool が機械的に解消できる確率が高い (3-way merge 時の anchor が増えるため)

### conflict 解消手順 (本件で確立)

```bash
# 1. main 取り込みを試行
git checkout <pr-branch>
git pull origin main --no-edit

# 2. conflict ファイル一覧を確認
git status | grep "both modified"

# 3. 各 conflict について「main 側」を採用するか「HEAD 側」を採用するか判定
git diff <conflict-file>     # markers と内容を確認
# - 文言違いだけ                   → main を採用 (より新しい)
# - HEAD のみ追加項目あり          → HEAD を採用
# - main のみ追加項目あり          → main を採用
# - 両方が同じ行を異なる完了状態に  → コード grep で実態確認

# 4. 全 conflict 解消後に検証
grep -rn "<<<<<<<\|=======\|>>>>>>>" docs/   # → 出力なしを確認
pnpm test && pnpm build                       # → リグレッションなしを確認

# 5. merge commit を完了
git add <conflict-files>
git commit --no-edit                          # default merge message を採用
git push
```

### 後続フェーズが暫定実装を置換する場合のルール (PR #307 で確立)

Phase 2-9 と Phase 2-10 のように **同じファイルを段階的に進化させる PR** が並行する場合、
2 つの異なる衝突パターンが発生する:

1. **HEAD = 最終形 / main = 暫定 fallback**: Phase 2-10 (PR #307) は schema 列追加を前提とした
   最終実装 (`where.tenantId`)。Phase 2-9 (PR #306) は schema 列が無い段階での暫定実装
   (`where.user.tenantId`)。**HEAD を採用** (= schema 列がある前提の最終形が正解)
2. **HEAD = 暫定 / main = 最終形**: 通常はこの順で発生しない (= 後発 PR が先行 PR の最終形に
   逆戻りすることは無い) が、誤って起きた場合は main を採用

### 段階的実装の conflict 予防策

- [ ] **後発 PR (Phase N) のコード comment に「Phase N-1 で導入した暫定実装からの最終移行」を明記**:
      conflict 解消時に HEAD/main どちらが「最終形」か即判別できる
- [ ] **段階実装の最後の commit message に「Phase N で完成、Phase N-1 の暫定実装を置換」と記録**:
      git log から conflict 解消の判断材料を遡れる
- [ ] **同 schema 依存の PR が並行する場合は順次マージ**: Phase 2-9 がマージされる前に
      Phase 2-10 を作成すると、Phase 2-10 の最終形コードがレビューで「現在は使えない」と
      misunderstanding されるリスク。本件では Phase 2-10 を後発 (#307) として、Phase 2-9
      (#306) の merge 待ちの後に流す予定だったが、両方並行で merge しようとして conflict 発生

### 関連

- 修正例 1: PR #306 (feat/tenant-isolation-phase2-api-medium) の merge conflict 解消 (進捗 doc のみ)
- 修正例 2: PR #307 (feat/tenant-isolation-phase2-audit-tokens) の merge conflict 解消
  (進捗 doc + audit-logs/route.ts + role-change-logs/route.ts の 3 箇所、後続フェーズ置換パターン)
- 並行 PR シリーズ: #297-#308 (Phase 1〜2-10 + UI 文言修正)
- 公式 doc (Git merge): <https://git-scm.com/docs/git-merge>

## 5.X+18 severity-1 セキュリティ仕様の **3 層防御テスト戦略** (PR feat/tenant-isolation-comprehensive-tests で確立)

### 背景

Phase 2 (PR #297-#308) で確立した「テナント越境を構造的に遮断する」仕様は、**今後の改修でも
基本変更されない**。一方、改修時にうっかり tenant フィルタを忘れた service / route が混入すると、
**個人情報漏洩 (severity-1)** に直結する。リリース後検知では遅すぎるため、**リリース前検知の
網を厚くする** 必要があった。

### 採用した 3 層防御テスト戦略

severity-1 リグレッションを **3 つの独立したレイヤ** で検出する設計。1 層が破られても他層で
catch できるよう、検出粒度と検出原理を変える。

#### Layer 1: Service 層 不変条件テスト (`src/services/__tests__/tenant-isolation-invariants.test.ts`)

**検出原理**: ファイル内容の **静的解析** (grep 相当)。

```ts
// 全 service ファイルが tenant フィルタを使っていることを静的に保証
it.each(ALL_SERVICE_FILES.filter(...))(
  '%s に tenantId / viewerTenantId フィルタが含まれている',
  (filePath) => {
    const content = readFileSync(filePath, 'utf-8');
    const hasTenantFilter =
      content.includes('tenantId:') ||
      content.includes('viewerTenantId') ||
      content.includes('project: { tenantId') ||
      content.includes('tenant: {');
    expect(hasTenantFilter).toBe(true);
  },
);
```

**強み**: コード追加時に **即時 fail** (DB 不要、< 1 秒)。CI 高速 path で先頭で検出。
**弱み**: false positive を避けるため許可リスト管理が必要 (cron / pure logic / pre-auth 等)。

#### Layer 2: Service 層 単体テスト (各 `*.service.test.ts`)

**検出原理**: モック DB に対して service 関数を呼んで、`prisma.findMany` の where 句に
tenantId が含まれることを **mock 呼び出し検査** で確認。

```ts
it('★越境テスト★ 他テナント user は返さない', async () => {
  await listKnowledge({ ... }, 'u-1', 'general', 'tenant-A');
  const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
  expect(call.where).toMatchObject({ tenantId: 'tenant-A' });
});
```

**強み**: ロジックの細部 (ID lookup / where 構築) を高速に検証。リファクタ時の挙動保存を保証。
**弱み**: モック前提なので「実 DB で本当に隔離されているか」までは保証しない。

#### Layer 3: E2E 越境攻撃シナリオ (`e2e/specs/11-tenant-isolation.spec.ts`)

**検出原理**: 実 DB に 2 テナント立てて、テナント A admin が テナント B の URL を **直接叩く**
攻撃シナリオを再現。Service / Route / DB / Auth middleware の **end-to-end 動作で隔離を確認**。

```ts
test('PATCH /api/projects/[B-id] → 404 (テナント B の project は A admin が更新不可)', async () => {
  const res = await adminARequest.patch(`/api/projects/${tenantB.projectId}`, {
    data: { name: 'attacked' },
  });
  expect([403, 404]).toContain(res.status());
});
```

**強み**: 「攻撃者視点の動作」を直接検証。テスト間に依存がないので 1 件 fail でも他 28 件は走る。
**弱み**: CI 時間がかかる (E2E は分単位)。DB セットアップ + cleanup の重さ。

### 3 層の使い分け

| 検出シナリオ | Layer 1 (静的) | Layer 2 (単体) | Layer 3 (E2E) |
|---|---|---|---|
| 新規 service が tenant フィルタを忘れた | ✅ 即検出 | ❌ そもそも test 書かれてない可能性 | ✅ E2E で 404/403 期待 |
| 既存 service の where から tenantId が消えた | ❌ 他箇所に残ってる可能性 | ✅ 直接検出 | ✅ E2E で fail |
| API route が user.tenantId を service に渡し忘れた | ❌ 静的解析の限界 | △ service 単体だと API 層は別 | ✅ E2E で必ず fail |
| 提案エンジンが seed 以外の他テナント許容 | ✅ MANAGEMENT_TENANT_ID パターン検証 | ✅ where 句構造検証 | ✅ E2E で B のデータ混入確認 |
| schema 列追加忘れ (migration 漏れ) | ❌ 静的解析範囲外 | △ Prisma 型エラーで間接検出 | ✅ 実 DB 経路で確実に検出 |

### 採用したルール

- [ ] **severity-1 仕様 (個人情報 / 認可境界 / アカウント乗っ取り経路) は 3 層防御を必須化**:
      Layer 1 (静的) + Layer 2 (単体) + Layer 3 (E2E) のいずれかが欠けていたら PR レビューで reject
- [ ] **invariants test は許可リスト管理**: 例外を入れる時は **コメントに理由** を必ず明記。
      「pure logic」「cron 横断」「pre-auth」等のカテゴリで分類すると後で見直しやすい
- [ ] **E2E は API レイヤで検証する**: UI 経由はボタン非表示で気付けない攻撃経路を見逃す。
      `Playwright APIRequestContext` で session cookie を持ったまま `fetch` で直接 URL を叩く
- [ ] **E2E spec は chromium project でのみ実行**: モバイル viewport で重複実行しても
      検出価値ゼロかつ CI 時間 2x。`testIgnore` で除外
- [ ] **multi-tenant fixture は別ファイルに集約**: `e2e/fixtures/multi-tenant.ts` で
      `createTenantPair(runId)` / `cleanupTenants(ids)` を提供すると spec 側がスッキリする
- [ ] **テスト名に「★越境★」「★severity-1★」等の視覚マーカーを入れる**: CI ログで該当 fail を
      即座に発見できる。一般機能 fail とごった煮にしない

### 横展開チェック (新規 severity-1 仕様を作る時)

```bash
# Layer 1 候補追加
ls src/services/*.ts | wc -l   # 全 service 数を確認
# tenant-isolation-invariants.test.ts に新 service の允許 / 検査追加

# Layer 2 候補追加
grep -L "tenant" src/services/*.test.ts   # tenant 検証無い test ファイル抽出

# Layer 3 候補追加
ls e2e/specs/*.spec.ts | grep -i security  # 既存 security spec を流用 or 新規
```

### 関連

- 仕様 doc: docs/security/TENANT_ISOLATION_PHASE2_TODO.md (3 層が full coverage したら HISTORY.md へリネーム)
- 元 PR シリーズ: #297-#308 (Phase 1〜2-10 + UI 修正)
- E2E coverage 一覧: docs/test/E2E_COVERAGE.md 「★テナント分離 / 提案エンジン」セクション
- Layer 1 実装: src/services/__tests__/tenant-isolation-invariants.test.ts
- Layer 2 実装: src/services/*.service.test.ts (各 service の越境テスト)
- Layer 3 実装: e2e/specs/11-tenant-isolation.spec.ts / e2e/specs/12-suggestion-seed-data.spec.ts

---

## 5.X+19 dependabot.yml の `schedule.day` は `weekly` 限定 (PR #310 で遭遇)

### 罠の正体

`.github/dependabot.yml` の `schedule.day` フィールドは **`interval: weekly` でのみ有効**。
`monthly` で `day` を指定したり、`'first monday'` のような複合文字列を渡すと、GitHub の
dependabot validator が **PR check 段階で fail** する (1 秒以内、ログ出力なし)。

### 仕様 (公式)

公式ドキュメント: https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuration-options-for-the-dependabot.yml-file

| `interval` | `day` 指定可否 | 有効値 |
|---|---|---|
| `daily` | × (毎日実行) | — |
| `weekly` | ✅ (必須ではない、未指定なら任意の曜日) | `monday` / `tuesday` / ... / `sunday` の **単一値のみ** |
| `monthly` | ❌ (毎月 1 日に自動実行) | — |

`'first monday'` `'last friday'` などの複合表現は仕様にない。

### 検出が遅れた理由

- **dependabot check は CI ログを残さず短時間で fail** (1s) するため、ログを grep しても
  原因に到達できない。`gh pr checks` の URL を辿ると detailed error が見える場合があるが、
  辿れないこともある (PR #310 では 404)。
- 設定ファイル parse は GitHub 側 service が行うため、**ローカルの YAML lint では捕捉できない**。

### 横展開チェック (dependabot.yml 編集時)

- [ ] `schedule.day` を入れているなら `interval: weekly` か確認
- [ ] `schedule.day` の値は `monday` 〜 `sunday` の単一文字列か確認 (空白を含む複合表現は無効)
- [ ] `monthly` で「月内の特定週/曜日に実行したい」要件があれば、**`weekly` + `day: monday`
      に変更し、人間の判断で月内の必要回数だけマージ** する運用に切り替える (= dependabot は
      週次 PR を出すが、人間が月初の Monday 分だけ approve する)

### 修正例

```yaml
# Before (PR #310 fail):
- package-ecosystem: 'npm'
  schedule:
    interval: 'monthly'
    day: 'first monday'        # ← 二重に invalid (monthly + 複合文字列)

# After:
- package-ecosystem: 'npm'
  schedule:
    interval: 'monthly'         # 月次は毎月 1 日固定で自動実行される
    time: '03:00'
    timezone: 'Asia/Tokyo'
```

### 関連

- 修正例: PR #310 (2026-05-10)
- 関連設定: [.github/dependabot.yml](../../.github/dependabot.yml)
- 公式: https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuration-options-for-the-dependabot.yml-file

## 5.X+24 dependabot 複数 PR が `pnpm-lock.yaml` で相互コンフリクトする ─ 「auto-rebase 待ち」と「PR 数抑制」で運用 (PR #317 / 2026-05-15)

<!-- PR #335 マージ時点 conflict 解消: PR #335 HEAD で末尾に追加された 2 セクション
     (§5.X+30/+31) は、PR #334 が先にマージされて main 側 §5.X+30 (KDD ファイル末尾
     コンフリクトパターン) と番号衝突したため、§5.X+31/+32 に再 renumber して
     ファイル末尾に再配置した (§5.X+30 KDD コンフリクトパターン §5.X+30 自身の
     実践例)。 -->

### 背景

PR #317 (`dependabot/npm_and_yarn/prisma-36eb5828e4`、Prisma 7.7.0 → 7.8.0) で
**コンフリクトが GitHub UI に表示された** が、調査時点では `mergeable: MERGEABLE` /
`mergeStateStatus: CLEAN` で **既に解消** していた。

### 根本原因

**pnpm-lock.yaml はモノリシックなロックファイル** で、任意の依存パッケージ更新で必ず変更が発生する。
dependabot が **複数 PR を同時に open** すると以下が発生:

```
main:                  A → B → C
PR #316 (next-react):  A → P1 (touches pnpm-lock.yaml)
PR #317 (prisma):      A → P2 (touches pnpm-lock.yaml)
```

PR #316 がマージされると、`main` が進む (`A → B → next-react`)。すると PR #317 の
base (= 旧 `main` = `A`) と現 `main` (= `A → next-react`) で **pnpm-lock.yaml が同一行付近** に
別の変更を持つことになり、Git が 3-way merge できず CONFLICTING になる。

### 解消の仕組み (今回のケース)

GitHub の dependabot は **PR の base branch が更新されると自動的に rebase** する設計
(条件: PR ブランチ未触り、checks が grace 期間内)。

時系列:
1. PR #316 (next-react) を main にマージ → main 更新
2. dependabot が PR #317 を検知 → 自動 rebase → 新 commit `911fb5a` 生成
3. 新 commit は新 main 基準で pnpm-lock.yaml を再生成 → CONFLICTING 解消

つまり **ユーザが見たコンフリクトは過渡的状態** で、dependabot の auto-rebase
完了で自動的に消える。

### 教訓

- **コンフリクト発生時の最初の対応**: `gh pr view <#> --json mergeable,mergeStateStatus`
  で確認。`CLEAN` ならもう何もしなくて OK。
- **手動 rebase 不要**: dependabot ブランチに手動で `git push` すると dependabot の
  auto-rebase が **無効化** され、以降は手動メンテになる。基本は触らない。
- **マージ順序戦略**: 同種の依存更新 PR が複数 open 中の場合、**マージしたい順序を決めて
  順次マージ**。1 件マージ → 数分待って残りの auto-rebase 完了を確認 → 次マージ。

### 設計の落とし穴

1. **`mergeable: UNKNOWN`**: GitHub が computing 中。1-2 分待って再取得。
2. **`mergeStateStatus: BLOCKED` / `UNSTABLE`**: ファイル conflict ではなく、CI / Vercel /
   required reviews などが pending な状態。コンフリクトとは別物。
   - **実例 PR #318** (2026-05-15、`BLOCKED`): auto-rebase 直後で **必須 CI が IN_PROGRESS**
     (Lint/Test/Build, Playwright E2E, CodeQL)。CI 完了で `CLEAN` に遷移。
   - **実例 PR #319** (2026-05-15、`UNSTABLE`): すべての必須 CI は SUCCESS だが
     **Vercel preview deployment のみ `PENDING`**。Vercel は非必須 (informational) なので
     `mergeable: MERGEABLE` のままだが、`mergeStateStatus` は `UNSTABLE` 扱い。
     **`UNSTABLE` でも実際にはマージ可能** (GitHub UI が「Merge」ボタンを許可する)。
   - GitHub UI の「Resolve conflicts」ボタンは BLOCKED/UNSTABLE 時にも表示される場合があり、
     ユーザがコンフリクトと誤認しやすい。**まず `mergeable` フィールドを見る** こと
     (CONFLICTING ≠ BLOCKED ≠ UNSTABLE)。

   状態判別マトリクス:

   | `mergeable` | `mergeStateStatus` | 意味 | アクション |
   |---|---|---|---|
   | CONFLICTING | DIRTY | 本物のファイル衝突 | 手動 rebase / `@dependabot rebase` |
   | MERGEABLE | CLEAN | 即マージ可能 | `gh pr merge --squash` |
   | MERGEABLE | BEHIND | base が進んだが衝突なし | "Update branch" or そのままマージ可 |
   | MERGEABLE | BLOCKED | **必須** check 未完 / レビュー待ち | check 完了 / レビュー取得を待つ |
   | MERGEABLE | UNSTABLE | **非必須** check (Vercel 等) が pending | **そのままマージ可能** |
   | UNKNOWN | (任意) | GitHub 計算中 | 1-2 分待って再取得 |
3. **CI が古い base で走った場合**: auto-rebase 後に CI 再実行が走らないと、
   古い PR commit の検査結果のままで「checks pass」になる。dependabot は再 push で
   CI を再実行させる。マージ前に「最新の checks が pass か」を目視確認。
4. **groups 設定**: dependabot.yml の `groups` 設定で関連パッケージをまとめて 1 PR にすると、
   PR 数自体を減らせる (= 相互コンフリクト発生確率を抑制)。既に prisma / next-react /
   testing は groups 化済 (本リポジトリ `.github/dependabot.yml`)。
5. **`open-pull-requests-limit`**: 現状 10 だが、自前で順次マージしきれない場合は
   5 に下げて「常に少数 PR で頻繁回す」運用にする選択肢あり。

### 横展開で漏らしやすい箇所

- **feature ブランチも同じ影響を受ける**: dependabot PR がマージされると feature PR が
  CONFLICTING になることがある。1 PR ずつ手動 rebase (`git rebase origin/main`) で対応。
  実例: 本 PR (#317) 調査時、open feature PR #327/#329/#330 が CONFLICTING になっていた
  (dependabot #311/#313-#316 の連続マージ後)。
- **マイグレーション系 PR (schema.prisma / migration ファイル) と dependabot**: 同様に
  conflict が起きやすい。マージ順序: dependabot → migration の順に通すと安全
  (schema は依存影響を受けないため逆も可、ただし pnpm-lock の auto-rebase は走らない)。

### 推奨運用フロー (今後)

```bash
# 1. dependabot PR を見つけた時の確認
gh pr view <#> --json mergeable,mergeStateStatus,statusCheckRollup

# 2. mergeable=MERGEABLE && mergeStateStatus=CLEAN なら即マージ
gh pr merge <#> --squash --auto

# 3. CONFLICTING の場合は時間を置く (dependabot auto-rebase 待ち、~5 分)
sleep 300 && gh pr view <#> --json mergeable

# 4. それでも解消しない場合: PR コメントで rebase 指示
gh pr comment <#> --body "@dependabot rebase"

# 5. マージ後は他の open dependabot PR の auto-rebase を確認
gh pr list --search "is:open author:app/dependabot" --json number,mergeable
```

### 関連

- 元 PR: #317 (prisma 7.7.0 → 7.8.0 group)
- 同パターン: #311, #313, #314, #315, #316 (連続 dependabot merge)
- 設定: [.github/dependabot.yml](../../.github/dependabot.yml) (groups + open-pull-requests-limit)
- 公式仕様: https://docs.github.com/en/code-security/dependabot/working-with-dependabot/managing-pull-requests-for-dependency-updates

## 5.X+27 ストレージ上限を LLM プランから切り離し 20MB 共通ベース + add-on 独立軸に統一 — 横展開可能な guard サービス化 (PR-3 / 2026-05-15)

### 背景
旧仕様では `STANDARD_STORAGE_BYTES_BY_PLAN = { beginner: 50MB, expert: 150MB, pro: 300MB }`
と LLM プランに連動して Standard 上限が変動していた。
ユーザ要件で確定: **「Standard 20MB / Plus 220MB / Pro 1.02GB / Enterprise 5.02GB」** を
全テナント共通で運用 (LLM プラン非依存)。日次 cron + 7 日 Grace の従来仕様だけでは最大 24h 遅延で
データが上限超過状態で書き込まれてしまう問題があったため、リアルタイム guard も併設。

### 教訓
- **Standard ベースを定数化し、computeStorageLimitBytes のシグネチャから llmPlan 引数を撤去**:
  `STANDARD_STORAGE_BYTES = 20MB` (単一定数) + `ADDON_EXTRA_BYTES[addonPlan]` で合算。
  call site が散在しているため、シグネチャ変更で漏れを tsc が検出できる構造に変える。
- **Pre-check (cache) + Post-check (transaction 内実測)** の二段戦略:
  - Pre-check: キャッシュ値 + 予測サイズで早期拒否 (24h ラグあり = fail-open 寄り)
  - Post-check: transaction 内で `pg_column_size` 集計の実測 → 超過なら `throw` で全件ロールバック
  - 後者が真の境界、前者は明らかに巨大な payload を入口で弾くだけ
- **共通ヘルパに集約**: `withStorageGuard(tenantId, (tx) => fn)` で transaction の中身を渡せば
  Post-check と上限超過ロールバックを自動化。書き込み系 service に横展開しやすい設計
- **エラーマッピング集中**: `mapStorageGuardErrorToResponse(error)` で 403 を組み立て、route が個別判定する必要を排除

### 設計の落とし穴

1. **`calculateTenantStorageBytes` を transaction 内で使うと外側 DB を見る**:
   `tenant-storage.service.ts` 側は `prisma.$queryRaw` 直叩きで tx スコープ外。
   `storage-guard.service.ts` 内に **tx 引数を取る同等 SQL** を別途実装 (`calculateTenantStorageBytesInTx`)。
2. **テスト mock の更新**:
   `prisma.$transaction(async (tx) => ...)` の tx mock 側にも
   `tenant.findFirst`, `tenant.update`, `$queryRaw` のスタブが必要。
3. **キャッシュの同期書き込みは tx 内**:
   `assertStorageLimitInTx` で実測値を `Tenant.storageBytesUsed` に書き戻すが、
   transaction がロールバックされた時は当然破棄される (= キャッシュ汚染が発生しない)。

### 横展開で漏らしやすい箇所 (PR-3 では未着手、follow-up 対象)

PR-3 では **インポート経路 (data-import + external-data-import)** に Post-check + ロールバックを適用済み。
通常の CRUD (project / task / knowledge / risk / retro / memo / customer / stakeholder / member / comment / attachment)
は **未適用**。follow-up PR で:

- 各 service の `create / update / bulkUpdate` を `withStorageGuard(tenantId, (tx) => tx.X.create(...))` で wrap
- 上限超過時の API レスポンスは `mapStorageGuardErrorToResponse(error)` で 403 を返す
- 各 service の test mock に `tx.tenant.findFirst / tx.tenant.update / tx.$queryRaw` を追加 (data-import.service.test.ts のパターンを流用)

PR-3 で個別 CRUD まで広げなかった理由: テスト書き換えの規模が約 30+ ファイルに及び、PR レビュー単位として
大きすぎるため。インフラ + 最重要経路 (= bulk import) を先行、CRUD 個別は段階的に follow-up。

### 関連

- 元 PR: PR-3 (2026-05-15) テナント管理者ダッシュボード改修 — Storage 20MB 共通化 + リアルタイム guard
- config: src/config/storage-addon.ts (`STANDARD_STORAGE_BYTES` / `ADDON_EXTRA_BYTES`)
- guard service: src/services/storage-guard.service.ts (`withStorageGuard` / `assertStorageLimitInTx` / `precheckStorageLimit`)
- import 経路: src/services/data-import.service.ts (ZIP) / src/services/external-data-import.service.ts (CSV)

## 5.X+29 個別 CRUD 経路のストレージ Pre-check は API route 層に集約する (PR-5 / 2026-05-15)
<!-- 元番号 §5.X+23 から §5.X+29 に renumber (PR-N 予約番号体系 PR-1=+25 / PR-2=+26 / PR-3=+27 / PR-4=+28 / PR-5=+29 に従う。詳細は §5.X+21 の stacked PR 教訓参照) -->

### 背景
PR-3 でインフラ (storage-guard service) は完備したが、**通常 CRUD への適用は未着手** だった。
全 13 個の write service の create / update を `withStorageGuard` で wrap すると、
約 30+ 個のテスト mock 書き換えが必要で PR サイズが大きすぎる。

### 教訓
- **API route 層に Pre-check ヘルパを集約**: `requireStorageQuotaForWrite(tenantId, estimatedBytes)`
  を `api-helpers.ts` に追加し、各 route.ts で 1 行呼び出すパターンに統一。
- **service 層は変更しない**: 既存 service test が壊れない。route test だけが影響対象。
- **`estimatedBytes` は payload サイズ近似**: `JSON.stringify(parsed.data).length` を渡す。
  正確ではないが入口の防御層として十分。
- **正確な Post-check はインポート経路のみ**: 個別 CRUD は payload が kB 規模なので
  Pre-check (cache 値 + 予測サイズ) で十分。バッファ overrun は daily cron + 7 日 Grace で
  eventual 補正。

### 設計の落とし穴

1. **route.ts のテスト mock 更新が必要**: `vi.mock('@/lib/api-helpers', ...)` で
   `getAuthenticatedUser` のみ stub している既存テストは、`requireStorageQuotaForWrite`
   の export 不在で `vi.mock` の incomplete エラーになる。
   → mock オブジェクトに `requireStorageQuotaForWrite: vi.fn(async () => null)` を追記。
2. **route.ts のテストが prisma を mock していない場合**: `requireStorageQuotaForWrite`
   は内部で `prisma.tenant.findFirst` を呼ぶため、prisma を一切 mock していないと
   実 DB に接続しようとして fail。`@/lib/db` を mock する必要あり。
3. **配置位置の順序**: validation → 権限チェック → **storage check** → service 呼び出し。

### 適用範囲 (PR-5 で完了)
24 個の write route (POST / PATCH) に適用済:
projects / tasks / knowledge / risks / retrospectives / estimates / customers /
stakeholders / members / comments / attachments / memos

既存の import 経路 (PR-3): `data-import` / `external-data-import` で完全な Post-check + ロールバック継続。

### 関連
- 元 PR: PR-5 (2026-05-15) CRUD ストレージ Pre-check 横展開
- helper: src/lib/api-helpers.ts `requireStorageQuotaForWrite`
- 元実装: PR-3 (#330) `precheckStorageLimit / withStorageGuard / assertStorageLimitInTx`
- 前提 PR: PR-3 (#330) storage-guard.service

---

## 5.X+26 Beginner プランは「値の変動がない管理項目」を UI から消す — 表示の意図不在を防ぐ (PR-2 / 2026-05-15)

### 背景
旧テナント設定画面では「当月使用量」セクションに **3 タイル固定** (API 呼出 / API 費用 / 月次予算上限) を表示していた。
ところが Beginner プランは単価 0 円固定 + 月次予算上限が常に null (= 設定不可) のため、
**「API 費用 ¥0」「月次予算上限 - 」と表示しても何も伝えていない**。
ユーザにとっては「これは何のために表示されているのか?」となり、UI ノイズ + 認知コスト増。

### 教訓
- **「値の変動がない管理項目」は表示しない**:
  値が常に同じ (= 固定値、または常に空) なら、それを管理対象として見せる意図は存在しない。
  プラン別に「そのプランで意味のあるタイル」だけを残す。
- 代わりに **そのプランで利用者の行動指針となる値** を出す:
  Beginner プランは「あと何回呼べるか (残数)」が利用者の最大関心事 → タイル化。
  Expert / Pro は金額 / 予算上限が関心事 → 従来通り。
- **API/service 層に「Beginner では予算上限を設定不可」の防御層を入れる**:
  UI でフォームを非表示にするだけでは curl 直叩きで迂回可能。`updateTenantSelf` で
  `BEGINNER_BUDGET_NOT_ALLOWED` エラーコードを定義し、API は 400 で拒否する。

### 設計の落とし穴

1. **`monthlyBudgetCapJpy: null` (= クリア) は許可する**:
   完全に拒否すると、過去に Expert で予算を設定したユーザが Beginner にダウングレード
   (= 現状仕様上は禁止だが将来緩和の可能性) した時に残値をクリアできない。
   `null` 指定だけは救済として通す。
2. **UI 側のフォーム送信でも防御**: `selectedPlan === 'beginner'` なら `budgetCap` の値を
   無視して null を送る。「フォームが非表示」だけでは React state の残値がそのまま送信
   される事故を防げない (チェックボックスをポチった後にプランを Beginner に切替する経路等)。
3. **タイル数の `sm:grid-cols-N` を plan 別に切替**: 2 タイルなのに `sm:grid-cols-3` を
   使うと最後の列が空き、レイアウトが間延びする。

### 関連

- 元 PR: PR-2 (2026-05-15) テナント管理者ダッシュボード改修 — Beginner プラン UI 改修
- 関連 service: src/services/tenant-self.service.ts `updateTenantSelf` (`BEGINNER_BUDGET_NOT_ALLOWED`)
- 関連 UI: src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx `UsageSection`

---

## 5.X+25 timezone / locale はユーザ単位ではなくテナント単位で持つ — 同一テナント内で日付計算が揺らがない設計 (PR-1 / 2026-05-15)

### 背景
旧仕様 (PR #118 〜 PR #119) では `User.timezone` / `User.locale` でユーザごとに TZ/言語を選べた。
ところがテナント全体の挙動 (Beginner 残日数 / 月初リセット境界 / 翌月適用日 / 日次集計 boundary)
を「ユーザ TZ」基準にすると、**同一テナント内に TZ の異なる 2 名が居ると同一日付の認識がずれて**、
請求書や使用量のカウント断面に矛盾が生じる。

### 教訓
- **テナント全体の挙動に使う TZ/locale は Tenant に持つ**:
  - `Tenant.timezone String NOT NULL DEFAULT 'Asia/Tokyo'`
  - `Tenant.locale String NOT NULL DEFAULT 'ja-JP'`
- ユーザ個別設定は **テーマ / MFA / パスワード等の「個人のセッション体験」に限定**。
  時刻基準は本人の手元観測値より「テナント全体での会計・運用断面」を優先する。
- JWT claim にはテナント値を載せる (`session.user.timezone` / `session.user.locale`)。
  この命名は維持 (= 描画コード側の `Intl.DateTimeFormat` 呼出は変更不要)、
  だが **意味はテナント単位** であることをコメントで明示する。
- API は `/api/tenants/me/i18n` に集約。テナント管理者 (admin) のみ更新可。
  general / super_admin は 403 (テナント設定はテナント管理者の責務)。

### 設計の落とし穴

1. **値が `null` 許容のままだとデフォルトが分散する**:
   旧 `User.timezone String?` の運用では「null = システム既定」だったが、テナント単位では
   既定値を **DB の NOT NULL + DEFAULT** で持たせて nullable を撤去。`resolveTimezone()` の
   フォールバックチェーンを 1 段減らせる + 型安全 (`session.user.timezone: string`)。
2. **`trigger='update'` 経路の patch 型を null から外す**:
   JWT 反映で `useSession().update({ timezone, locale })` の patch 型を `string | null` から
   `string` に変更。null を入れる経路 (= システム既定に戻す UI) を廃止したため。
3. **データインポートの後方互換**:
   旧 ZIP に `User.timezone / User.locale` が含まれていても、新 import コードは黙って無視する。
   テナント側設定は維持。誤ってユーザレコードに NULL を書き戻すと型エラーで止まるため defensive。
4. **データエクスポートの新フィールド追加**:
   `ExportSummary` に `tenantTimezone` / `tenantLocale` を追加。再インポート時にテナント設定を
   復元する手がかりとして使える (将来の super_admin 代行 import 用)。

### 横展開で漏らしやすい箇所

- `prisma.user.findUnique({ select: { timezone: true, locale: true } })` を残してしまう
  → ビルドエラーで気付ける (列が DB から消えるため)
- `session.user.timezone === null` という null 判定が残る
  → tsc が型エラーで指摘
- データインポート/エクスポートのテストモックに `timezone: ..., locale: ...` が残る
  → 警告は出ないがビルドは通る (テストで verify されている前提なら問題なし)

### 関連

- 元 PR: PR-1 (2026-05-15) テナント管理者ダッシュボード改修 — タイムゾーン/ロケール集約
- migration: prisma/migrations/20260515_tenant_i18n_settings/migration.sql
- 旧 migration: prisma/migrations/20260424_user_i18n_preferences/ (User に timezone/locale 追加 → drop)
- 関連設定: src/config/i18n.ts (`DEFAULT_TIMEZONE` / `DEFAULT_LOCALE`)

## 5.X+28 日付計算ロジックをテナント TZ カレンダー日ベースに移行 — UTC 経過時間 ÷ 24h は要件から不一致 (PR-4 / 2026-05-15)
<!-- 元番号 §5.X+22 から §5.X+28 に renumber (main 側 PR #327 で §5.X+22 が E2E_COVERAGE で先取りされたため衝突回避。PR-N 予約番号体系 PR-1=+25 / PR-2=+26 / PR-3=+27 / PR-4=+28 に従う) -->

### 背景
PR-1 で `Tenant.timezone` の schema / JWT / UI は集約済みだが、**実際の日付計算ロジック**
(Beginner 90 日判定 / 月初リセット境界 / 翌月適用 / Grace 7 日) は依然 UTC ベース。
ユーザ要件「タイムゾーンの時間で機能している体験」を満たすには計算側も TZ ローカル
カレンダー日ベースへ移行する必要があった。

具体例: JST テナントが 2026-02-01 14:00 JST に作成された場合、
- 旧仕様 (絶対経過時間 ÷ 24h): 90 日後 09:00 JST 時点で 89.98 日 → まだ active
- 新仕様 (TZ カレンダー日差): 90 日後 09:00 JST 時点で `2026-05-02 - 2026-02-01` = 90 日 → expired

### 教訓
- **TZ helper を 1 箇所に集約**: `src/lib/tenant-time.ts` を新設し
  `formatTenantDate / tenantCalendarDayDiff / getTenantMonthStart / getTenantNextMonthStart /
  getTenantPreviousYearMonth` を Node 標準 (Intl.DateTimeFormat) のみで実装。外部 lib 不要。
- **判定対象**:
  1. `beginner-expiry.service.ts`: 90日判定にテナント TZ
  2. `tenant-monthly-reset.service.ts`: per-tenant TZ で月初判定 (updateMany → 個別 update に refactor)
  3. `tenant-self.service.ts` / `tenant-storage.service.ts`: 翌月適用日を `getTenantNextMonthStart` で計算
  4. `lib/auth.config.ts` (middleware): Edge runtime 制約のため inline `tenantCalendarDayDiffEdge` 実装
  5. UI: `toISOString().split('T')[0]` → `useFormatters().formatDate(iso)`
- **Edge runtime 制約**: middleware は `Intl.DateTimeFormat` のみ使える。Node 固有 module 不可

### 設計の落とし穴

1. **`updateMany` は per-tenant TZ で使えない**: テナントごとに monthStart が異なるため、
   `findMany → JS filter → per-tenant update` のループに refactor 必須。
2. **境界値の TZ 解釈**: `2026-05-31T23:59:59Z` (UTC 月末) は JST では `2026-06-01 08:59:59` (= 翌月初)。
   テストでは UTC と JST で別の期待値を明示する。
3. **`getTenantNextMonthStart` の年跨ぎ**: 12月 → 翌年 1月の分岐を忘れずに。
4. **`session.user.timezone` はテナント値** (PR-1 で意味変更): middleware から `auth.user.timezone` 参照可。

### 関連
- 元 PR: PR-4 (2026-05-15) テナント TZ 計算ロジック移行
- helper: src/lib/tenant-time.ts
- 対象 service: beginner-expiry / tenant-monthly-reset / tenant-self / tenant-storage
- middleware inline helper: src/lib/auth.config.ts `tenantCalendarDayDiffEdge`
- 前提 PR: PR-1 (#327) Tenant.timezone schema

---

## 5.X+20 `eslint-config-next` minor 上げで `react-hooks/set-state-in-effect` / `react-hooks/refs` が新規 enforce — 既存 useEffect/useRef を Hooks-7.1 互換に書き換える (PR #323 dependabot 対応 / 2026-05-11)

### 罠の正体

dependabot の **patch / minor 上げ** にしか見えない `eslint-config-next 16.2.3 → 16.2.6` で、
**`eslint-plugin-react-hooks` が 7.0.x → 7.1.1 に transitive bump** し、以下 2 ルールが新規 enforce:

| ルール | 検出対象 | 影響範囲 |
|---|---|---|
| `react-hooks/set-state-in-effect` | useEffect 本体内 (同期) で setState を呼ぶ、または **setState を含む関数を呼ぶ (call graph 解析)** | fetch-on-mount / derived state sync / deep-link auto-open |
| `react-hooks/refs` | render 中 (= useEffect/useCallback/event handler 外) で `ref.current = ...` する | "最新値を保持する ref" の常用パターン |

CI ログでは `eslint-plugin-react-hooks` の version 表記が無いため、**「config-next を上げただけ」と
見誤って原因特定が遅れる**。実体は **transitive な peer plugin** の major-minor 跨ぎ強化。

PR #323 の CI fail 内訳 (5 件):

| ファイル | ルール | 構造 |
|---|---|---|
| `src/app/(auth)/setup-password/page.tsx:78` | set-state-in-effect | useEffect 同期分岐 `if (!token) { setTokenError(...); setIsValidating(false); }` |
| `src/app/(dashboard)/memos/memos-client.tsx:264` | set-state-in-effect | `useEffect(() => setMemos(initialMemos), [initialMemos])` (derived state sync) |
| `src/app/(dashboard)/projects/[projectId]/suggestions/suggestions-panel.tsx:191` | set-state-in-effect | `useEffect(() => { void reload(); }, [reload])` (call graph で reload 内 setState を検出) |
| `src/app/(dashboard)/projects/[projectId]/tasks/tasks-client.tsx:785` | set-state-in-effect | useEffect 内 `openEditDialog(target)` (useCallback 内で setState を呼ぶ) |
| `src/lib/use-lazy-fetch.ts:35` | refs | `stateRef.current = state` を render body 直下で実行 |

### 修正パターン (4 種類)

#### Pattern A: 初期 state を派生させる (synchronous-setState-in-effect 解消)

**Before:**

```tsx
const [tokenError, setTokenError] = useState('');
const [isValidating, setIsValidating] = useState(true);
useEffect(() => {
  if (!token) {
    setTokenError(t('invalidLink'));  // ★ violation
    setIsValidating(false);
    return;
  }
  fetch(...).then(...);
}, [token, t]);
```

**After:**

```tsx
// 初期 state を token 有無から派生
const [tokenError, setTokenError] = useState(token ? '' : t('invalidLink'));
const [isValidating, setIsValidating] = useState(!!token);
useEffect(() => {
  if (!token) return;        // 初期 state で表示済
  fetch(...).then(...);      // .then 内 setState は microtask で対象外
}, [token, t]);
```

#### Pattern B: derived state は **render 中に prev 比較で setState** (React 公式推奨)

`useEffect(() => setX(prop), [prop])` は React 公式が "Anti-pattern" と明記している。
代わりに **render 中の条件付き setState** (React は自動的に再 render を 1 回に統合) を使う。

**Before:**

```tsx
const [memos, setMemos] = useState(initialMemos);
useEffect(() => {
  setMemos(initialMemos);  // ★ violation + 余分な再 render
}, [initialMemos]);
```

**After:**

```tsx
const [memos, setMemos] = useState(initialMemos);
const [prevInitialMemos, setPrevInitialMemos] = useState(initialMemos);
if (prevInitialMemos !== initialMemos) {
  setPrevInitialMemos(initialMemos);  // render 中の setState は合法 (React docs)
  setMemos(initialMemos);
}
```

ref: <https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes>

#### Pattern C: ref 同期は useEffect 経由 (`react-hooks/refs` 解消)

**Before:**

```ts
const stateRef = useRef(state);
stateRef.current = state;  // ★ violation: render 中の ref 更新
```

**After:**

```ts
const stateRef = useRef(state);
useEffect(() => {
  stateRef.current = state;  // commit 後に同期、async コールバックの読出しには十分
});
```

#### Pattern D: 公式が認める正当パターンは `eslint-disable-next-line` (reason コメント必須)

以下は React 公式が `useEffect` を **正当な選択肢** として挙げているため、disable で局所許容する:

1. **fetch-on-mount** (`useEffect(() => { void reload(); })`):
   ref: <https://react.dev/reference/react/useEffect#fetching-data-with-effects>
2. **Deep-link 着地時の 1 回限り副作用** (ref ガード済の auto-open dialog):
   cascading render は ref ガードで防止済

**書き方** (理由は必ず `--` 以降に明記):

```tsx
useEffect(() => {
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reload は async で setState は microtask、fetch-on-mount 公式パターン
  void reload();
}, [reload]);
```

### 検出が遅れた理由

- `eslint-plugin-react-hooks` の version は `eslint-config-next` の transitive。`pnpm-lock.yaml`
  の差分にしか現れず、PR の `package.json` diff (`config-next` の 1 行) からは推測不可能。
- 各 violation は **build / tsc では検出されない** (lint 専用)。CI が `pnpm lint` を走らせて
  初めて発覚する。
- ローカル `pnpm lint` でも、main の lockfile (7.0.x) では新ルールが存在しないため再現しない。
  → **PR ブランチの lockfile を pull するか、`pnpm add -D eslint-plugin-react-hooks@7.1.1`
  で手動 pin** しないと再現できなかった。

### 横展開チェック (dependabot で eslint 系 minor 上げ PR を見たとき)

- [ ] `pnpm-lock.yaml` の diff から `eslint-plugin-react-hooks` の version 変動を確認
- [ ] CI lint ログで `react-hooks/(set-state-in-effect|refs)` を grep し、件数を把握
- [ ] 修正は **本 PR ではなく main ベースの独立 PR** で行う (dependabot ブランチは force-push
      されうるため変更が消える可能性)。main 経由で fix が入れば dependabot PR は rebase 後に
      自動で green
- [ ] disable directive を使う場合は **reason コメント必須** (`--` 以降に「なぜ」を書く)。
      "fetch-on-mount" や "ref ガード済" 等の根拠を残す
- [ ] 修正後は **fix branch でも `pnpm-lock.yaml` は触らない** ことを推奨 (config-next の bump は
      dependabot に任せる)。これにより fix PR は code-only の小さい diff になり review しやすい

### 関連

- 修正 PR: 本 PR (fix/eslint-react-hooks-rules-16.2.6 / 2026-05-11)
- dependabot PR: #323 (chore(deps): bump eslint-config-next from 16.2.3 to 16.2.6)
- 公式 (React docs): <https://react.dev/learn/you-might-not-need-an-effect>
- 公式 (React useEffect): <https://react.dev/reference/react/useEffect>
- 公式 (eslint-plugin-react-hooks): <https://github.com/facebook/react/tree/main/packages/eslint-plugin-react-hooks>

---

## 5.X+21 `.claude/.last-knowledge-check-sha` は **gitignore 済だが track 状態** で毎回 conflict を起こす — `git rm --cached` + `.gitattributes merge=ours` で恒久解消 (PR #326 / 2026-05-11)

### 罠の正体

`.claude/.last-knowledge-check-sha` は `session-start-knowledge-check.sh` が **ローカルセッション
毎に** 上書きする bookkeeping (前回 SessionStart 時の `origin/main` HEAD SHA) で、本来
git にコミットすべきではないファイル。

- `.gitignore` の line 56 に登録済 — 設計上は untracked
- しかし過去のセッション (2026-04-25 の auto-commit) で **gitignore 設定前に commit された**
  ため、git history 上はずっと **tracked 扱い**
- 一度 tracked になると `.gitignore` は **新規追加のみブロック** し、既存 tracked file の
  変更は通常通り stage される

→ 結果として毎日 dev ブランチで auto-commit が走り、main 側も別タイミングで更新され、
**毎回の dev → main マージで必ず 1-line conflict が発生** する。発生例:
- PR #319, #326 (dev 系) など、本ファイルしか差分がない PR が auto-PR 作成のたびに conflict 化
- 2026-05-10 にも同種の修正が必要だった (`.last-knowledge-check-sha` 単体 conflict 解消)

### 恒久対策 (PR #326 で適用)

1. **`git rm --cached .claude/.last-knowledge-check-sha`** で git tracking から外す
   - ローカルファイルは残るため SessionStart hook の動作 (line 36-39 で「ファイル不在なら
     初期化のみで exit」) には影響なし
   - 新規 clone した環境では本ファイルが存在しないが、初回 SessionStart で自動初期化される
2. **`.gitattributes` に `merge=ours` を追加** — 保険として「再 track された場合も自動で
   destination 側の値を優先する」merge driver を仕込む
   ```
   .claude/.last-knowledge-check-sha merge=ours
   ```
3. (`.gitignore` は既に line 56 に登録済 — 変更不要)

### conflict が発生してしまった時の応急処置 (恒久対策が入る前)

dev → main 方向の merge で `.last-knowledge-check-sha` だけが衝突した場合、**ファイル単体
の中身は意味を持たない** ため、destination (= main 側) の値を採用すれば良い。

```bash
# dev ブランチで main を取り込む場合
git merge origin/main
# → CONFLICT (content): Merge conflict in .claude/.last-knowledge-check-sha
git checkout --theirs .claude/.last-knowledge-check-sha
git add .claude/.last-knowledge-check-sha
git commit
```

なお、当日 dev ブランチに **本ファイルしか差分がない** auto-PR (例: PR #326) は
**マージしても main に何も変化を与えない**。conflict 解消だけして merge するか、PR ごと
close するかは判断次第:
- merge する判断 → 「daily branch 運用記録」として PR 履歴を残したい場合
- close する判断 → 純粋な no-op を main の merge log に残したくない場合

### 横展開チェック (新しく「セッション毎に変わるローカル bookkeeping ファイル」を追加するとき)

- [ ] **新規ファイルは絶対に commit しない**: `.gitignore` への登録だけでは不十分 (track
      済ファイルは止められない)。最初の commit 前に `.gitignore` 登録を済ませる
- [ ] **既存ファイルを「これからは ignore する」場合**: `.gitignore` 追加だけでなく
      **必ず `git rm --cached` で untrack** すること。`.gitattributes merge=ours` も併用
- [ ] **session-start hook が `git add -A` を使う場合**: hook 側で `git update-index --skip-worktree`
      する代替案もあるが、新規 clone した同僚に伝播しないため `.gitignore` + `git rm --cached`
      の方が安全
- [ ] auto-PR 自動化スクリプト (`session-start-git.sh` 等) は「実質コード変更が無い branch
      は PR 化しない」スキップ条件を後で追加検討 (本件のような no-op PR 量産を防ぐ)

### 再発事例 1 例目 (PR #328 / dev/2026-05-11 / 2026-05-11)

PR #326 の恒久対策 (`git rm --cached` + `.gitattributes merge=ours`) を main に入れた **その日のうちに** 同じ症状の残存 PR が現れた。原因は **dev/2026-05-11 ブランチが PR #326 untrack 適用前 (= 2026-05-10 朝の daily 自動分岐) に作成** されており、tracked 状態の `.last-knowledge-check-sha` をまだ保持していたため。

- 衝突の種別: **modify/delete** (main は delete 済、dev は modify 中)
- 解消手順: `git rm .claude/.last-knowledge-check-sha` でブランチ側でも削除を確定。以後の `pnpm-lock.yaml` 等の追加差分は無いため、本 PR は **untrack を引き継ぐだけの no-op merge**

#### 教訓 (横展開ルール)

- [ ] 恒久対策を入れた PR より **以前に分岐した既存ブランチ全てで「再度の手動マージ」が必要** (= untrack 操作は branch 内 commit 履歴の前方互換性が無い)
- [ ] 自動 daily branch 群 (`dev/YYYY-MM-DD`) で同様の operation を入れる場合は、main マージ後に **全 open dev ブランチを一斉 rebase or merge** する hook を検討 (本件は手動対応で済んだが、ブランチが 10 個以上ある日は手間が積み上がる)

### 再発事例 4 例目 (PR #332 / feat/pr-4-tenant-tz-logic / 2026-05-11) — stacked PR 固有の追加要因

PR-4 は **stacked PR** で `base = feat/pr-1-tenant-i18n-settings` (PR #327 の HEAD) のまま、PR #327 が main にマージされた後も base が古いままだった。`.last-knowledge-check-sha` 系の衝突は無かった (PR-1 から派生したため hook 更新無し) が、**KDD section の番号衝突** が発生:

- PR-4 側: `§5.X+22` で start (PR-4 ブランチ作成時点では未使用番号)
- main 側: PR #327 で `§5.X+22` が E2E_COVERAGE で先取り (= renumber 漏れ)
- 解消: PR-4 を **§5.X+28** に renumber (PR-N 予約番号体系 PR-1=+25 / PR-2=+26 / PR-3=+27 / **PR-4=+28**)

#### Stacked PR 固有教訓

- [ ] **stack の base PR が main にマージされたら、上層 PR の base を即時 main に切替える** (`gh pr edit <N> --base main`)
- [ ] base 切替なしに main マージし続けると、上層 PR の "PR diff" が base PR のコミットを再表示し続けてレビュー困難になる
- [ ] **KDD section 番号は PR-N 単位で reserved 番号体系を遵守** (PR-N = §5.X+(24+N))。
      合間の hotfix 系 PR (PR #326 / #327 / #336) は別途連番を消費するため、**並走 feature PR 側で番号を取り過ぎないよう reserved 範囲を明確化** する

### 再発事例 3 例目 (PR #330 / feat/pr-3-storage-guard / 2026-05-11)

PR-3 (Storage 20MB 共通化 + guard サービス) も同パターン。**1 日に 3 件続いた再発**で、原因は同じ「PR #326 untrack 前に分岐していた」。

- 連発の構造: PR-1 (#327), PR-2 (#329), PR-3 (#330) は **同じ親 main commit から並列に分岐** した一連の改修 → どの PR でも `.last-knowledge-check-sha` を SessionStart hook が tracked のまま更新 → main マージ後に同じ衝突パターンが量産される
- 解消手順は 1 例目 / 2 例目と完全同型: `git rm` + KDD 末尾セクション順序保持

#### 確定した結論 (3 例後)

- [ ] **PR #326 のような untrack 系恒久対策が main に入ったら、その時点で open な全ブランチを `git pull --rebase` or `git merge main` で一斉に同期する運用ルール** を hook 化検討対象に追加
- [ ] **branch protection で "main 更新後 X 時間以内に同期必須" を運用する選択肢** もあるが、現状の頻度なら本 KDD の再発事例リストを溜めるだけで横展開警告が機能する

### 再発事例 2 例目 (PR #329 / feat/pr-2-beginner-ui / 2026-05-11)

dev/* 系の auto-branch だけでなく **feature branch** (PR-2 = Beginner UI 改修) でも同じ症状が出た。`feat/pr-2-beginner-ui` は PR #326 untrack 前に分岐 + SessionStart hook で `.last-knowledge-check-sha` を更新済の状態だったため、main マージで modify/delete 衝突。

加えて **KDD_PATTERNS.md の末尾セクション衝突** も同時発生:
- PR-2 側 (HEAD): `§5.X+26` (Beginner UI) を追記
- main 側: `§5.X+25 / +20 / +21 / +22` が直前の merge ラッシュで追加済
- 解消: 全 5 セクションを順序保持で残し、各セクション間に `---` 区切りを明示

#### 追加教訓

- [ ] **長寿命 feature branch ほど積み残し conflict のリスクが高い**: 並走 PR が多い時期は週次で main を取り込む rebase / merge を推奨
- [ ] KDD section の end-of-file append は **物理的に並走 PR が衝突しやすい局所**。本ファイルに限り `.gitattributes` で `merge=union` (両側の追記を行ベース統合) を検討する余地あり ※ ただし重複 header が出るリスクがあるため要試行

### 関連

- 修正 PR: PR #326 (恒久対策本体 / dev/2026-05-10) + PR #328 (再発事例 1 例目 / dev/2026-05-11) + PR #329 (再発事例 2 例目 / feat/pr-2-beginner-ui) + PR #330 (再発事例 3 例目 / feat/pr-3-storage-guard) + PR #332 (再発事例 4 例目 / feat/pr-4-tenant-tz-logic / stacked PR)
- 関連ファイル: [.gitattributes](../../.gitattributes), [.gitignore](../../.gitignore) (line 56)
- 関連 hook: [.claude/hooks/session-start-knowledge-check.sh](../../.claude/hooks/session-start-knowledge-check.sh)
- 公式 (gitignore): <https://git-scm.com/docs/gitignore> ("Files already tracked by Git are not affected")
- 公式 (gitattributes merge): <https://git-scm.com/docs/gitattributes#_defining_a_custom_merge_driver>

---

## 5.X+22 新規 `page.tsx` / `route.ts` を追加したら **必ず `docs/test/E2E_COVERAGE.md` 更新**、UI 移管 PR は **visual baseline 再生成必須** — 旧ルート削除と併せた一括対応のチェックリスト (PR #327 / PR-1 tenant-i18n / 2026-05-11)

### 罠の正体

PR #327 (PR-1 timezone/locale をテナント単位に集約) で 2 種類の CI fail が同時発生した:

1. **`pnpm e2e:coverage-check` fail**:
   ```
   ❌ docs/test/E2E_COVERAGE.md に未記載の機能があります:
      - /api/tenants/me/i18n
   ```
   新設した route の登録漏れ。`scripts/check-e2e-coverage.ts` が PR #90 以降 enforce。

2. **Playwright visual regression fail** (`settings-light.png`):
   ```
   Expected an image 1440px by 1473px, received 1440px by 1125px.
   28893 pixels (ratio 0.02 of all image pixels) are different.
   ```
   `/settings` から timezone/locale UI (123 行) を `/settings/tenant` へ移管した結果、
   設定画面の高さが 1473px → 1125px (348px 縮小) して baseline drift。

両方とも **「実装意図通りの当然の結果」** で、コード自体に不具合は無いが、
**周辺ドキュメント / baseline の更新を本 PR 内で同梱しないと CI が通らない**。

### 根本原因

- **新規 route 追加** = E2E_COVERAGE.md 更新は ローカル `pnpm e2e:coverage-check`
  または CI 失敗で気付く設計だが、**実装着手時にチェックリストを開いていないと忘れる**
- **UI 移管・削除** = visual baseline は **PR で `[gen-visual]` トリガー** しないと
  drift し続ける。今回は **旧 UI 削除のみ気付いたが baseline 更新を忘れた**

### 修正パターン (本 PR で適用)

```bash
# 1. 新 route 追加時のチェックリスト
pnpm e2e:coverage-check              # ローカルで確認
# → ❌ 表示されたら docs/test/E2E_COVERAGE.md に
#   - [ ] `/api/path` — skip: <理由> または
#   - [x] `/api/path` — e2e/specs/XX-spec.ts
# の形式で追加

# 2. 旧 route 削除時のチェックリスト
# E2E_COVERAGE.md の旧エントリを「削除済 (PR-N / YYYY-MM-DD)」と記録
# (検索性のため完全削除はしない、移管先 PR への辿りやすさ確保)

# 3. UI 移管/削除時の visual baseline 再生成
# 別 commit で空コミットを作る:
git commit --allow-empty -m "chore(visual): regenerate baseline for /settings UI 縮小 [gen-visual]"
git push
# → .github/workflows/e2e-visual-baseline.yml が発火し
#   baseline 画像を再生成して bot コミットで PR ブランチに push
```

### 横展開チェック (UI 移管 / route 移管系の PR を作る時)

- [ ] **新 route**: `pnpm e2e:coverage-check` をローカルで実行 → ✅ になるまで `docs/test/E2E_COVERAGE.md` に追記
- [ ] **旧 route**: 削除した route は E2E_COVERAGE.md で `[x] **削除済 (PR-N / YYYY-MM-DD)**` 表記に更新 (完全削除しない)
- [ ] **UI 縮小/拡大**: `pnpm test:e2e e2e/visual/` をローカル実行できるなら事前確認。CI で fail したら `[gen-visual]` commit で再生成
- [ ] **新 UI 追加 (新画面)**: 対応する visual spec を `e2e/visual/` 配下に追加 + `[gen-visual]` で baseline 生成
- [ ] **「ユーザ単位設定 → テナント単位設定」のような認可境界変更**: 旧 API の `/api/settings/i18n` を関連する全画面から呼び出し撤去 (本件: settings-client.tsx の useEffect から削除)。残しておくと 404 を呼び続けて余計なエラーログが発生
- [ ] **JWT claim の意味変更**: `session.user.timezone` の値が「ユーザ TZ」から「テナント TZ」に変わる場合、**型は同じ string でも意味が違う** ため、命名維持は OK だが TS コメントで明示 (rg `session\.user\.timezone` で全箇所確認)

### 設計の落とし穴 (PR-1 で踏んだもの)

1. **null 許容の撤廃**: `User.timezone String?` → 廃止、`Tenant.timezone String NOT NULL DEFAULT 'Asia/Tokyo'`。
   テナント単位では「null = 未設定」概念が不要 (DB default が機能する) ため NOT NULL 化。
   `resolveTimezone()` のフォールバックチェーンを 1 段減らせる + 型安全 (`session.user.timezone: string`)
2. **`useSession().update({ timezone, locale })` の patch 型を `string | null` から `string` に絞る**:
   null を入れる経路 (= システム既定に戻す UI) を廃止したため
3. **データインポートの後方互換**: 旧 ZIP に `User.timezone / User.locale` が含まれていても
   新 import コードは黙って無視。NULL を書き戻すと型エラーで止まるため defensive 設計
4. **データエクスポートの新フィールド**: `ExportSummary` に `tenantTimezone` / `tenantLocale` 追加。
   再インポート時にテナント設定を復元する手がかり (将来の super_admin 代行 import 用)

### 関連

- 元 PR: PR-1 (2026-05-15 / feat/pr-1-tenant-i18n-settings)
- 関連 KDD: §5.X+25 (テナント単位 i18n 設計の詳細)
- 関連 script: [scripts/check-e2e-coverage.ts](../../scripts/check-e2e-coverage.ts)
- 関連 workflow: [.github/workflows/e2e-visual-baseline.yml](../../.github/workflows/e2e-visual-baseline.yml)
- 関連 doc: [docs/test/E2E_COVERAGE.md](../test/E2E_COVERAGE.md), [E2E カバレッジ運用](../test/E2E_LESSONS.md)

---

## 5.X+23 super_admin ダッシュボードで Default テナント (運営者自身) を **集計除外** しても **画面非表示にはしない** — 「集計」と「表示」の境界を明確に分ける (PR-X / 2026-05-11)

### 罠の正体

PR E (`#19`, 2026-05-09) で super_admin ダッシュボードの集計から `DEFAULT_TENANT_ID` を除外する変更を入れた (`SUPER_ADMIN_EXCLUDED_TENANT_IDS = [MANAGEMENT_TENANT_ID, DEFAULT_TENANT_ID]`)。これは「v1.x マルチテナント運用時に default テナントを実顧客と扱わない」設計合意 B に従ったもの。

しかし v1 MVP (2026-06-01 リリース直前) 時点では Default テナントが唯一の本番テナントとなるため、運営者がダッシュボードを開いても:

- 「顧客テナント数」「アクティブユーザ数」「今月の API 呼出」「今月の API 費用」が**すべて 0 表示**
- 「テナント一覧」に「顧客テナントはまだ登録されていません」表示
- 「プラン別分布」に「テナントがありません」表示
- Anthropic / Voyage / Beginner 使用量も 0 表示

「ダッシュボードが完全に空に見える」=「運営者が自身のテナントを super_admin 画面で管理できない」状態だった。

### 根本原因

- **「集計から除外」=「画面から非表示」と誤って同一視していた**
- ユーザ意図: Default テナント = 運営者自身 = **請求対象外** だが、**運営者は当然自分の状況を見たい**
- 集計 (請求合計) と表示 (運営者の管理画面) は**別の目的**で動く設計にすべきだった

### 修正パターン (2026-05-11)

「集計除外」と「表示」を分離:

1. **集計除外は維持**: `SUPER_ADMIN_EXCLUDED_TENANT_IDS` は変更せず、顧客課金合計に Default を入れない方針を継続 (= 売上扱いしない)
2. **Default 専用セクションを追加**: `getDefaultTenantOwnSummary()` を新設、サマリ / 一覧 / 使用量サマリの各タブで **顧客テナントとは別セクション** で Default の情報を表示
3. **「(請求対象外)」ラベル併記**: 費用欄に明示し、運営者が「課金されている」と誤解しないようにする

```typescript
// src/services/super-admin.service.ts
// ❌ Before: 集計除外 = 画面非表示
const SUPER_ADMIN_EXCLUDED_TENANT_IDS = [MANAGEMENT_TENANT_ID, DEFAULT_TENANT_ID];
// (Default テナントの情報を取得する関数は存在しなかった)

// ✅ After: 集計除外は維持しつつ、画面表示用の取得関数を追加
const SUPER_ADMIN_EXCLUDED_TENANT_IDS = [MANAGEMENT_TENANT_ID, DEFAULT_TENANT_ID];

export async function getDefaultTenantOwnSummary(): Promise<DefaultTenantOwnSummary | null> {
  const t = await prisma.tenant.findFirst({
    where: { id: DEFAULT_TENANT_ID, deletedAt: null },
    /* ... */
  });
  if (!t) return null;
  // 必要な集計を行って返す
}
```

### 副次的な改善 (本 PR で同時対応)

1. **ストレージ add-on 課金の合算 UI**: `getCrossTenantUsageSummary` に `totalCurrentMonthStorageJpy` / `totalCurrentMonthCombinedJpy` を追加。サマリカードを「今月の API 費用 (合計)」→「今月の合計課金 (LLM + Storage)」に変更し、内訳を補助行で併記。
2. **小数点パーセント表示の精度動的化**: Voyage AI 使用率が 0.03% (= 200M token 上限の 60K token 利用) のとき `(0.0003 * 100).toFixed(1) = "0.0%"` で「未使用」と誤解されていた。`formatPercent()` ヘルパで < 0.1% は小数点 3 桁、< 10% は 2 桁、それ以外は 1 桁の動的精度に変更。

### 横展開チェック

- [ ] 集計除外フィルタ (`{ notIn: [...] }` / `{ id: { not: ... } }`) を追加する際は、**集計と表示の用途を明確に分ける**:
  - 集計から外す → DB レベルで notIn
  - 表示は欲しい → 別関数で個別取得、UI で別セクション化
- [ ] パーセント表示は `toFixed(1)` を機械的に使わず、想定される値の幅 (例: 0.01%〜100%) を考慮して動的精度関数を使う
- [ ] 「顧客課金集計」と「運営者自身の利用状況」は **同じ UI 表現で混ぜない** (= 区別が視覚的につくよう別セクション + ラベルで明示)
- [ ] 「(請求対象外)」「(参考)」など意図のラベルを併記し、UI 受け手 (= 運営者) の誤読を防ぐ

### 関連

- 元 PR: PR-X / dev/2026-05-11 (super_admin ダッシュボード Default テナント表示)
- 関連 service: [src/services/super-admin.service.ts](../../src/services/super-admin.service.ts) — `getDefaultTenantOwnSummary`, `getCrossTenantUsageSummary`
- 関連 page: [src/app/(dashboard)/admin/super/page.tsx](../../src/app/(dashboard)/admin/super/page.tsx), [tenants/page.tsx](../../src/app/(dashboard)/admin/super/tenants/page.tsx), [usage/page.tsx](../../src/app/(dashboard)/admin/super/usage/page.tsx)
- 旧設計合意: 設計合意 B (= v1.x マルチテナント運用時に default = placeholder 扱い) — v1 MVP では「Default = 運営者自身のテナント」を主とし、v1.x で multi-tenant 化される時点で再評価


## 5.X+24 集計除外フィルタは **集計・スナップショット・履歴クエリの 3 段全部** に揃えないと月次 CSV (請求書根拠) に Default が混入する (2026-05-11 監査で検出)

### 罠の正体

§5.X+23 で「Default テナントを顧客集計から除外」する方針を導入したが、その時に修正したのは **顧客集計クエリ** (`getCrossTenantUsageSummary` / `listAllTenants` 等の "現在値" 系) のみだった。

監査で 2 件の漏れが判明:

1. **`saveMonthlyUsageSnapshots` (= 月初リセット cron で前月使用量を `tenant_monthly_usage_history` に保存する関数)** が `id: { not: MANAGEMENT_TENANT_ID }` のみで絞っており、**Default テナントの月次スナップショットが毎月 DB に保存され続ける**。
2. **`listMonthlyUsageHistory` (= /admin/super/usage の過去月履歴 + CSV エクスポートの過去月経路で参照)** には **テナント除外フィルタが存在しなかった**。

→ 結果として:
- 過去月の CSV エクスポート (= 請求書根拠) に **Default テナント行が混入**
- /admin/super/usage の「過去 6 ヶ月の使用量履歴」テーブルに **Default 行が表示**
- 顧客集計には除外、過去月集計には混入、という**不整合**が発生

### 影響範囲

これは事業継続性に直結する不具合:

1. **取りこぼし方向**: 該当しない (Default は売上扱いしない方針なので、CSV に Default が混じっても請求書合計が増えるだけで取りこぼしはなし)
2. **過剰請求方向**: 該当しない (= Default テナントの請求業務は実施しないため、CSV 上に出ても運営者が見ているだけ)
3. **しかし運用混乱**: CSV 集計時に「これ請求しなくていいやつだっけ?」と毎月の確認コストが発生 + 集計ツールで気付かず Default 込みの合計を顧客請求合計と誤認するリスク

### 修正パターン (2026-05-11)

集計除外フィルタを **3 段全部** に揃える:

```typescript
// 1. 顧客集計クエリ (= 既存 / §5.X+23 対応済)
const SUPER_ADMIN_EXCLUDED_TENANT_IDS = [MANAGEMENT_TENANT_ID, DEFAULT_TENANT_ID];
prisma.tenant.findMany({ where: { id: { notIn: SUPER_ADMIN_EXCLUDED_TENANT_IDS } } });

// 2. スナップショット保存 (= 今回追加)
//    src/services/tenant-monthly-reset.service.ts
const SNAPSHOT_EXCLUDED_TENANT_IDS = [MANAGEMENT_TENANT_ID, DEFAULT_TENANT_ID];
prisma.tenant.findMany({ where: { id: { notIn: SNAPSHOT_EXCLUDED_TENANT_IDS } } });

// 3. 履歴クエリ (= 今回追加、二重防御)
//    src/services/super-admin.service.ts (listMonthlyUsageHistory)
prisma.tenantMonthlyUsageHistory.findMany({
  where: {
    yearMonth: { in: targetYearMonths },
    tenantId: { notIn: SUPER_ADMIN_EXCLUDED_TENANT_IDS },  // 二重防御
  },
});
```

### 横展開チェック (今後同様の除外フィルタを足す時の checklist)

- [ ] **「現在値」を返す関数**: `prisma.tenant.findMany` / `aggregate` / `groupBy` / `count` のすべての where に `id: { notIn: EXCLUDED }` を入れる
- [ ] **「過去値」を保存する関数 (cron / snapshot)**: 保存対象テナントの絞り込みにも同じ除外を入れる (= 保存しないことで根本的に混入経路を遮断)
- [ ] **「過去値」を読む関数 (履歴クエリ / 集計レポート)**: 既存データに対する **二重防御** として where に除外フィルタを入れる
- [ ] **CSV / レポート / 外部連携 API**: 上記 3 段に依存する API は再検証
- [ ] **ユニットテスト**: 各関数の where 条件を assert.toMatchObject で検証 (= 将来の改修で除外が外れても CI で気付く)

### 請求業務正確性の防衛線 (本 PR で構築)

「請求金額の取りこぼし / 過剰請求」を防ぐため、以下を多重で保証する:

| レイヤ | 検証手段 | 件数 |
|---|---|---|
| サービス層 | super-admin.service.test.ts (listAllTenants / listStorageUsageTop / getTenantDetail / getCrossTenantUsageSummary / getDefaultTenantOwnSummary / listMonthlyUsageHistory) | 56 件 |
| cron 層 | tenant-monthly-reset.service.test.ts (saveMonthlyUsageSnapshots の Default 除外) | 20 件 (既存 + 改修) |
| API 層 | api/admin/super/usage/export/route.test.ts (CSV 当月 / 過去月 / Default 除外 / 認可) | 12 件 |
| E2E 層 | e2e/specs/13-super-admin-dashboard.spec.ts (ダッシュボード表示 + Default 別セクション + CSV Default 除外 + 認可境界) | 5 件 |

### 関連

- 元 PR: PR-X / dev/2026-05-11 (請求業務正確性監査)
- 関連 service: [src/services/tenant-monthly-reset.service.ts](../../src/services/tenant-monthly-reset.service.ts), [src/services/super-admin.service.ts](../../src/services/super-admin.service.ts)
- 関連 test: [src/services/super-admin.service.test.ts](../../src/services/super-admin.service.test.ts), [src/services/tenant-monthly-reset.service.test.ts](../../src/services/tenant-monthly-reset.service.test.ts), [src/app/api/admin/super/usage/export/route.test.ts](../../src/app/api/admin/super/usage/export/route.test.ts), [e2e/specs/13-super-admin-dashboard.spec.ts](../../e2e/specs/13-super-admin-dashboard.spec.ts)
- 関連 KDD: §5.X+23 (集計除外と画面表示の分離)

---

## 5.X+30 長期 PR と main の並行更新で KDD ファイル末尾コンフリクトが発生する ─ 両方残してマージするのが正解 (PR #334 / 2026-05-12)

### 罠の正体

`docs/knowledge/KDD_PATTERNS.md` のような **追記専用ナレッジファイル** は、ブランチごとに末尾へ新セクションを足す運用のため、長期 PR が main の高頻度マージ (PR-1 〜 PR-5 のような関連 PR 群) に遅れると **「両ブランチが末尾に異なるセクションを追加した」** タイプのコンフリクトが必発する。

PR #334 のケースでは:
- HEAD (PR #334 ブランチ): `## 5.X+24 dependabot 複数 PR の pnpm-lock.yaml コンフリクト` を末尾に追加
- main: `## 5.X+27 ストレージ上限 LLM プラン切り離し` 他 5 件 (5.X+25/26/27/28/29) を末尾に追加

両者は **独立した別トピックの新規ナレッジ** であり、片方を破棄すると情報損失が発生する。

### 採用したパターン

**両方残す + 番号順に整える** が正解:

1. コンフリクトマーカー (`<<<<<<<` / `=======` / `>>>>>>>`) を除去
2. HEAD 側セクションを残す (5.X+24)
3. main 側セクション (5.X+27) を続けて配置
4. 番号順 (24 → 27) で並ぶよう間に空行を挿入

main 側の section 番号順序が既に非連続 (例: 27→29→26→25→28→22 の順で並んでいる) でも、それを正すのは **別 PR の整理タスク** として切り分け、本コンフリクト解決の範囲外とする (= scope creep を避ける)。

### 予防策

| 戦略 | 効果 | コスト |
|---|---|---|
| **KDD ファイルへの追記は PR の最後にまとめる** | コンフリクト発生確率を低減 | 軽 (運用ルール) |
| **長期 PR は main を週次で rebase / merge** | コンフリクトを小さく頻繁に解消 | 中 (作業時間) |
| **KDD ファイルを「セクション 1 ファイル」に分割** | ファイル単位コンフリクトを排除 | 高 (構造変更) |
| **section 番号を `5.X+N` から日時 prefix へ移行** | 番号衝突自体を回避 | 中 (既存ファイルの一括書き換え) |

現状は **運用ルール (追記は PR 最後にまとめる) + 長期 PR は週次 rebase** で対応。日時 prefix 移行はバックログ候補。

### 横展開チェック (KDD ファイル編集 PR のレビュー時)

- [ ] PR が長期化していないか (1 週間以上 main を取り込んでいない場合は rebase 推奨)
- [ ] 追加セクションの番号が既存の最大番号 + 1 か (main 側で番号が進んでいる可能性)
- [ ] コンフリクト解決時に **どちらかのセクションを誤って削除していない** か
- [ ] セクション番号順に並べた結果、参照リンク (`§5.X+25` 等) が壊れていないか

### 関連

- 修正例: PR #334 (2026-05-12) / コンフリクト発生 PR #317 関連の連鎖
- 同類パターン: `.claude/.last-knowledge-check-sha` のような自動更新ステートファイル (PR #310 で対処)
- 関連 doc: [docs/knowledge/KDD_PATTERNS.md](./KDD_PATTERNS.md) 自身

---

## 5.X+31 「ログインできない」の真因は別経路にあることが多い ─ 切り分け手順と防御的 server component (PR fix/admin-users-defensive-render / 2026-05-15)

<!-- PR #335 マージ時 renumber: 元番号 §5.X+28 → §5.X+30 → §5.X+31。
     PR #334 が先にマージされて main 側 §5.X+30 (KDD ファイル末尾コンフリクト
     パターン) と衝突したため次の空き番号に再配置。§5.X+30 自身が記録する
     パターンの実践例となった。 -->

### 背景
ユーザから「サービスへログインできなくなった」と報告。共有された error log は `system_error_logs`
テーブルの内容で、最新エラーは `/admin/users` での Server Components render error (digest 713007954)、
それ以外は `[attachments/batch]` 系の info ログばかり。**ログイン失敗を示すエントリが存在しなかった**。

調査の結果、ログイン失敗イベントは `auth_event_logs` (別テーブル) に記録される設計のため、
`system_error_logs` を見ても真因は判らない構造だった。

### 教訓 (切り分けフローの確立)

**1. ログイン失敗かどうかを最初に確認**:

```sql
-- 直近 24 時間の login_failure を email で抽出
SELECT event_type, detail, ip_address, created_at
FROM auth_event_logs
WHERE event_type = 'login_failure'
  AND email = '<ユーザ email>'
  AND created_at >= NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;
```

`detail.reason` の値で原因を判別:
- `user_not_found`: メール未登録 (typo or 削除済)
- `invalid_password`: パスワード誤り (試行回数も同 row で確認)
- `temporary_lock`: 一時ロック中 (`lockedUntil` 確認)
- `permanent_lock`: 永続ロック (recovery code または admin に解除依頼)
- `inactive`: アカウント無効化 (admin が isActive=false にした)
- `tenant_deleted`: テナント論理削除中
- `missing_credentials`: 空 submit (client bug の可能性)

**2. login_failure ログがない場合 = ログインは成功している可能性大**:

ユーザは「ログインできない」と感じているが実際にはログインできており、**ログイン直後の遷移先で
server component が crash して error boundary に飛ばされている** ケースがある。ユーザにとっては
「ログイン → エラー → 戻る → ログイン → エラー」のループに見える。

確認方法:

```sql
-- 同 email の login_success が直近にあるか
SELECT event_type, created_at FROM auth_event_logs
WHERE email = '<ユーザ email>'
  AND event_type IN ('login_success', 'login_failure')
ORDER BY created_at DESC LIMIT 10;
```

login_success が出ているのに login_failure も間に挟まる場合 = ログイン成功 → 画面でエラー → 再ログイン
のループパターン確定。

**3. server component error の digest を Vercel で追跡**:

```
Vercel Dashboard → Project → Logs → Search "digest=713007954"
```

production build では `error.message` がマスクされて UI に出ないが、Vercel runtime log には
完全なスタックトレースが残る。**digest が同じなら同じ箇所での throw**。

### 防御的 server component パターン (PR fix/admin-users-defensive-render)

`/admin/users` のような **ログイン直後にユーザが遷移しやすいページ** が server component crash すると、
ユーザは「ログインできない」と認識する。次の防御策で UX とデバッグ可能性を両立する:

```ts
// Before
const [users, tenantInfo] = await Promise.all([
  listUsers(session.user.tenantId),
  getTenantSelfInfo(session.user.tenantId),
]);

// After (PR fix/admin-users-defensive-render):
let users: Awaited<ReturnType<typeof listUsers>> = [];
let tenantInfo: Awaited<ReturnType<typeof getTenantSelfInfo>> = null;
let dataLoadError = false;
try {
  [users, tenantInfo] = await Promise.all([
    listUsers(session.user.tenantId),
    getTenantSelfInfo(session.user.tenantId),
  ]);
} catch (error) {
  dataLoadError = true;
  await recordError({
    severity: 'error',
    source: 'server',
    message: '[/admin/users] failed to load users or tenant info',
    stack: error instanceof Error ? error.stack : String(error),
    userId: session.user.id,
    context: {
      path: '/admin/users',
      errorName: error instanceof Error ? error.name : 'unknown',
      errorMessage: error instanceof Error ? error.message : String(error),
      tenantId: session.user.tenantId,
    },
  });
}

return <UsersClient ... dataLoadError={dataLoadError} />;
```

ポイント:
- **error message を `system_error_logs` に詳細記録**: digest 番号だけで Vercel を辿る必要を減らす。
  errorName / errorMessage / stack を context に入れることで `system_error_logs` から原因が直接判る。
- **画面操作は維持**: 一覧は空 + 警告バナー表示にとどめ、ヘッダ / 招待 dialog 等は引き続き使える。
  admin が他経路で復旧操作を取れる。
- **error boundary に飛ばさない**: dashboard セグメントの error.tsx に飛ぶと「ログインできない」
  感じになる。本パターンで予防的に防げる。

### 横展開で漏らしやすい箇所

ログイン直後にユーザが遷移しやすい主要ページ:
- `/projects` (デフォルト遷移先、最高優先)
- `/admin/users` (admin 系)
- `/settings`, `/settings/tenant`
- `/projects/[id]` (前回開いていたプロジェクト)

これらは **server component の最上位データ取得を try/catch で囲み、空フォールバック + recordError
+ dataLoadError prop で UI 警告** のパターンを適用すべき。後続 PR で横展開。

### 関連
- 元 PR: fix/admin-users-defensive-render (2026-05-15)
- 関連 service: src/services/error-log.service.ts (`recordError`)
- 関連 layout: src/app/(dashboard)/error.tsx (default error boundary)
- 関連 schema: prisma/schema.prisma `AuthEventLog` モデル (eventType / detail / email / userId)

---

## 5.X+32 「invalid_password と記録されているが本人は正しい入力 + パスワードマネージャ使用」のパターン ─ authorize() 例外で auth_event_logs に何も残らないケースが多い (PR fix/auth-diagnostics-defensive / 2026-05-15)

<!-- PR #335 マージ時 renumber: 元番号 §5.X+29 → §5.X+31 → §5.X+32。
     §5.X+31 (login defensive) と連番化するため。 -->

### 背景
ユーザから「サービスへログインできない、ログイン情報はパスワードマネージャ使用で誤入力ありえない」報告。
`auth_event_logs` を確認すると `reason: invalid_password` で 2 行のみ、ただし **どちらも 2 週間以上前** で、
**今日のログイン試行は 1 件も記録されていない**。

```sql
SELECT event_type, detail, created_at FROM auth_event_logs
WHERE event_type = 'login_failure' AND email = 'xxx@example.com'
ORDER BY created_at DESC LIMIT 20;
-- → 2 行のみ、最新は 2 週間前
```

= ユーザは今日もログインボタンを押しているはずなのに **auth_event_logs に何も書かれていない** =
**authorize() 関数の途中で例外が発生し、recordAuthEvent を呼ぶ前に死んでいる** 可能性が極めて高い。

### 教訓
- **「event_type='login_failure' に絞った検索」だけでは不十分**: 直近の event 全体を確認する:
  ```sql
  SELECT event_type, detail, created_at FROM auth_event_logs
  WHERE email = 'xxx@example.com' AND created_at >= NOW() - INTERVAL '24 hours'
  ORDER BY created_at DESC LIMIT 50;
  ```
- **直近 24h で 1 行も無ければ authorize() 未到達を疑う**:
  - NextAuth handler が落ちている (Vercel runtime log を要確認)
  - Prisma connection failure (`prisma.user.findFirst` で throw)
  - bcrypt が hash format error で throw
  - middleware が信号を block
- **authorize() を try/catch でラップ + internal_error 経路を必ず記録する**:

```ts
async authorize(credentials) {
  try {
    // 既存のロジック
  } catch (e) {
    await recordAuthEvent({
      eventType: 'login_failure',
      email: typeof credentials?.email === 'string' ? credentials.email : undefined,
      detail: {
        reason: 'internal_error',
        errorName: e instanceof Error ? e.name : 'unknown',
        errorMessage: e instanceof Error ? e.message : String(e),
        stackHead: e instanceof Error && typeof e.stack === 'string'
          ? e.stack.slice(0, 500) : null,
      },
    }).catch(() => undefined); // recordAuthEvent 自体の失敗で連鎖を起こさない
    return null;
  }
}
```

これで「authorize() に到達したが何かで死んだ」ケースを **DB 一発で判別可能** になる。

### bcrypt compare 周辺の診断ログ強化

「authorize() に到達 + invalid_password の経路を辿る」場合でも、真因は次の 4 つに分かれる:

1. **本当にパスワード違い** (= ユーザの記憶違い / autofill が古い値)
2. **passwordHash カラムが壊れている** (= 文字化け / truncated / null / 空文字)
3. **bcrypt hash format mismatch** (= '$2a$' / '$2b$' / '$2y$' いずれでもない = 別アルゴリズムのハッシュが混入)
4. **bcryptjs library 互換性** (= 別バージョンで作られた hash で compare が失敗)

これらを切り分けるため、`login_failure` の detail に下記を追記する:

```ts
const passwordHashLength = user.passwordHash?.length ?? 0;
const passwordHashPrefix = (user.passwordHash ?? '').slice(0, 7); // '$2a$10$' / '$2b$12$' 等
const bcryptStart = Date.now();
let isValid: boolean;
let bcryptError: string | null = null;
try {
  isValid = await compare(password, user.passwordHash);
} catch (e) {
  isValid = false;
  bcryptError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
const bcryptElapsedMs = Date.now() - bcryptStart;

if (!isValid) {
  await recordAuthEvent({
    eventType: 'login_failure',
    /* ... */
    detail: {
      reason: 'invalid_password',
      passwordHashLength,    // 標準は 60。それ以外なら hash 破損
      passwordHashPrefix,    // '$2a$' / '$2b$' / '$2y$' 以外なら format 異常
      bcryptElapsedMs,       // 0-1ms なら即時失敗 (hash 不正)、50-200ms が正常
      bcryptError,           // compare 例外時のエラー名
    },
  });
}
```

判別:
- `passwordHashLength != 60` → hash 破損 (DB の passwordHash カラムを直接修正、または password reset 発行)
- `passwordHashPrefix not in ['$2a$', '$2b$', '$2y$']` → format 異常 (同上)
- `bcryptError != null` → bcrypt が throw (= invalid hash の format chars 等、ライブラリ更新による互換性問題の可能性も)
- 上記全て正常 + `isValid = false` → **本当に password 違い** (ユーザは password マネージャ更新 / reset を案内)

### 横展開で漏らしやすい箇所

- **MFA 認証経路** (`/api/auth/mfa/verify`): 同様に internal_error 経路を保証
- **パスワード変更** (`/api/auth/change-password`): 既存 hash の compare で同じ問題があり得る
- **パスワードリセット** (`/api/auth/reset-password/...`): bcrypt 周辺の例外捕捉

### 関連
- 元 PR: fix/auth-diagnostics-defensive (2026-05-15)
- 関連 service: src/lib/auth.ts (`authorize`)
- 関連 event log: prisma/schema.prisma `AuthEventLog` モデル (`detail` JSONB)
- 過去の関連 §5.X+31: 「ログイン直後 server component crash = ログインできない感」

---

## 5.X+33 service コード conflict: 「片側は refactor、もう片側はコメント追加」型 ─ コメント意図が既に定数化されていれば refactor を採用し、historical context として吸収する (PR #337 / 2026-05-12)

### 罠の正体

長期 PR と main の並行で **同じ関数を異なる粒度で編集** していた場合、`git merge` は両方の差分をマーカで提示するが、機械的には判断できないケースがある:

| ブランチ | 編集粒度 | 例 (PR #337) |
|---|---|---|
| HEAD | **コメント追加のみ** (実装意図の追記) | 「2026-05-11: Default テナントも除外 — 過去 PR では MANAGEMENT のみ除外していた」 |
| main | **構造的 refactor** (関数挙動の変更) | UTC 月初固定 → per-tenant TZ ローカル月初に切替 + `targets` → `allTenants` 変数名変更 + filter を JS 側に移動 |

両者を素朴に concat すると、main の refactor 構造に HEAD のコメントが宙ぶらりんで貼り付くか、HEAD のコメントが消えて意図の歴史が失われる。

### 採用したパターン

**「HEAD コメントの意図が既に定数 / 設定で実現されていないか」を先に確認** する:

```bash
# 例: HEAD コメントが「Default テナントも除外」と言っているなら、
#     その定数 (SNAPSHOT_EXCLUDED_TENANT_IDS 等) を grep し、main 側に既に
#     反映済かを確認する。
grep -nE "SNAPSHOT_EXCLUDED_TENANT_IDS|DEFAULT_TENANT_ID" <service>.ts
# → const SNAPSHOT_EXCLUDED_TENANT_IDS = [MANAGEMENT_TENANT_ID, DEFAULT_TENANT_ID];
#   が既にある = HEAD コメントの意図は実装済 = コメントは「歴史的 context」として残せばよい
```

確認後の判断:
- **意図が定数で実現済** → main の refactor を採用しつつ、HEAD コメントを **「<日付> (HEAD 履歴): ...」** の体裁で documentation comment として残す
- **意図が未実装** → refactor を採用 + 意図を改めて実装 (constant 更新 or filter 追加)

### 実例 (PR #337 merge resolution)

```ts
// Before (HEAD)
const monthStart = getCurrentMonthStartUtc(now);
const yearMonth = getPreviousYearMonth(now);

// リセット対象テナント (= まだリセットされていない、当月分の値を保持中) を取得
// 2026-05-11: Default テナント (= 運営者自身、請求対象外) も除外 — 過去 PR では
//   MANAGEMENT のみ除外していたが、Default 分の月次履歴が請求 CSV に混入していた。
const targets = await prisma.tenant.findMany({
  where: { id: { notIn: SNAPSHOT_EXCLUDED_TENANT_IDS }, deletedAt: null },
  /* ... */
});

// Before (main)
// PR-4 (2026-05-15): 各テナントの TZ ローカル月初を基準にする。
const allTenants = await prisma.tenant.findMany({
  where: { id: { notIn: SNAPSHOT_EXCLUDED_TENANT_IDS }, deletedAt: null },
  /* ... */
});
const targets = allTenants.filter((t) => {
  const tenantMonthStart = getTenantMonthStart(now, t.timezone);
  return t.lastResetAt == null || t.lastResetAt < tenantMonthStart;
});

// After (merge resolution)
// PR-4 (2026-05-15): 各テナントの TZ ローカル月初を基準にする。
//   従来は UTC 月初固定 (`getCurrentMonthStartUtc` / `getPreviousYearMonth`) だったが、
//   テナント TZ に依存する月初境界を per-tenant で計算する設計に切替。
// 2026-05-11 (HEAD 履歴): Default テナント (= 運営者自身、請求対象外) も除外。
//   過去 PR では MANAGEMENT のみ除外していたが、Default 分の月次履歴が請求 CSV に
//   混入していたため SNAPSHOT_EXCLUDED_TENANT_IDS に追加済 (line 60 参照)。
const allTenants = await prisma.tenant.findMany({
  where: { id: { notIn: SNAPSHOT_EXCLUDED_TENANT_IDS }, deletedAt: null },
  /* ... */
});
```

両方の意図 (TZ-aware refactor + Default 除外の歴史) を 1 つのブロックに統合し、`line 60 参照` で具体的実装の所在も明記した。

### 横展開チェック (service code conflict 時)

- [ ] 双方の編集が **異なる粒度** (refactor vs コメントのみ) か確認
- [ ] HEAD 側コメントの意図が **定数 / 設定 / 別関数で実装済** か `grep` で確認
- [ ] 実装済なら → refactor を採用 + コメントを「<日付> (HEAD 履歴): ...」体裁で残す
- [ ] 未実装なら → refactor を採用 + 意図を改めて実装 (定数追加 / filter 追加など)
- [ ] 関連テストを実行して挙動が壊れていないか確認 (今回は tenant-monthly-reset.service.test.ts 22/22 pass)

### 関連

- 修正例: PR #337 (2026-05-12) — feat/guide-page-restructure ↔ main の `tenant-monthly-reset.service.ts` 競合
- 関連 service: [src/services/tenant-monthly-reset.service.ts](../../src/services/tenant-monthly-reset.service.ts)
- 関連 test: [src/services/tenant-monthly-reset.service.test.ts](../../src/services/tenant-monthly-reset.service.test.ts)
- 関連 KDD: §5.X+30 (KDD ファイル末尾コンフリクト一般論)

---

## 5.X+34 merge 後の **conflict zone 外** に同 refactor 関数の旧シグネチャ呼び出しが残存する罠 ─ `grep` で全 call site を verify する (PR #337 / 2026-05-12)

### 罠の正体

PR #337 で `tenant-monthly-reset.service.ts` の conflict を §5.X+33 パターンで解消した直後、CI で 3 種類のエラーが連鎖発生:

1. **Lint/Test/Build**: `super-admin.service.test.ts` の 4 テストが `expected NaN to be 157286400` 等で fail (storage 計算が NaN)
2. **E2E**: TypeScript build が `super-admin.service.ts:554` で「Expected 1 arguments, but got 2」で fail
3. **Vercel**: 同 build 失敗で Deployment Failed

原因は **PR-3 (§5.X+27) で `computeStorageLimitBytes(llmPlan, addonPlan)` → `computeStorageLimitBytes(addonPlan)` にシグネチャ変更** されたが、HEAD (PR #337) は **`super-admin.service.ts` の 3 つの call site のうち 1 つだけが conflict zone 内** で、残り 2 つは conflict marker が付かなかったため自動 merge で旧シグネチャのまま残った:

```ts
// 同じファイル内に 3 つの call site が存在:
//   line 336: computeStorageLimitBytes(addonPlan)              ← main が直接編集 (1 引数化済)
//   line 403: computeStorageLimitBytes(addonPlan)              ← main が直接編集 (1 引数化済)
//   line 554: computeStorageLimitBytes(llmPlan, addonPlan)     ← HEAD だけが touch → conflict 対象外
//                                                                 → 旧 2 引数のまま残存 ❌
```

さらに **test の expectation も旧仕様** (`expect(r?.storageLimitBytes).toBe(150 * 1024 * 1024)` 等) で、main の新仕様 (LLM プラン非依存、Standard 20MB 共通) と矛盾していた。

### 採用したパターン

§5.X+33 解決直後に **必ず以下 3 つを実行**:

```bash
# 1. refactor 対象関数の全 call site を grep し、引数数 / 引数並びが新シグネチャに揃っているか確認
grep -nE "computeStorageLimitBytes" src/ -r
# → 1 つでも旧シグネチャ呼び出しが残っていたら修正

# 2. 関連テストファイルで旧 magic number / 旧定数値を grep
grep -nE "150 \* 1024 \* 1024|50 \* 1024 \* 1024|300 \* 1024 \* 1024" src/services/*.test.ts
# → 旧値の expectation があれば新仕様に更新

# 3. 念のため full type check + 全テストを通す
pnpm tsc --noEmit  # build 時の type error を先に検出
pnpm test          # test expectation の不一致を検出
```

**conflict marker は「同じ行を両方が編集した箇所」しか flag しない**。HEAD だけが触った場所 / main だけが触った場所は自動 merge で「両方の変更を残す」動作になる。refactor は基本的に main 側の一方向変更なので、HEAD の旧シグネチャ呼び出しはそのまま生き残る。

### 修正例 (PR #337)

```ts
// Before merge (HEAD line 554 — conflict zone 外 = marker 無し)
const llmPlan = isTenantPlanString(t.plan) ? t.plan : 'beginner';
const addonPlan = isStorageAddonPlanStr(t.storageAddonPlan) ? t.storageAddonPlan : 'standard';
const limitBytes = computeStorageLimitBytes(llmPlan, addonPlan);  // ❌ 旧 2 引数
                                            // ^^^^^^^^ TS error: Expected 1 arguments, but got 2

// After merge fix
// PR-3 (§5.X+27, 2026-05-15): computeStorageLimitBytes は LLM プランから切り離され
//   `addonPlan` (Standard 20MB + add-on extra) のみで計算する 1 引数シグネチャ。
//   旧 2 引数呼び出しが merge resolution で残存していたため修正 (PR #337 fix)。
const addonPlan = isStorageAddonPlanStr(t.storageAddonPlan) ? t.storageAddonPlan : 'standard';
const limitBytes = computeStorageLimitBytes(addonPlan);  // ✅ 新 1 引数
```

テスト側 (`super-admin.service.test.ts`) も同期して更新:

```ts
// Before
// Expert (150MB) + standard (0) = 150MB
expect(r?.storageLimitBytes).toBe(150 * 1024 * 1024);

// After
// PR-3 (§5.X+27, 2026-05-15): LLM プラン非依存。standard add-on = 20MB 共通ベース。
expect(r?.storageLimitBytes).toBe(20 * 1024 * 1024);
```

### 横展開チェック (long-lived PR を main にマージする時)

- [ ] **API シグネチャ変更を含む refactor が main 側にあるか** を `git log main..HEAD -- <file>` で確認
- [ ] あれば該当関数を `grep -nE "<funcName>"` で全 call site 列挙し、新シグネチャに揃ったか目視確認
- [ ] **テストの magic number / 旧定数値** も同 PR の `git diff main..HEAD` で旧仕様前提が無いか確認
- [ ] `pnpm tsc --noEmit` を merge 直後に必ず実行 (build error を CI 前に検出)
- [ ] `pnpm test <affected>.test.ts` で関連 test の旧 expectation が新仕様で通るか確認

### 関連

- 修正例: PR #337 (2026-05-12) — `feat/guide-page-restructure` ↔ main の `computeStorageLimitBytes` シグネチャ不一致
- 関連 service: [src/services/super-admin.service.ts](../../src/services/super-admin.service.ts), [src/services/tenant-storage.service.ts](../../src/services/tenant-storage.service.ts), [src/services/storage-guard.service.ts](../../src/services/storage-guard.service.ts)
- 関連 config: [src/config/storage-addon.ts](../../src/config/storage-addon.ts) (新シグネチャ定義)
- 関連 KDD: §5.X+27 (LLM プランから切り離し → 共通 20MB), §5.X+33 (refactor + コメント追加型 conflict)

---

## 5.X+35 multi-project Playwright で **同 spec が複数 project で並列実行** されると fixture が DB に同名行を量産する罠 ─ name に callSuffix を必ず付与、cleanup は FK 順を厳守、redirect-during-goto は `waitUntil: 'commit'` (PR #337 E2E fix / 2026-05-12)

### 罠の正体

PR #337 の E2E で `13-super-admin-dashboard.spec.ts` が 2 種類のエラーで連続 fail:

1. **chromium project / test 121**: `strict mode violation: getByText('E2E Tenant A e2e-...') resolved to 2 elements` — DB に **同じ name + 異なる UUID の tenant 行が 2 件存在**
2. **chromium-mobile project / test 233**: `page.goto: net::ERR_ABORTED at /admin/super` — server-side `redirect('/')` 中に navigation がアボート

両方の根本原因が **multi-project Playwright (chromium + chromium-mobile) で同一 spec を実行** する設計に起因。

#### 1 の機序: 同 spec の重複 fixture 投入

- `playwright.config.ts` の `workers: 2` 設定下、同一 spec を chromium / chromium-mobile **両 project** が実行
- worker process は project ごとに切り替わる可能性があり、**同一 worker process** で連続実行されると `RUN_ID` (= `e2e-${timestamp}-${pid}-${rand}`) が共有される
- fixture 内で `name` を `${runId}` だけで構成すると → 2 回 beforeAll 呼び出しで **同じ name の行が 2 つ insert** される (slug は `randomBytes(3)` で一意、UNIQUE 制約は slug にのみ存在)
- さらに **afterAll の cleanup が FK 違反で部分失敗** すると行が残留し、次の project run で重複が確定する

```ts
// アンチパターン (PR #337 修正前)
const slugA = `e2e-sa-${runId}-${suffix}-a`;        // slug は suffix 含む = UNIQUE OK
const tenantA = await pool.query(`INSERT ... `, [slugA, `E2E Tenant A ${runId}`]);
//                                                       ^^^^^^^^^^^^^^^^^^^^^^^^^
//                                                       name は runId のみ = 重複可能
```

```ts
// 正しいパターン
const slugA = `e2e-sa-${runId}-${suffix}-a`;
const nameA = `E2E Tenant A ${runId}-${suffix}`;    // name にも suffix 付与
```

#### 2 の機序: redirect-during-goto アボート

`/admin/super` の server-side layout で `redirect('/')` が発火すると、`page.goto()` 中に navigation が断ち切られて `net::ERR_ABORTED` を throw する Chromium 実装がある (特に mobile viewport)。`waitUntil: 'load'` (デフォルト) は完全な response 受領を要求するため fail する。

```ts
// 正しいパターン
try {
  await adminPage.goto('/admin/super', { waitUntil: 'commit' });
  // 'commit' = 最初のレスポンスヘッダ受領まで待つだけで、その後の server redirect は許容
} catch (e) {
  // 念のため ERR_ABORTED 例外は飲み込む (final URL 検証で本質を担保)
  if (!(e instanceof Error && e.message.includes('ERR_ABORTED'))) throw e;
}
await adminPage.waitForURL((url) => !url.pathname.startsWith('/admin/super'), { timeout: 10_000 });
```

#### cleanup 順序 (FK 違反防止)

E2E で admin が一度でも login すると `auth_event_logs` が tenant_id 付きで insert される。これが残ったまま `DELETE FROM tenants` を発火すると FK 違反で blocking → tenants 残留。

```ts
// 正しい cleanup 順序
// 1. tenants を参照する FK 子テーブルを先に DELETE
//    (auth_event_logs / audit_logs / system_error_logs / api_call_logs /
//     role_change_logs / sessions / tokens など)
// 2. users (= tenant_id 持ち)
// 3. tenants
// 各 step は独立クエリ + try/catch で 1 つ失敗しても残りを継続 (transaction 不可、§5.X+30 教訓 7 参照)
```

### 採用したパターン (PR #337 fix)

1. **fixture の name にも suffix を付与** — `E2E Tenant A ${runId}-${suffix}` 形式で同 RUN_ID 複数 call でも重複しない
2. **cleanup の FK 子テーブル先行 DELETE** — `auth_event_logs` 等を 10 種類列挙してから tenants 削除
3. **redirect-during-goto を `waitUntil: 'commit'` + ERR_ABORTED 例外スワロー** で許容
4. **multi-project 並列実行が不要な spec は `testIgnore` で chromium-mobile から除外** — 構造的に重複実行自体を回避

```ts
// playwright.config.ts
projects: [
  { name: 'chromium', ... },
  {
    name: 'chromium-mobile',
    testIgnore: [
      // 共有 DB に fixture 書き込む spec は project 単位で重複させない
      /11-tenant-isolation\.spec\.ts/,
      /12-suggestion-seed-data\.spec\.ts/,
      /13-super-admin-dashboard\.spec\.ts/,
    ],
  },
],
```

### 横展開チェック (新規 E2E spec / fixture を追加する時)

- [ ] **fixture が共有 DB に書き込む** か (= tenants / users / 業務 entity を INSERT する)
- [ ] そうなら **name 系カラムにも `randomBytes(N)` の suffix を付与** したか (slug の UNIQUE だけでは不十分)
- [ ] cleanup で **tenants / users の FK 子テーブル** を grep し、全て先行 DELETE しているか
- [ ] cleanup は **transaction を使わず独立クエリ** で実行 (§5.X+30 教訓 7)
- [ ] spec が **複数 project (chromium / chromium-mobile) で実行する必要があるか** 判定し、不要なら `testIgnore` で chromium-mobile から外す
- [ ] server-side `redirect()` を経由する navigation は `waitUntil: 'commit'` + ERR_ABORTED swallow パターンを採用

### 関連

- 修正例: PR #337 (2026-05-12) — feat/guide-page-restructure
- 関連 fixture: [e2e/fixtures/super-admin.ts](../../e2e/fixtures/super-admin.ts) (name suffix + 拡張 cleanup)
- 関連 spec: [e2e/specs/13-super-admin-dashboard.spec.ts](../../e2e/specs/13-super-admin-dashboard.spec.ts) (redirect goto 修正)
- 関連 config: [playwright.config.ts](../../playwright.config.ts) (chromium-mobile testIgnore)
- 過去関連 KDD: §5.X+30 (cleanup transaction 不使用), `e2e/fixtures/multi-tenant.ts` の callSuffix パターン (先行事例)

---

## 5.X+36 infrastructure PR と feature PR が同一 route ファイルを別観点で修正していて衝突する ─ **両方の副作用を順序連鎖** (Pre-check → service 呼出 → try/catch) させて解消 (PR #339 / 2026-05-12)

### 罠の正体

PR #339 (`fix/memo-edit-long-link-overflow`) は memo 編集ダイアログの長 URL 表示崩れ修正で、副次的に **`/api/memos/[id]` PATCH route で `PUBLIC_REQUIRES_TITLE` のサービス例外を 400 へ変換する try/catch** を追加していた。

ところがその間に PR-5 (#333) が main にマージされ、**同一の `/api/memos/[id]` PATCH route に `requireStorageQuotaForWrite` Pre-check が挿入** された結果、main 取り込み時に **`updateMemo()` 呼出 line を含むハンクで content conflict** が発生。

```ts
// HEAD (PR #339): try/catch wrap
let updated;
try {
  updated = await updateMemo(...);
} catch (e) {
  if (e.message === 'PUBLIC_REQUIRES_TITLE') return NextResponse.json(..., { status: 400 });
  throw e;
}

// main (PR-5): Pre-check 挿入
const quotaErr = await requireStorageQuotaForWrite(...);
if (quotaErr) return quotaErr;
const updated = await updateMemo(...);
```

両側とも **service 呼出 line を取り合っている** が、**意味的には独立** (storage quota / value validation)。

### 教訓 (副作用の順序設計)

API route のミドルウェア風レイヤは、慣習的に以下の順序で並べる:

1. **認証 / 認可** (`getAuthenticatedUser` / `checkProjectPermission`)
2. **入力バリデーション** (`schema.safeParse`)
3. **クォータ / プラン制限 Pre-check** (`requireStorageQuotaForWrite` / `withMeteredLLM`) ← **fail-fast で service 呼出を回避**
4. **service 呼出** (try/catch でビジネス例外 → HTTP error code 変換)
5. **副作用ログ** (`recordAuditLog` 等)

→ Pre-check を service 呼出より **前** に置くことで「無駄な service 実行 + 後始末」を避ける設計。conflict が発生したら、この順序原則に従って**両側の改修を順序連鎖**させればよい。

### 修正パターン (本 PR で適用)

```ts
// PR-5 Pre-check (write 前に拒否し service 呼出を回避)
const quotaErr = await requireStorageQuotaForWrite(user.tenantId, JSON.stringify(parsed.data).length);
if (quotaErr) return quotaErr;

// PR #339 service 例外ハンドル
let updated;
try {
  updated = await updateMemo(id, parsed.data, user.id, user.tenantId);
} catch (e) {
  if (e instanceof Error && e.message === 'PUBLIC_REQUIRES_TITLE') {
    return NextResponse.json({ error: { code: 'PUBLIC_REQUIRES_TITLE', message: '...' } }, { status: 400 });
  }
  throw e;
}
```

### 横展開で漏らしやすい箇所

- [ ] **「片方を捨てて勝者を採用」しないこと**: conflict が同 line 上にあると `--theirs` / `--ours` で安易に解決しがちだが、両方が**異なる目的の正当な改修**であれば両方残す
- [ ] **既存の Pre-check helper を import 漏れさせない**: 本 PR でも `requireStorageQuotaForWrite` の import 文は main 側で既に追加済 (`@/lib/api-helpers` から re-export) のため、再度 import 文を書き直す必要は無かった。**import 文も conflict ハンクに含まれている場合は片方を採用**
- [ ] **副作用順序: Pre-check → service → audit log**: 順序を入れ替えると「拒否なのに audit ログが残る」「先に書き込んだ後で quota 超過判明」等の副作用順序バグを生む

### 関連

- 修正 PR: PR #339 (2026-05-12 / fix/memo-edit-long-link-overflow)
- infrastructure PR: PR-5 (#333) — `requireStorageQuotaForWrite` の CRUD 全 write route 横展開
- 関連 helper: [src/lib/api-helpers.ts](../../src/lib/api-helpers.ts) (`requireStorageQuotaForWrite`)
- 過去関連 KDD: §5.X+17 (同一ファイル並行更新の merge conflict 対策), §5.X+29 (Pre-check の API route 層集約方針)

---

## 5.X+37 test ファイルの末尾 describe ブロック衝突は **describe の閉じ括弧** が conflict marker と一緒に「マーカー外」に押し出される ─ 解消時は両側 describe を独立に閉じる必要がある (PR #341 / 2026-05-12)

### 罠の正体

`super-admin.service.test.ts` で HEAD と main が **末尾に独立した describe ブロックを並行追加** していて衝突。git の auto-merge アルゴリズムは:

1. 両側がファイル末尾に追記しているため、HEAD 側の追加内容と main 側の追加内容を `<<<<<<< / ======= / >>>>>>>` で挟む
2. ところが **HEAD 側 describe の閉じ括弧 (`});` `});`)** と **main 側 describe の閉じ括弧 (`});` `});`)** が**ファイル末尾の同じ位置**に「両側共通の closing 行」として残る → 一見すると HEAD describe が「閉じ忘れ」で main describe の冒頭に流れ込んでいるように見える

```ts
describe('HEAD test ブロック', () => {
  it('...', () => { /* HEAD body */
    expect(r.succeeded).toBe(1);
<<<<<<< HEAD                   // ← マーカー直前で「閉じ括弧前」
=======
// main 側の banner コメント + 新 describe ブロック群 (1400 行超)
//   describe(...) → it(...) → expect(...) で末尾は閉じ括弧手前
>>>>>>> origin/main
  });   // ← マーカー後の "共通の closing" だが、実は main 側 describe の閉じ括弧
});
```

主観的には HEAD describe が破損して見えるが、実際は **共通の closing 2 行 (`});` `});`) を片側にしか割り当てない** のが正解。

### 解消手順

1. **HEAD 側 describe を明示的に閉じる**: 「マーカー直前」(`=======` の前) に `});` `});` を挿入して HEAD describe を完結させる
2. **main 側 describe はそのまま採用**: 末尾の共通 `});` `});` がそのまま main describe の閉じ括弧として機能する
3. **両 describe の間に separator コメント** (`// ============`) を挟む

```ts
describe('HEAD test ブロック', () => {
  it('...', () => { /* HEAD body */
    expect(r.succeeded).toBe(1);
  });   // ← HEAD 用の追加閉じ括弧 (it 用)
});     // ← HEAD 用の追加閉じ括弧 (describe 用)

// ================================================================
// main 側の banner
// ================================================================

describe('main test ブロック', () => {
  // ...
});   // ← 共通の末尾閉じ括弧 (it 用)
});   // ← 共通の末尾閉じ括弧 (describe 用)
```

### 検証チェック

- [ ] `grep -nE "^<<<<<<<|^>>>>>>>|^=======$"` で marker 完全除去確認
- [ ] **describe ブロックごとに対応する `}` `}` がペアになっているか**: `grep -c "^describe(" file.ts` と `grep -cE "^\}\)\;" file.ts` を比較 (= top-level の数)
- [ ] **pnpm test で対象 spec が pass する**: brace 不整合があれば parser エラーで全 spec 失敗するので、ファイル単体 `pnpm test path/to.test.ts` を最初に実行

### 関連

- 修正 PR: PR #341 (2026-05-12 / feat/public-docs-account-setup)
- 関連 KDD: §5.X+17 (同一ファイル並行更新の merge conflict 対策), §5.X+36 (副作用順序連鎖型 conflict 解消)
- 公式 doc (git merge): <https://git-scm.com/docs/git-merge#_how_conflicts_are_presented>

---

## 5.X+38 サービス層で新しいラベル値 (enum-like literal) を増やしたら **型 union 側にも必ず追加** ─ `pnpm test` は通るが `pnpm build` (tsc) で初めて検出される (PR #341 / 2026-05-12)

### 罠の正体

PR #341 で Beginner プラン Day 180 自動物理削除に向けた 2 種類の事前通知メールを追加した:

```ts
// src/services/beginner-expiry.service.ts (l.425-434)
const mailType =
  type === 'day_60'                ? 'beginner_warning_60'
  : type === 'day_75'              ? 'beginner_warning_75'
  : type === 'auto_delete_day_150' ? 'beginner_auto_delete_warning_150'  // ★ 新規
  : type === 'auto_delete_day_170' ? 'beginner_auto_delete_warning_170'  // ★ 新規
  : 'beginner_expired';
await provider.send({ type: mailType, ... });
```

ところが受け手の型 (`MailParams.type`) は固定 union だったため tsc が NG:

```
Type '"beginner_auto_delete_warning_150" | ...' is not assignable to type
     '"invitation" | "password_reset" | "usage_alert" | "beginner_warning_60" |
      "beginner_warning_75" | "beginner_expired" | "unknown" | undefined'.
```

**`pnpm test` は通る** (vi.mock で受け側を mock し型を chechしない)、**`pnpm lint` も通る** (ESLint は型を見ない)、**`pnpm build` 内の Next.js TypeScript 型チェックで初めて検出**。

### 教訓

- **string literal union 型は「拡張ポイント」になりにくい**: サービス側で新規 literal を増やすたびに union 側も更新が必要。type-safe だが追加忘れのコストがある
- **mock を介する単体テストは型ガードにならない**: `vi.mock(() => ({ send: vi.fn() }))` は MailProvider の型を完全に置き換えるため、引数の型不整合は検出されない
- **「tsc / build は別物」原則を再確認**: §5.X+15 で「`pnpm tsc --noEmit` と `pnpm build` (Next.js TypeScript) は別物 — コミット前 build 実行が必須」と記録済。今回も `pnpm tsc` は **未走行** で push してしまっていた疑いあり

### 修正パターン

union を新値で拡張する:

```ts
// src/lib/mail/mail-provider.ts
type?:
  | 'invitation'
  | 'password_reset'
  | 'usage_alert'
  | 'beginner_warning_60'
  | 'beginner_warning_75'
  | 'beginner_expired'
  | 'beginner_auto_delete_warning_150'  // ★ 追加
  | 'beginner_auto_delete_warning_170'  // ★ 追加
  | 'unknown';
```

DB 側制約 (`email_send_logs.type` 列) は **`VarChar(40)` のみで CHECK / enum 制約無し** のため、コード union 追加だけで DB migration 不要。コード側でのみ legal value を管理する設計を維持。

### 横展開チェック (string literal union を増やす時)

- [ ] **コミット前に必ず `pnpm build` をローカル実行** (§5.X+15 のルール再確認)
- [ ] **新規 literal の文字数が DB の `VarChar(N)` を超えないか**確認 (例: `beginner_auto_delete_warning_150` = 33 chars < 40 chars OK)
- [ ] **DB 制約 (CHECK / enum / VarChar)** が存在する場合は migration も必要
- [ ] **使用箇所の grep**: `grep -rn "<新 literal>"` で送信側 (service) + 受信側 (provider 型) の両方を確認
- [ ] **型 union を `as const` 配列 + `typeof X[number]` に refactor する選択肢**: legal values を 1 箇所にまとめると追加忘れを防げる (= 拡張ポイント化)

```ts
// alternative refactor (本 PR では適用していないが将来検討)
export const MAIL_KINDS = [
  'invitation', 'password_reset', 'usage_alert',
  'beginner_warning_60', 'beginner_warning_75', 'beginner_expired',
  'beginner_auto_delete_warning_150', 'beginner_auto_delete_warning_170',
  'unknown',
] as const;
export type MailKind = (typeof MAIL_KINDS)[number];
// 配列を export しておけば runtime validation (zod 等) との二重定義も避けられる
```

### 関連

- 修正 PR: PR #341 (2026-05-12 / feat/public-docs-account-setup)
- 関連ファイル: [src/lib/mail/mail-provider.ts](../../src/lib/mail/mail-provider.ts) (union 定義), [src/services/beginner-expiry.service.ts](../../src/services/beginner-expiry.service.ts) (送信側)
- 関連 migration: [prisma/migrations/20260516_beginner_auto_delete_notices/](../../prisma/migrations/20260516_beginner_auto_delete_notices/) (送信日時列追加のみ、type 制約変更無し)
- 過去関連 KDD: §5.X+15 (tsc と build は別物、コミット前 build 実行必須)

---

## 5.X+39 セキュリティ強化 (rate limit / lockout / CAPTCHA) を追加するときは **E2E 並列実行が同一 IP で大量認証する** 性質と必ず衝突する ─ 環境変数で disable 経路を最初から用意する (PR #345 / 2026-05-13)

### 罠の正体

PR #345 (security/auth-secret-hardening) で credential stuffing 対策として
`middleware.ts` に login IP rate limit (`max=20 / 5min`) を追加した結果、
E2E (Playwright) が CI で **15 件中 14 件以上の spec が ログイン直後の `waitForURL('**/projects')`
で 15s timeout** という大量失敗を起こした。

連鎖:
1. E2E は CI で複数 worker (chromium / chromium-mobile 等) 並列実行
2. 各 spec の beforeEach / fixtures/auth.ts:loginAs() で都度 login
3. 同一 IP (localhost) から短時間に 60〜100 件の login POST が発生
4. 21 件目以降が 429 で弾かれ、NextAuth は認証失敗扱い、ブラウザは /login に留まる
5. spec 側は /projects への遷移を 15s 待って timeout

**症状の見え方が誤誘導する**: 一見「テストデータ不正」「Prisma migration 失敗」と思える
タイムアウトの大量発生だが、実態は middleware 層で 429 が出ているだけ。
Playwright report の screenshot で /login 画面が映ること、auth_event_logs に
login_failure が **記録されていない** (middleware で弾かれて authorize() に到達しない)
ことが切り分けポイント。

### 教訓 (一般化)

**security 観点で「本番で正しい防御」が「テストでは過剰防御」になる対立** は構造的に存在する。
以下の認証境界の追加は全て同じ罠を引き起こす:

- IP / アカウント単位の rate limit
- アカウントロック (失敗 N 回でロック)
- CSRF / CAPTCHA / human verification
- セッション固定攻撃対策 (ログイン直後の token rotation)
- bot 検知 (User-Agent / JA3 fingerprint)
- 短時間多発要求の検知 (Web Application Firewall)

E2E は本番ユーザの **数百倍の頻度** で認証経路を叩く。security PR で本番向けの
新しい防御を入れる時は、**最初から「テスト/負荷試験用の bypass 経路」を併設** する
習慣を付ける。

### 修正パターン (本 PR で適用)

##### 1. 環境変数で middleware の rate limit を disable する経路

```ts
// src/middleware.ts
const LOGIN_RATE_LIMIT_DISABLED = process.env.DISABLE_LOGIN_RATE_LIMIT === 'true';

export default auth((req) => {
  if (
    req.nextUrl.pathname === '/api/auth/callback/credentials'
    && req.method === 'POST'
    && !LOGIN_RATE_LIMIT_DISABLED  // ← bypass 経路
  ) {
    const limited = applyRateLimit(req, { key: 'login', max: 20, windowMs: 5 * 60 * 1000 });
    if (limited) return limited;
  }
});
```

##### 2. CI workflow にだけ env をセット (本番では未設定)

`.github/workflows/e2e.yml`:
```yaml
env:
  DISABLE_LOGIN_RATE_LIMIT: 'true'  # 本番 (Vercel) には絶対設定しない
```

##### 3. Playwright config の webServer.env に明示伝搬

```ts
// playwright.config.ts
webServer: {
  env: {
    // ... 他 env
    DISABLE_LOGIN_RATE_LIMIT: process.env.DISABLE_LOGIN_RATE_LIMIT || '',
  },
}
```

**忘れがち**: `webServer.env` は親 env を継承しないため、明示列挙が必要。
新規 env を増やしたら playwright.config.ts も同時更新するチェックリストを習慣化する。

### 横展開で漏らしやすい箇所

新しい security 防御を入れる時、以下を **同時に** 確認する:

- [ ] `src/middleware.ts` で防御するか? → bypass フラグを最初から付ける
- [ ] アカウント単位のロック (lockout) → spec 側で別 user を使うか、reset API を用意
- [ ] CSRF token → E2E でも取得経路をたどらせる (auto-form-submit ではない)
- [ ] CAPTCHA → CI 専用 secret で常に pass する mock を用意
- [ ] WAF / 短時間多発検知 → CI 専用に閾値を緩める or 完全 disable
- [ ] `.github/workflows/e2e.yml`, `e2e-visual-baseline.yml` 両方の env を更新
- [ ] `playwright.config.ts` の `webServer.env` も併せて更新
- [ ] 本番 env (Vercel project settings) に **絶対に設定しない** ことを workflow コメントで明示

### 検出のしかた (再発時の最短切り分け)

| 観察できる症状 | 真因の可能性 |
|---|---|
| 多数 spec の login 後 waitForURL が同時 timeout | rate limit / lockout / CAPTCHA |
| Playwright screenshot が /login 画面で停止 | login POST 後にリダイレクトされていない |
| auth_event_logs に login_failure が **無い** | middleware 層で弾かれて authorize() に到達せず |
| auth_event_logs に login_failure が **大量** | authorize() は呼ばれているが何らかの判定で reject |
| 単独 spec を `--workers=1` で流すと PASS | 並列性が原因 (rate limit / 同一 IP しきい値) |

### 関連

- 修正 PR: PR #345 (2026-05-13 / security/auth-secret-hardening) — B-2 (credential stuffing 対策) で罠を作り、追加コミットで bypass 経路を作って解消
- 関連 ファイル:
  - [src/middleware.ts](../../src/middleware.ts) — rate limit 適用と disable フラグ
  - [src/lib/rate-limit.ts](../../src/lib/rate-limit.ts) — in-memory Map ベースの実装 + Vercel 分散の限界 (§13-21)
  - [.github/workflows/e2e.yml](../../.github/workflows/e2e.yml) — `DISABLE_LOGIN_RATE_LIMIT: 'true'`
  - [.github/workflows/e2e-visual-baseline.yml](../../.github/workflows/e2e-visual-baseline.yml) — 同上
  - [playwright.config.ts](../../playwright.config.ts) — `webServer.env` で子プロセスに伝搬
- 関連 E2E_LESSONS: §4.54 (本罠の E2E 観点での詳細記述、本 KDD は一般化した教訓)
- 本 KDD は **「rate limit / lockout / CAPTCHA 全般」** に一般化。他の認証境界追加でも本パターンを参照する。

---

## 5.X+40 Playwright `waitForURL` の条件式は **終端到達** を表す形にする ─ 「中間状態」を表す negation は redirect chain 途中で抜けて race を起こす (PR #345 で確立)

### 罠の正体

PR #345 (security/auth-secret-hardening) で login rate limit を追加したところ、E2E spec の
beforeAll で `page.goto('/admin/super')` が `/projects` への navigation に interrupt される
race condition が顕在化した。原因は **`waitForURL` の条件式の書き方**:

```ts
// ❌ 中間状態 (= /login でない URL) で抜けるため race-prone
await page.waitForURL((url) => !url.pathname.includes('/login'), {
  timeout: 10_000,
});
```

login 後の redirect chain `/login → / → /projects` のうち、`/` 到達時点で条件式が true に
なり、wait が抜けてしまう。その後の test 本体の `page.goto('/admin/super')` と、まだ進行中の
`/` → `/projects` server redirect が競合し、Playwright が "interrupted by another
navigation" で fail する。

### 教訓 (一般化)

**`waitForURL` の条件式は「終端」を表す形にする**。

| パターン | 評価 | 理由 |
|---|---|---|
| `await page.waitForURL((url) => !url.pathname.includes('/login'))` | ❌ race-prone | 「`/login` でない URL」は redirect 途中の `/` でも true |
| `await page.waitForURL(/\/login/, { state: 'no-match' })` | ❌ 同上 | 同様に negation 系は中間状態でマッチする |
| `await page.waitForURL('**/projects')` | ✅ 安定 | 終端 URL を glob で明示 |
| `await page.waitForURL((url) => url.pathname === '/projects')` | ✅ 安定 | 終端 URL を厳密一致 |
| `await page.waitForURL('**/projects'); await page.waitForLoadState('networkidle');` | ✅✅ 最強 | URL + load chain 完了 |

### この罠が顕在化する状況

- アプリ側の redirect chain が 2 段以上 (e.g., `/login` → `/` → `/projects`)
- spec の `beforeAll` で login し、test 本体で別ページに `goto` する
- アプリの応答タイミングが変わる変更 (rate limit / middleware 追加 / API 遅延等) で
  「たまたま間に合っていた」race が顕在化

### 修正パターン

##### 1. 共通ヘルパーを 1 箇所に集約

```ts
// e2e/fixtures/auth.ts
export async function waitForProjectsReady(page: Page): Promise<void> {
  await page.waitForURL('**/projects', { timeout: 15_000 });
  await page.waitForLoadState('networkidle');
}
```

##### 2. spec 側は共通ヘルパーだけを呼ぶ (独自実装しない)

```ts
import { waitForProjectsReady } from '../fixtures/auth';

test.beforeAll(async ({ browser }) => {
  // ... login UI 操作 ...
  await page.getByRole('button', { name: 'ログイン' }).click();
  await waitForProjectsReady(page);  // ← 終端到達 + networkidle 保証
});
```

### 横展開で漏らしやすい箇所

- [ ] `e2e/specs/*.spec.ts` の各 `beforeAll` / `beforeEach` の login 後 wait
- [ ] custom fixture (e.g., `fixtures/multi-tenant.ts`, `fixtures/super-admin.ts`) 内の login
- [ ] retry / re-login パスでの wait
- [ ] 新規 spec を書くときは **共通ヘルパー強制使用** をレビューで指摘する

### 検出のしかた

| 症状 | 切り分け |
|---|---|
| `Navigation to "X" is interrupted by another navigation to "Y"` | redirect chain との race。終端 wait に書き換える |
| 同 spec の一部 test だけ flaky に fail | 共通 beforeAll の wait が早すぎる |
| `--workers=1` で PASS、並列で fail | CPU 競合で redirect 遅延 → race 顕在化 |
| main で PASS、PR ブランチで fail | PR の変更で response time が変わって race 顕在化 (= 本罠の典型) |

### 関連

- 修正 PR: PR #345 (2026-05-13 / security/auth-secret-hardening) — B-2 の rate limit 追加で race が顕在化、本 PR で全 spec を `waitForProjectsReady` に統一
- 関連 ファイル:
  - [e2e/fixtures/auth.ts](../../e2e/fixtures/auth.ts) — `waitForProjectsReady` 正規実装
  - 修正対象 spec: 11-tenant-isolation / 12-suggestion-seed-data / 13-super-admin-dashboard
- 関連 E2E_LESSONS: §4.55 (本罠の E2E 観点での具体記述)

---

## 5.X+41 `.gitignore` された Prisma `generated/` ディレクトリは ブランチ切替で同期されず、別ブランチの生成物が現ブランチに混入する罠 (PR #348 で遭遇)

### 罠の正体

PR #348 (security/data-export-pii-ci-guard) を main にリベース merge して CI ガードテストを
動かしたところ、以下のエラーで fail:

```
AssertionError: 新 User フィールドが追加されたが分類されていない。
USER_EXPORT_FIELDS または USER_PII_FIELDS に追加してください:
expected [ 'tokenVersion' ] to deeply equal []
```

しかし `prisma/schema.prisma` に `tokenVersion` は **存在しない** (User モデルに無い)。
それなのに `Prisma.UserScalarFieldEnum` には `tokenVersion` が含まれていた。

根本原因:

1. `prisma/schema.prisma` の generator 設定: `output = "../src/generated/prisma"`
2. `.gitignore` に `/src/generated/prisma` (= 生成ディレクトリ全体を ignore)
3. 別の PR ブランチ (PR #350 `security/jwt-invalidation`) で `User.tokenVersion` を schema に追加し、
   `npx prisma generate` を実行 → `src/generated/prisma/internal/prismaNamespace.ts` に
   `tokenVersion: 'tokenVersion'` が書き込まれた
4. その後、別のブランチ (PR #348 `security/data-export-pii-ci-guard`) に `git checkout`
   → schema.prisma は元に戻る (PR #350 の変更は別ブランチ) が、`src/generated/` は
   **gitignored なので git の管理対象外** → ファイルシステム上に **PR #350 ブランチの
   生成物がそのまま残る**
5. PR #348 のテストが Prisma.UserScalarFieldEnum を真実とするため、現ブランチの schema と
   矛盾する `tokenVersion` を検出して fail

### 教訓 (一般化)

**`.gitignore` されたファイルは「ブランチに属していない」 = ブランチ切替で同期されない**。
特に以下のディレクトリで起こりやすい:

- `src/generated/prisma` (Prisma client output)
- `.next/` (Next.js ビルド成果物)
- `node_modules/` (依存パッケージ)
- `dist/` / `build/` (一般的なビルド成果物)

これらが **schema 変更を含むブランチで生成され、その後別ブランチに切り替えた時** に古い
生成物が残り、現ブランチの schema と矛盾する。テストが generated を真実とする場合 (本ケース)
や、開発サーバが古い generated を読む場合に **デバッグ困難な不整合エラー** が発生する。

### 修正パターン

##### 1. ブランチ切替後の儀式: schema 関連変更がある場合は `prisma generate` を再実行

```bash
git checkout <new-branch>
npx prisma generate           # ← schema と generated を一致させる
pnpm install --frozen-lockfile  # ← package.json 変更時 (lockfile 不整合防止)
```

##### 2. 自動化: package.json の `postcheckout` フック (任意)

```json
// package.json (検討中、強制はしていない)
"scripts": {
  "postinstall": "prisma generate"
}
```

`postinstall` は `pnpm install` 時に走るため、ブランチ切替で `lockfile` が変わるなら
自動的に generate も走る。ただし lockfile が同じだと走らないため、明示的 `prisma generate`
が確実。

##### 3. CI では問題にならない (ephemeral environment)

CI は毎回新しいランナーで `pnpm install` + `prisma generate` を行うため、本罠は **ローカル開発・
PR merge 解決時に限定** される。ただしローカルで merge → push した PR が CI で初めて
fail に気付くケースがある (本 PR がまさにそれ)。

### 検出のしかた

| 症状 | 真因の可能性 |
|---|---|
| `Prisma.XxxScalarFieldEnum` に schema に無い列が含まれる | 別ブランチの generate 残骸 |
| TypeScript で `prisma.user.xxx` が schema に無い列を補完する | 同上 |
| `prisma migrate dev` で「migration drift」エラー | schema と DB が乖離、generated とも乖離 |
| ブランチ切替後に CI でだけ fail (ローカルで PASS) | ローカル generated が「進んだ」状態のまま、CI は schema 基準で生成 |

### 横展開で漏らしやすい箇所

- [ ] Prisma schema を変更する PR は **PR description に「他ブランチでは `prisma generate` を再実行」** を明記
- [ ] CI で `prisma generate` を **install 直後に必ず実行** (本リポジトリは `e2e.yml:100` で実施済)
- [ ] generated を真実とするテストを書くときは、schema との不整合に気付ける明確な assertion メッセージを書く (本ケースの「USER_EXPORT_FIELDS または USER_PII_FIELDS に追加してください」)
- [ ] generated ファイルは **PR の差分に出ないこと** を確認 (差分に出ると gitignore 設定漏れ)

### 関連

- 修正 PR: PR #348 (2026-05-13 / security/data-export-pii-ci-guard) — main を merge した時に発覚
- 関連 ファイル:
  - [.gitignore](../../.gitignore) (L59: `/src/generated/prisma`)
  - [prisma/schema.prisma](../../prisma/schema.prisma) (generator output 設定)
  - [src/services/data-export.service.test.ts](../../src/services/data-export.service.test.ts) — `Prisma.UserScalarFieldEnum` を真実とするテスト
- 派生学び: 同一 test ファイル末尾に新規 describe を追加する複数 PR は merge conflict を起こす (PR #346 csvEscape + PR #348 USER_EXPORT_FIELDS が同 ファイル末尾で衝突)。**解決パターン**: 両方の describe を時系列順に並べて保持 (両方とも独立した責務なので除去・統合は不要)。

---

## 5.X+42 単一 middleware に複数の security 関心 (rate limit / CSP nonce / etc) を統合する時、各関心の **責務分離** + **return タイミング** で衝突を避ける (PR #345 ⨯ PR #349 で確立)

### 罠の正体

PR #349 (security/csp-nonce) のブランチを main に rebase merge する際、`src/middleware.ts` が
**全面書き換え** の形で衝突した。具体的には:

- main 側 (PR #345 マージ済): `/api/auth/callback/credentials` POST に IP rate limit (B-2)
- HEAD 側 (PR #349): 全リクエストで CSP nonce 生成 + response header 設定 (L-5)

両者は **`auth((req) => { ... })` callback 全体を上書き** する形で書かれており、git の
3-way merge では自動結合できない (function body が完全に異なるため)。

さらに、両者を素直に「`if (rate limit) { ... } if (CSP) { ... }`」と並べると **論理が複雑化** し、
以下のような潜在バグを生む可能性:

- login POST に対して CSP nonce を生成して response に付ける (= 不要、レスポンス body が無い)
- CSP nonce 生成失敗時に rate limit を素通りさせる (= 不正な制御フロー)
- `auth callback` で `NextResponse.next` を return すると **NextAuth の authorized callback が
  skip される** 可能性 (= 認可境界の事故)

### 教訓 (一般化)

**single middleware に複数の security 関心を統合する時の設計原則**:

1. **責務分離**: 各関心は **対象パスと method** で明確に分ける
2. **早期 return**: 「自分の関心に該当するリクエスト」は処理して return、それ以外は次の関心へ
3. **NextAuth 委譲のタイミング**: 「security チェックを通過した後の通常処理」は
   `return;` (undefined) で NextAuth の authorized callback に委譲する
4. **CSP nonce は最後のフォールバック**: 全 GET リクエストに必要なため、専用処理を持たない
   path で実行する
5. **コメントで分岐意図を明示**: 各 `if` ブロックの前に「何の処理で / なぜここで分岐するか」
   を必ず書く (将来の merge conflict 解消時にも復元しやすい)

### 修正パターン (本 PR で確立)

```ts
export default auth((req: NextRequest) => {
  // 1. 特定エンドポイントの security チェック (early return)
  if (
    req.nextUrl.pathname === '/api/auth/callback/credentials'
    && req.method === 'POST'
    && !LOGIN_RATE_LIMIT_DISABLED
  ) {
    const limited = applyRateLimit(req, { key: 'login', max: 20, windowMs: 5 * 60 * 1000 });
    if (limited) return limited;  // ← rate limit 引っかかったら 429 を返す
    return;  // ← 通過時は NextAuth に委譲 (CSP nonce 不要)
  }

  // 2. 全リクエスト共通の処理 (CSP nonce)
  const nonce = generateNonce();
  // ... CSP header 構築 ...
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  return response;
});
```

**重要な設計判断**:

- **`return;` (undefined) と `return response` の使い分け**:
  - `return;` → NextAuth の authorized callback が呼ばれ、認可結果で redirect / next を決定
  - `return response` → middleware で完結 (authorized callback は呼ばれない可能性、要検証)
- **rate limit 引っかかり時は `return limited`**: 429 NextResponse を返して即終了
- **rate limit 通過時の login POST は `return;`**: NextAuth に委譲して通常の認証フローへ

### 横展開で漏らしやすい箇所

- [ ] middleware に新規 security 機能を追加する時、**既存の処理経路と干渉しないか** を確認
- [ ] 各 `if` 分岐の **return タイミング** を明示 (early return / pass-through / response 返却)
- [ ] **NextResponse.next を不必要に返さない** (authorized callback skip リスク)
- [ ] 同じ middleware を **複数 PR で同時に変更しない** か、する場合は事前に conflict 解消方針をすり合わせる
- [ ] middleware の挙動は **E2E でしか正確に検証できない** (unit test では NextAuth wrapper を完全に再現困難) → PR ごとに E2E 完走を必須化

### 検出のしかた (再発時)

| 症状 | 真因の可能性 |
|---|---|
| login POST が常に 429 で失敗 | rate limit ロジック誤り (window/max/key の設定) |
| 認証なしで保護ページにアクセス可能 | `NextResponse.next` の return で authorized callback skip |
| CSP nonce が response に付与されない | early return の条件が広すぎて CSP 処理に到達せず |
| nonce が seed ごとに変わって Next.js の SSR で mismatch エラー | nonce 生成が SSR と middleware で重複実行 (本実装では middleware のみで生成 → OK) |

### 関連

- 修正 PR: PR #349 (2026-05-13 / security/csp-nonce) — main の PR #345 (rate limit) と conflict を解消
- 関連 ファイル:
  - [src/middleware.ts](../../src/middleware.ts) — 統合実装 (rate limit + CSP nonce)
  - [src/lib/rate-limit.ts](../../src/lib/rate-limit.ts) — rate limit ライブラリ
  - [next.config.ts](../../next.config.ts) — middleware に移譲後の static security header
- 関連 KDD: §5.X+39 (security 強化が E2E を壊す対立、本 KDD と同じく middleware に新規制限を入れた時の罠)
- 関連 E2E_LESSONS: §4.54 (rate limit が E2E 並列 worker を 429 で全滅させる罠)

---

## 5.X+43 Next.js 16 の CSP nonce 自動付与は production で完全動作せず、`strict-dynamic` を使うと hydration が全壊する ─ graceful degradation で nonce + `unsafe-inline` 併存にする (PR #349 で確立)

### 罠の正体

PR #349 (security/csp-nonce) で xss-reviewer agent の指摘 (XSS 二次防御強化) に従い、
middleware からリクエストごとに nonce を生成して以下のような厳格 CSP を設定した:

```ts
// production (NODE_ENV=production)
script-src 'self' 'nonce-${nonce}' 'strict-dynamic'
```

公式 Next.js docs に従って:
1. middleware で `x-nonce` request header と `Content-Security-Policy` request header に nonce を設定
2. Next.js 16 が自動で `<script nonce={X}>` を SSR で付与する想定

しかし E2E production CI で「Step 4: 一般ユーザが招待メールからパスワードを設定する」
spec が以下の症状で失敗:

- screenshot: 「**確認中...**」が表示されたまま停止 (SSR 結果は出ている)
- expect: `getByText('たすきば', { exact: true })` が 10s timeout で見つからない
- = SSR は完了したが、**React hydration が走らず、client-side useEffect が起動しない**

#### 何が起きていたか (CSP 仕様の罠)

`strict-dynamic` ディレクティブは:
- `nonce-X` または `hash-XX` が指定された script は信頼し、その script が **動的に追加した**
  script (= `document.createElement('script')` で append された Next.js chunks) も連鎖的に信頼
- ただし **`'self'` と `'unsafe-inline'` を CSP 仕様で完全無効化** する (`strict-dynamic` 仕様
  の意図的な挙動)

Next.js 16 の nonce 自動付与は **SSR 時に生成する inline RSC payload** (`<script>(self.__next_f=...).push([...])</script>`)
に nonce を付与すべきだが、本サービス環境では **付与に失敗していた** (機構の不安定さ、
構築フローとの相互作用、または middleware → render 間での header 伝搬の rate condition)。

結果:
1. inline RSC payload に nonce が付与されない
2. `strict-dynamic` のため `'self'` も `'unsafe-inline'` も無効
3. CSP が **全 inline script を拒否**
4. React の hydration bootstrap が動かない
5. useEffect が走らず、初期 state「確認中...」のまま停止

### 教訓 (一般化)

**`strict-dynamic` は「nonce 自動付与が 100% 機能する」前提でしか使えない**。
nonce 付与が失敗するケース (Next.js 16 / アプリ構成 / 構築フロー由来) では:

- 完全な信頼チェーン破綻 → hydration 全停止
- 古い browser は `strict-dynamic` を無視するが、modern browser は厳格適用 → どちらでも壊れる
- 修正できないと **画面が真っ白** という最悪 UX を本番ユーザに見せる

### 修正パターン (本 PR で確立)

**Graceful degradation**: `strict-dynamic` を外し、`nonce-X` と `unsafe-inline` を併存:

```ts
// before (壊れる)
script-src 'self' 'nonce-${nonce}' 'strict-dynamic'

// after (graceful)
script-src 'self' 'nonce-${nonce}' 'unsafe-inline'
```

CSP 仕様の挙動:
- **modern browser + nonce 付与成功**: nonce based で評価 (= 強い防御、`unsafe-inline` は無視)
- **modern browser + nonce 付与失敗 (本サービス症状)**: `unsafe-inline` で fallback (= pre-PR と同じ)
- **古い browser**: `unsafe-inline` で動作 (= pre-PR と同じ)

xss-reviewer 元評価でも「XSS 一次防御 (危険 API 使用ゼロ、`block-dangerous-edit.sh` hook で
予防) が強固なので CSP `unsafe-inline` は二次防御として実害なし」と明示。
**「壊さない最強の防御」** を選ぶのが正しい。

### 一般化教訓 (security 強化を入れる時の鉄則)

1. **「動作する CSP < 壊さない CSP」**: 厳格すぎる CSP は production で hydration 全壊を起こす。
   理想は graceful degradation で、機能すれば追加防御、機能しなくても破壊しない。
2. **`strict-dynamic` は最後の砦**: 「nonce が 100% 機能する」確証が無い限り使わない。
   特に Next.js のような複雑な SSR/RSC フレームワークでは慎重に。
3. **CSP は production build で必ず手動 + E2E 検証**: dev mode は HMR で常に `unsafe-` 系を
   通すため検出できない。本症状は **CI E2E で初めて顕在化** した。
4. **画面が真っ白** という最悪 UX は信用を一気に失う。security 強化が UX を破壊する逆転現象を
   防ぐため、「security PR は production build で E2E 完走」を必須化する。

### 検出のしかた

| 症状 | 真因の可能性 |
|---|---|
| production build で SSR 結果は出るが hydration が走らない | CSP で inline script (RSC payload) が拒否されている |
| dev mode では PASS、production build で fail | dev は HMR で `unsafe-` 系が常に許可されるため CSP の影響を受けない |
| screenshot が「読み込み中」「確認中」など初期 state のまま停止 | client-side JS の bootstrap 失敗 (CSP 違反の典型) |
| ブラウザ DevTools Console に `Refused to execute inline script` | CSP 違反の確定診断 |

### 横展開で漏らしやすい箇所

- [ ] CSP に新規ディレクティブ (`strict-dynamic` / `require-trusted-types-for` 等) を追加する時、
      **production build + 全主要画面の E2E** で動作確認
- [ ] `unsafe-inline` を排除する時は **nonce 付与が完全動作する確証** を E2E で取る
- [ ] middleware で CSP を動的生成する時、**`x-nonce` header の伝搬経路** が SSR で正しく
      参照されるかを確認 (header name の case / Next.js バージョン依存)
- [ ] graceful degradation を選ぶときは「機能しない時に破壊しない」かを `unsafe-inline` 系で確認
- [ ] **dev / production の CSP 設定差分を最小化** (production 専用設定の検証コストが高いため)

### 関連

- 修正 PR: PR #349 (2026-05-13 / security/csp-nonce) — strict-dynamic を導入してから graceful degradation に切替
- 関連 ファイル:
  - [src/middleware.ts](../../src/middleware.ts) — CSP 生成ロジック
  - [next.config.ts](../../next.config.ts) — middleware に移譲後の static security header
- 関連 KDD: §5.X+39 (security 強化が E2E を壊す対立) / §5.X+42 (単一 middleware に複数 security 統合)
- 関連 E2E_LESSONS: §4.54 (rate limit が E2E を壊す類話) / §4.55 (security PR の応答タイミング変化で race が顕在化)
- 関連 公式 docs: [Next.js CSP guide](https://nextjs.org/docs/app/guides/content-security-policy) — 本ガイドどおりに実装しても production で安定動作しない場合がある。 graceful degradation で受け止める。

---

## 5.X+44 「graceful degradation」が CSP 仕様の罠で機能しない時は 2 段階修正で粘らずに **完全 rollback** する勇気を持つ (PR #349 follow-up で確立)

### 罠の正体

§5.X+43 で「`strict-dynamic` を外し `nonce-X` + `unsafe-inline` 併存」を graceful degradation
として採用した。理屈上は「nonce 機能時は強い防御、機能失敗時は `unsafe-inline` で fallback」
の二段構えのはず。

しかし CI E2E で再度同じ症状 (画面「確認中...」のまま停止) が発生:

```
[chromium] › e2e/specs/01-admin-and-member-setup.spec.ts:218:7 ›
  Step 4: 一般ユーザが招待メールからパスワードを設定する
Error: getByText('たすきば', { exact: true }).first() — Expected: visible
       waiting for ... 10000ms — element(s) not found
```

#### 何が起きていたか (CSP 仕様の続きの罠)

CSP 仕様 (CSP Level 2 以降):
- **`script-src` に `'nonce-X'` が含まれる場合、modern browser は `'unsafe-inline'` を無視する**
- 仕様の意図: nonce ベースの厳格 CSP を有効化したら、`unsafe-inline` の fallback は許さない

つまり:
- `script-src 'self' 'nonce-${nonce}' 'unsafe-inline'`
- modern browser (Chromium / Firefox / Safari) はこれを **`script-src 'self' 'nonce-${nonce}'`** と解釈
- `'unsafe-inline'` は **存在しないかのように扱われる**
- nonce 付与失敗 = inline script 拒否 = hydration 全壊

つまり、§5.X+43 の「graceful degradation」は **CSP 仕様上そもそも graceful ではない** という
落とし穴があった。CSP Level 1 仕様時代の挙動 (`'unsafe-inline'` が fallback) を期待していたが、
modern browser は Level 2/3 を実装しているため無視される。

### 教訓 (一般化)

**1 段階目の修正で同じ症状が再発したら、追加修正で粘らずに完全 rollback を検討する**。

CSP / 認証 / hydration のような **仕様が複雑で挙動の予測が困難な領域** では:

1. 1 段階目の修正で改善しない時、**「もう一段階の修正」で直る確証は無い**
2. 「graceful degradation」を試したつもりが、仕様の罠で「graceful にならない」場合がある
3. 本番ユーザに「画面が真っ白」を見せるリスクと、PR の価値 (二次防御強化) を比較すると、
   後者が劣る場合は **prepare rollback の方が誠実**
4. 「壊さない最強の防御」< 「機能する pre-PR の防御」 という順序で安全側に倒す

### 修正パターン (本 PR で最終確定)

**完全 rollback**: middleware の CSP nonce 生成ロジックを **全削除**、`next.config.ts` の
static CSP (`'self' 'unsafe-inline'`) に戻す:

```ts
// src/middleware.ts (rollback 後)
export default auth((req) => {
  if (login POST) { rate limit check }
  // CSP nonce 生成は削除、middleware は login rate limit のみ
});

// next.config.ts (pre-PR #349 状態に復元)
const securityHeaders = [
  { key: 'Content-Security-Policy', value: "...script-src 'self' 'unsafe-inline'..." },
  // ...
];
```

PR #349 は **実質的に no-op になる** が、ナレッジドキュメント (§5.X+43 / §5.X+44) は
価値ある教訓として残す。CSP nonce 化は **post-MVP** に回し、Next.js のバージョン更新で
nonce 自動付与が安定するまで様子見する。

### 一般化: PR が機能しない時の判断フロー

```
[PR push 後 CI fail]
    ↓
1 段階目修正を試す
    ↓
[同症状で fail]
    ↓
仕様を再調査 → 別アプローチが現実的か?
    ├─ Yes: 2 段階目修正
    │      ↓
    │   [PASS] → そのまま
    │   [fail] → 同じ判断フローを繰り返し (3 回目失敗で必ず rollback)
    │
    └─ No: 完全 rollback して PR を no-op 化
           ナレッジドキュメントで価値を残す
           対象機能は post-MVP に回す
```

**重要**: 「3 回連続失敗で必ず rollback」というハードルールを設けると、無限に修正試行が
続くのを防げる。本サービスでは「security 強化」「test infrastructure」のような
仕様が複雑な領域でこのルールを適用する。

### 横展開で漏らしやすい箇所

- [ ] CSP nonce / strict-dynamic / require-trusted-types 等の **新規 CSP ディレクティブ追加** は
      production build + E2E で必ず検証
- [ ] 「graceful degradation」を採用する前に、**実際にどう degrade されるか** を CSP/HTTP/
      browser 仕様で確認 (本罠は仕様読み不足が原因)
- [ ] 1 段階目修正で改善しない時、「3 回ルール」で完全 rollback を強制
- [ ] rollback で機能を諦めるのは「失敗」ではなく「正しい判断」。**PR を close / 縮小しても OK**

### 関連

- 修正 PR: PR #349 (2026-05-13 / security/csp-nonce) — middleware CSP nonce ロジックを全削除、static CSP に rollback
- 関連 ファイル:
  - [src/middleware.ts](../../src/middleware.ts) — PR #345 の rate limit のみに rollback
  - [next.config.ts](../../next.config.ts) — pre-PR #349 の static CSP を復元
- 関連 KDD: §5.X+43 (本罠の前段、`strict-dynamic` で hydration 全壊)
- 関連 公式 docs: [CSP Level 3 仕様](https://www.w3.org/TR/CSP3/#allow-all-inline) — `'nonce-X'` 指定時の `'unsafe-inline'` 無視仕様

---

## 5.X+45 schema に User 列を追加した PR は **必ず `USER_PII_FIELDS` か `USER_EXPORT_FIELDS` の分類を更新する** ─ L-6 CI ガードが想定通り機能した例 (PR #350 で確認)

### 罠の正体 (= CI ガードが意図通り検出した好例)

PR #350 (security/jwt-invalidation) で User schema に `tokenVersion` 列を追加した。
PR #348 でマージ済みの L-6 CI ガード (`USER_EXPORT_FIELDS ∪ USER_PII_FIELDS ===
Prisma.UserScalarFieldEnum`) が以下で CI を fail させた:

```
FAIL src/services/data-export.service.test.ts
  > User export PII whitelist CI guard (L-6)
  > USER_EXPORT_FIELDS と USER_PII_FIELDS の和が UserScalarFieldEnum と完全一致する
AssertionError: 新 User フィールドが追加されたが分類されていない。
USER_EXPORT_FIELDS または USER_PII_FIELDS に追加してください:
expected [ 'tokenVersion' ] to deeply equal []
```

これは **L-6 CI ガードが想定通り動作した** ことを示す重要な好例。

PR #350 の `tokenVersion` は **JWT 失効カウンタ** で、顧客データ持ち出し export に
含めるべきではない (内部認証情報)。だが PR #350 作業時に `data-export.service.ts` の
`USER_PII_FIELDS` への追加を忘れていた。L-6 ガードがそれを **CI で必ず検出** することで、
意図せず PII が JSON 出力に混入する事故を **構造的に防いだ**。

### 教訓 (一般化)

**CI ガードは「fail することで価値を発揮する」**。今回の fail は:
- バグではなく **意図通りの検出**
- 修正は単純 (`USER_PII_FIELDS` に列名を 1 行追加)
- ガードがなければ schema 列追加と data-export 更新の漏れで PII 漏洩していた可能性

### 修正パターン

User schema に列を追加する PR では、以下を **必ず同時に実施**:

1. `prisma/schema.prisma` に列を追加
2. `prisma/migrations/` に migration を追加
3. **`src/services/data-export.service.ts` の `USER_EXPORT_FIELDS` か `USER_PII_FIELDS`
   に列名を追加** (どちらかは「顧客に export して良いか」で判定)
4. `npx prisma generate` で型を再生成
5. `pnpm test src/services/data-export.service.test.ts` で L-6 ガードが通ることを確認

### 分類の判定ガイド

新規 User 列が `USER_EXPORT_FIELDS` か `USER_PII_FIELDS` か:

| 列の性質 | 分類 |
|---|---|
| 顧客の所有情報 (氏名・メール・ロール・テーマ等) | EXPORT |
| 認証情報 (passwordHash / mfa secret / token) | PII |
| ロック / 失敗カウンタ等の運用ステート | PII |
| 内部フラグ (forcePasswordChange / tokenVersion 等) | PII |
| 論理削除 (deletedAt 等) | PII (= 削除済の事実は顧客向け出力に不要) |

迷う場合は **「顧客が export ZIP を受け取って役立つか」** で判断。
役立たないなら PII (内部運用情報) として扱う方が安全。

### 関連

- 修正 PR: PR #350 (2026-05-13 / security/jwt-invalidation) — `tokenVersion` を `USER_PII_FIELDS` に追加
- CI ガード元 PR: PR #348 (2026-05-13 / security/data-export-pii-ci-guard) — L-6 ガード自体の実装
- 関連 KDD: §5.X+41 (`.gitignore` された generated の罠、本 PR では prisma generate 再実行で関連)

---

## 5.X+46 JWT 失効カウンタを **自分の操作で increment すると同セッションが即死** ─ 自/他操作で分ける設計原則 (PR #350 で確立)

### 罠の正体

PR #350 (security/jwt-invalidation) で `User.tokenVersion` を導入し、認可境界の操作で
increment する設計を採用した:

```ts
// 当初の設計 (全パス共通で increment)
await prisma.user.update({
  data: {
    passwordHash: newHash,
    tokenVersion: { increment: 1 },  // ← 自分のパスワード変更でも increment
  },
});
```

しかし E2E spec 01 Step 2 が以下で fail した:
- Step 1: 招待メール経由で **自分のパスワード設定** (`changePassword` 系)
- Step 2: 設定画面で MFA を有効化しようとしたら、画面に **「再度ログインしてください」** が表示

screenshot: MFA カードに赤字で「再度ログインしてください」のエラー表示、その下のはずの
「手動入力用のシークレットキー」は不可視。

#### 何が起きていたか (同セッション即死シナリオ)

1. Step 1 のパスワード設定で `prisma.user.update` 実行 → DB.tokenVersion = 0 → 1
2. JWT には login 時の **古い tokenVersion (= 0)** がそのまま残っている
3. Step 2 で MFA setup API を呼ぶ
4. API route 入口 `getAuthenticatedUser` で `dbUser.tokenVersion (=1) !== session.user.tokenVersion (=0)` → **401 SESSION_INVALIDATED**
5. UI 側で「再度ログインしてください」表示、MFA setup は実行されず
6. spec の `page.getByText('手動入力用のシークレットキー')` が永久に見つからず timeout

つまり「自分のセッションを自分で殺す」というアンチパターン。本来 tokenVersion increment
の目的は **「他デバイスからの強制ログアウト」** だが、自分の同セッションも巻き添えで殺していた。

### 教訓 (一般化)

**JWT 失効カウンタは「自分の操作 vs 他人の操作」で挙動を厳密に分ける**:

| 操作 | 操作者 vs 対象 | tokenVersion increment | 理由 |
|---|---|---|---|
| `changePassword` (自分) | self → self | ❌ **しない** | 同セッション即死を防ぐ |
| `unlockAccount` (admin が他人を) | admin → other | ✅ する | 対象 user の旧 JWT を失効 |
| `updateUserStatus` / `updateUserRole` | admin → other | ✅ する | 権限変動を即時反映 |
| `deleteUser` | admin → other | ✅ する | 削除済 user の JWT 即失効 |
| 「全デバイスからログアウト」 (UI) | self → self | (将来) する + session.update で JWT 同期 | 別 UI を用意して同セッション維持 |

### 修正パターン (本 PR で確立)

```ts
// changePassword: increment しない (自分の同セッション維持)
await prisma.user.update({
  where: { id: userId },
  data: {
    passwordHash: newHash,
    forcePasswordChange: false,
    // tokenVersion: { increment: 1 } を**意図的に書かない**
  },
});

// admin 操作 (他人の session 失効): increment する
await prisma.user.update({
  where: { id: targetUserId },
  data: {
    systemRole: newRole,
    tokenVersion: { increment: 1 },  // ← 他人なので OK
  },
});
```

### 回帰テストで保護する

将来「やっぱり全デバイス強制ログアウトしたい」と PR で再度 increment が追加されるのを
防ぐため、明示的な回帰テストを書く:

```ts
it('回帰: 自分のパスワード変更では tokenVersion を increment しない', async () => {
  await changePassword('u1', 'current', 'brandnew');
  const updateCall = vi.mocked(prisma.user.update).mock.calls[0]?.[0];
  expect(updateCall?.data).not.toHaveProperty('tokenVersion');
});
```

### 他デバイスログアウトを実装したい場合の正攻法

ユーザが「他のデバイスからログアウトしたい」要件は別 UI で実装:

1. 設定画面に「全デバイスからログアウト」ボタンを追加
2. ボタン click で:
   ```ts
   // server: tokenVersion を increment
   await prisma.user.update({ where: { id }, data: { tokenVersion: { increment: 1 } } });
   // client: 自分の session も新 tokenVersion で更新
   await session.update({ tokenVersion: newVersion });
   ```
3. session.update で JWT を再発行 → 自分の同セッションは新 tokenVersion で生存、他デバイスのみ失効

この経路を実装するまで「他デバイス強制ログアウト」は **post-MVP** に回す。

### 横展開で漏らしやすい箇所

- [ ] tokenVersion increment を新規追加する PR は **「自分操作か他人操作か」** を明示的に区別
- [ ] 「自分操作」では increment 禁止 (= 自滅を防ぐ)
- [ ] 「自分操作」での回帰テスト (`expect(data).not.toHaveProperty('tokenVersion')`) を必ず追加
- [ ] 「他デバイスログアウト」要件は別 UI + `session.update` で対応

### 検出のしかた

| 症状 | 真因の可能性 |
|---|---|
| 直近の操作 (パスワード変更等) の直後に API が 401 | 自分操作で tokenVersion increment による即死 |
| 画面に「再度ログインしてください」が表示 | getAuthenticatedUser の SESSION_INVALIDATED |
| E2E spec で「step N」が PASS、「step N+1」が「再ログイン」エラー | 直前 step での自セッション失効 |
| screenshot で意図しないエラー表示 + 続く操作要素が不可視 | 認証境界での前段 failure が UI に伝播 |

### 関連

- 修正 PR: PR #350 (2026-05-13 / security/jwt-invalidation) — changePassword の tokenVersion increment を削除、admin 操作は維持
- 関連 ファイル:
  - [src/services/password.service.ts](../../src/services/password.service.ts) — changePassword (increment 削除)
  - [src/services/user.service.ts](../../src/services/user.service.ts) — admin 操作 (increment 維持)
  - [src/lib/api-helpers.ts](../../src/lib/api-helpers.ts) — getAuthenticatedUser で SESSION_INVALIDATED 検出
- 関連 公式 docs: [NextAuth v5 session.update](https://authjs.dev/getting-started/session-management/protecting) — session 更新による JWT 同期

## 5.X+47 ダッシュボード課金根拠データは「日次 cron キャッシュ依存」を避け、**画面遷移時に再集計 + 手動再集計ボタン** を必ず併設する (2026-05-14 で確立)

### 背景
本番 Supabase で `tenants.storage_bytes_used_at = NULL` のテナントが多数発生していた。原因は「日次 cron `/api/cron/daily-notifications` の `updateAllStorageBytesUsed()` が一度も成功していなかった」こと。

旧仕様 (`tenant-storage.service.ts:23` のコメント「24 時間ラグを許容」) はキャッシュ更新を完全に cron 任せにしており、cron が止まっても誰にも気付かれない構造だった。Default テナントの実時間集計は ~754 KB だが、画面表示は **0 B / 20.0 MB (0%)** のまま長期間放置。

### 教訓
「請求根拠」「課金集計」「税務監査対象」のデータは以下を全て満たす設計が必要:

1. **キャッシュ依存しない**: ダッシュボード遷移時に最新値を再集計してから表示する
2. **手動再集計ボタン**: ユーザが任意のタイミングで明示的に最新化できる
3. **集計中の UI 表示**: `loading.tsx` + Suspense で「集計中…」が見える
4. **整合性チェック**: 別経路 (例: ApiCallLog SUM) と比較し、drift を警告 chip で可視化

### 横展開で漏らしやすい箇所

- [ ] 「日次 cron でキャッシュ更新」設計を新規追加する場合は、必ず on-demand 再集計関数も同時に export する
- [ ] super_admin / テナント管理者の **両方** にボタンを設置する (片方だけは UX として不十分)
- [ ] テナント越境防止: `/api/tenants/me/recalculate` は **URL に tenantId を受けない** こと。`session.user.tenantId` で固定する (severity-1 個人情報漏洩予防)
- [ ] Server Component で `await service()` した結果が NULL になる可能性は notFound() で吸収する
- [ ] Client Component から service を import すると Prisma 依存が client bundle に混入する罠あり (下記 §5.X+48 参照)

### 検出のしかた

| 症状 | 真因の可能性 |
|---|---|
| 画面に 0 B / 0% が長期間表示 | キャッシュ更新 cron が停止 |
| `storage_bytes_used_at = NULL` が SELECT で観測 | 該当テナントの cron 実行ログなし |
| 請求書合計と ApiCallLog SUM が不一致 | counter / log の race による drift |

### 関連

- PR: 2026-05-14 dev/2026-05-14 (本 PR で確立)
- 関連 ファイル:
  - [src/services/api-usage-recalc.service.ts](../../src/services/api-usage-recalc.service.ts) — ApiCallLog SUM ベースの整合性チェック
  - [src/services/tenant-storage.service.ts](../../src/services/tenant-storage.service.ts) — `updateStorageBytesUsedForTenant` 単一テナント on-demand
  - [src/components/recalculate-button.tsx](../../src/components/recalculate-button.tsx) — 汎用「再集計」ボタン (`useTransition` + `router.refresh()`)
  - [src/app/api/admin/super/recalculate-all/route.ts](../../src/app/api/admin/super/recalculate-all/route.ts) — 全テナント一括
  - [src/app/api/tenants/me/recalculate/route.ts](../../src/app/api/tenants/me/recalculate/route.ts) — テナント越境防止モデルケース

## 5.X+48 Client Component が `@/services/*` から **value import** すると Prisma が client bundle に混入し build 失敗する ─ 純粋 config に閾値定数を分離する (2026-05-14 で確立)

### 背景
`UsageDriftBadge` (Client Component) で `DRIFT_WARNING_THRESHOLD` という閾値定数を service から value import したところ、`pnpm build` で以下のエラー:

```
the chunking context (unknown) does not support external modules (request: node:module)
Import trace: usage-drift-badge.tsx → api-usage-recalc.service.ts → @/lib/db → pg
```

`@/lib/db` が `pg` (Node.js native) を引っ張り、これが client bundle に混入して chunking が失敗する。

### 教訓
**Client Component から service ファイルへの値依存は禁止**。必要なら次のいずれか:

1. **閾値・enum・定数のみ純粋 config に切り出す** (推奨): `src/config/<name>.ts` を新規作成し、Client / Server 双方から import 可能にする。service 側は config から re-export して既存呼出を維持
2. **`import type` のみ使う**: 型情報は build 時に消えるので Prisma を引っ張らない

逆に: Server Component から service の value/type 両方 import は問題なし (= Server bundle には Prisma が入って良い)。

### 横展開で漏らしやすい箇所

- [ ] Client Component (`'use client'`) で `@/services/*` から定数を value import していないか
- [ ] `@/lib/db` の transitive import が Client bundle に入っていないか
- [ ] `pnpm build` を ローカル + CI で必ず通す (`pnpm test` だけでは検出されない)

### 検出のしかた

| 症状 | 真因の可能性 |
|---|---|
| `the chunking context (unknown) does not support external modules` | Client → service → @/lib/db の transitive import |
| `Module not found: node:module` | Server-only module が Client bundle に混入 |
| `pnpm test` 全 pass + `pnpm build` のみ失敗 | 型は通るが webpack/turbopack の chunking で初検出 |

### 関連

- PR: 2026-05-14 dev/2026-05-14 (本 PR で確立)
- 修正パターン: `src/config/api-usage-drift.ts` で `DRIFT_WARNING_THRESHOLD` を分離 → Client / Server 双方から `@/config/*` 経由で取得
- 関連 公式 docs: [Next.js: Server and Client Composition Patterns](https://nextjs.org/docs/app/building-your-application/rendering/composition-patterns#supported-pattern-passing-server-components-to-client-components-as-props)

## 5.X+49 新規 `route.ts` / `page.tsx` を追加した PR は **必ず `docs/test/E2E_COVERAGE.md` にエントリを追記** ─ CI の `e2e:coverage-check` が exit 1 で落とす (2026-05-14 PR #355 で実体験)

### 背景

PR #355 (本 PR) で `/api/admin/super/recalculate-all`, `/api/admin/super/tenants/[id]/recalculate`, `/api/tenants/me/recalculate` の 3 つの API Route を新規追加したが、`docs/test/E2E_COVERAGE.md` への追記を忘れた結果、GitHub Actions の `Lint / Test / Build` ジョブが以下で失敗:

```
> tsx scripts/check-e2e-coverage.ts
❌ docs/test/E2E_COVERAGE.md に未記載の機能があります:
   - /api/admin/super/recalculate-all
   - /api/admin/super/tenants/[id]/recalculate
   - /api/tenants/me/recalculate
ELIFECYCLE Command failed with exit code 1.
```

CLAUDE.md §コミット前チェック §6 で「新規 page.tsx / route.ts を追加したら必ず追記」と明記されているが、実装に集中していると見落としやすい。**ローカルで lint/test/build を通しても、`e2e:coverage-check` を別途実行しないと検出されない罠**。

### 教訓

新規ルート / 画面の追加 PR を出す前に **必ず** ローカルで以下を実行:

```bash
pnpm e2e:coverage-check
```

このコマンドは CI と同じスクリプト (`scripts/check-e2e-coverage.ts`) を実行し、未記載があれば exit 1。`pnpm lint && pnpm tsc --noEmit && pnpm test && pnpm build` の **4 点セットには含まれていない** ため意識的に追加実行が必要。

### 記載パターン

| ケース | 形式 |
|---|---|
| E2E 化済 | `- [x] /path — e2e/specs/NN-foo.spec.ts (取材内容)` |
| 未カバー (skip) | `- [ ] /path (METHOD) — skip: <理由>。<別経路の担保 (サービステスト等)>` |

「skip: 」を必ず付与する (= スクリプトが「明示的に skip」と認識)。

### 横展開で漏らしやすい箇所

- [ ] 新規ファイル追加時のチェックリスト: `route.ts` / `page.tsx` / `loading.tsx` 以外の `*.tsx` を含むか?
  - **loading.tsx は不要** (E2E_COVERAGE はあくまでルート/エンドポイント単位)
  - `route.test.ts` 等のテストファイルも不要
- [ ] CI が落ちる前に: PR 作成前 push の **直前** に `pnpm e2e:coverage-check` を打つ習慣
- [ ] チェック対象を増やす提案: `auto-commit.sh` (Stop Hook) に `e2e:coverage-check` を組み込めば再発防止できる (将来の改善候補)

### 検出のしかた

| 症状 | 真因の可能性 |
|---|---|
| CI ジョブ `Lint / Test / Build` のみ red、ローカルは全 pass | E2E_COVERAGE 漏れ (`tsx scripts/check-e2e-coverage.ts` が exit 1) |
| `❌ docs/test/E2E_COVERAGE.md に未記載の機能があります` ログ | まさにこれ |

### 関連

- PR: #355 (2026-05-14 dev/2026-05-14 本 PR で実体験)
- スクリプト: [scripts/check-e2e-coverage.ts](../../scripts/check-e2e-coverage.ts)
- ドキュメント: [docs/test/E2E_COVERAGE.md](../test/E2E_COVERAGE.md)
- 修正コミット: `docs(e2e): PR #355 で追加した recalculate 系 3 endpoint を E2E_COVERAGE に追記`

## 5.X+50 Bulk な LLM API 呼出を実装するときは **withMeteredLLM を 1 度だけラップ + callback 内で voyageEmbed を分割呼出** ─ ApiCallLog / 画面表示の API 呼出回数を統一する (PR #357 / 2026-05-14 で確立)

### 背景

ユーザ要件として「DB の `current_month_api_call_count` = 画面表示の『今月 API 呼出』= ユーザに見える実 API 呼出回数」を統一したい。旧 import 経路は ループで N 件 = N 回 voyageEmbed = N 件 ApiCallLog という設計で、5000 件 import すれば counter が +5000 されていた。これはユーザが請求書を見たときに「私のテナントは月 5000 呼出も?」と疑問を持つ UX 問題。

### 解決パターン

**「1 業務操作 = 1 ApiCallLog」原則**:

```ts
// 旧 (NG): N 件で N ApiCallLog
for (const item of items) {
  await generateAndPersistEntityEmbedding({ ... }); // 内部で withMeteredLLM(...) 呼出
}

// 新 (OK): 1 業務操作 = withMeteredLLM 1 度 = ApiCallLog 1 件
const result = await withMeteredLLM(opts, async ({ requestId }) => {
  // callback 内で voyageEmbed を必要な回数呼ぶ (Voyage 1 リクエスト制限を考慮)
  const allEmbeddings = [];
  let totalTokens = 0;
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const v = await voyageEmbed({ texts: texts.slice(i, i + MAX_BATCH_SIZE) });
    allEmbeddings.push(...v.embeddings);
    totalTokens += v.totalTokens;
  }
  return { result: allEmbeddings, usage: { embeddingTokens: totalTokens }, requestId };
});
```

### 設計判断のポイント

| 論点 | 判断 |
|---|---|
| バッチサイズ | 128 (Voyage 公式 1000 texts / 120K tokens の安全側) |
| Voyage の 1 リクエスト超過 | callback 内で内部分割。**Tenant counter は 1 度のみ +1** |
| 部分失敗 | 1 バッチ失敗で全体 `llm_error` (= 1 業務操作の単位を保つ。partial success は呼出側の複雑さを増す) |
| costJpy | `withMeteredLLM` 側で plan 単価から固定算出 (= 1 LLM 呼出 = 1 単位課金) |
| 課金分類 (featureUnit) | 業務単位で意味のある名前 (例: 'external-import-embedding') |

### 横展開で漏らしやすい箇所

- [ ] **embedding 以外の Bulk LLM 操作** でも同パターンを適用すべき (例: 大量 auto-tag 抽出、suggestion 説明文一括生成)
- [ ] **「Voyage 呼出回数 ≠ ApiCallLog 件数」を覚悟する**: withMeteredLLM の本来 1:1 設計から外れるが、ユーザ視点の請求単位は ApiCallLog 単位に揃える
- [ ] **テストで件数検証を必ず書く**: `expect(generateAndPersistBatchEmbeddings).toHaveBeenCalledTimes(1)` + `items.length === N` の併記が再発防止に有効

### 関連

- PR #357 (2026-05-14): 本パターン確立
- 修正ファイル: [src/services/embedding.service.ts](../../src/services/embedding.service.ts) (`generateBatchEmbeddings` / `generateAndPersistBatchEmbeddings`)
- 適用ファイル: [src/services/external-data-import.service.ts](../../src/services/external-data-import.service.ts) (N 件 → 1 ApiCallLog)
- 関連 公式 docs: [Voyage AI Embeddings API](https://docs.voyageai.com/reference/embeddings-api) (texts: array 入力対応)

## 5.X+51 「公開範囲」(visibility) 概念のあるエンティティでは、**`visibility='draft' なら embedding 生成しない**」がコスト最適化の鉄則 ─ 提案エンジンに乗らないデータに課金しない (PR #357 / 2026-05-14 で確立)

### 背景

旧仕様は Knowledge / RiskIssue / Retrospective の create/update で **visibility に関わらず無条件で embedding 生成**していた。しかし suggestion engine 側は `visibility='public'` のみを検索対象 (= draft は提案候補に出ない)。つまり draft のデータに対する embedding 生成は **永遠に検索されない用途に Voyage API 課金を消費**していた。

### 解決パターン (visibility 状態遷移マトリクス)

| 遷移 | embedding 生成 |
|---|---|
| 新規 visibility=draft | × |
| 新規 visibility=public | ○ |
| update draft → draft | × (text 変更があっても課金しない) |
| update draft → public | ○ (text 変更なしでも初回 embedding 化) |
| update public → public | text 変更時のみ ○ |
| update public → draft | × (既存 embedding は削除しない) |

### 実装パターン

```ts
const wasDraft = existing.visibility === 'draft';
const willBeDraft = (input.visibility ?? existing.visibility) === 'draft';
const becameVisible = wasDraft && !willBeDraft;     // 公開化
const stayedVisible = !wasDraft && !willBeDraft;    // 公開維持
const shouldGenerateEmbedding =
  !willBeDraft && (becameVisible || (stayedVisible && textFieldsChanging));
```

### 横展開で漏らしやすい箇所

- [ ] visibility カラムを持つ全エンティティを網羅: 現状 Knowledge / RiskIssue / Retrospective。**Project には visibility がない** ので対象外
- [ ] **既存 embedding の削除はしない**: ユーザ意図 (PR #357) に従い、draft 退行時も embedding を NULL に戻さない。提案エンジン側の visibility filter が候補から除外するので二重防御
- [ ] `existing.visibility` を select に追加することを忘れない (= `undefined` だと判定がバグる)
- [ ] テストで 5 ケース (新規 2 + 更新 4) を最低限カバー

### 関連

- PR #357 (2026-05-14): 本パターン確立
- 修正ファイル:
  - [src/services/knowledge.service.ts](../../src/services/knowledge.service.ts) (create/update)
  - [src/services/risk.service.ts](../../src/services/risk.service.ts) (create/update)
  - [src/services/retrospective.service.ts](../../src/services/retrospective.service.ts) (create/update)
- 提案エンジン側 filter: [src/services/suggestion.service.ts:319, 536](../../src/services/suggestion.service.ts) (visibility='public' 絞り込み = draft は候補外)

### PR #358 フォローアップ修正記録 (2026-05-14)

PR #357 マージ後のフルスキャンで以下の **取り込み漏れ 2 件** が判明し、PR #358 で修正:

| # | 漏れ箇所 | 問題 | 修正 |
|---|---|---|---|
| 1 | `external-data-import.service.ts:applyImport` | CSV/XLSX 取り込みデータの visibility をチェックせず全件 embedding 生成 (案D 漏れ) | batchItems ループに `if ((k.visibility ?? 'company') === 'draft') continue;` を追加。`embeddingSkippedDraft` カウンタを `ApplyResult.summary` に新設し wizard 画面で「下書き N 件は課金対象外」表示 |
| 2 | `suggestion.service.ts` の RiskIssue findMany 3 箇所 (line 387, 460, 758) | Knowledge / Retrospective は `visibility: 'public'` 絞り込み済だが RiskIssue だけ漏れ。draft な resolved RiskIssue が候補に出る可能性 (= 案D で embedding NULL のため score=0 表示の不整合) | 3 箇所の where 句に `visibility: 'public'` を追加 |

### 横展開チェックリストの追加 (PR #358 で学んだ点)

PR #357 の横展開でこのチェックを **書き込み側 (embedding 生成) のみ** 確認したが、**読み出し側 (検索クエリの visibility filter)** の整合性も併せて検証する必要があった。以下を将来の visibility 関連 PR で必ず実施:

- [ ] **書き込み側**: create/update で `visibility='draft'` なら embedding 生成しない
- [ ] **読み出し側**: 提案エンジン / 全件検索など、当該エンティティを SELECT する全クエリに `visibility: 'public'` フィルタを付与 (= `grep -n 'prisma\.<entity>\.findMany' src/services/`)
- [ ] **import / bulk 取込経路**: 取込時データの visibility 別動作を明示。draft なら embedding 生成 skip + ユーザに「課金対象外件数」を可視化
- [ ] **シードデータ確認**: `prisma/seed*.ts` の visibility 値が `public` であること (= visibility filter 追加で候補消失の事故を防ぐ)

### 関連 (PR #358 追加)

- PR #358 (2026-05-14): フォローアップ修正
- 修正ファイル:
  - [src/services/external-data-import.service.ts](../../src/services/external-data-import.service.ts) (applyImport の draft skip + embeddingSkippedDraft カウンタ)
  - [src/services/suggestion.service.ts](../../src/services/suggestion.service.ts) (RiskIssue 3 箇所の visibility filter)
  - [src/app/(dashboard)/settings/tenant/external-import/wizard-client.tsx](../../src/app/(dashboard)/settings/tenant/external-import/wizard-client.tsx) (下書き N 件表示)

## 5.X+52 form 入力連動の preview API は **debounce + AbortController + 共通 hook** で実装する (PR #361 / 2026-05-14)

### 背景

WBS 画面で ACT 作成・編集時に「担当者の日次工数オーバー」を事前検知したい要件で、入力中の (担当者 / 開始日 / 終了日 / 工数) 4 フィールドを debounce 監視して preview API を呼ぶ機能を実装。

### 学んだパターン

1. **共通 hook 化** (`useWorkloadPreview`): edit dialog と create dialog の **2 箇所で同じロジック** を使うため、カスタム hook 化が必須。useState + useEffect を内包し、API fetch を一元管理
2. **React hook ルール**: 条件付き呼出禁止 (= 条件付き hook = error)。dialog の表示状態で hook を分岐させたい場合は **`enabled` flag** を引数に取り、内部で「skip 制御」する設計
3. **AbortController**: 連続入力で前回 fetch が後勝ちになるのを防ぐ。debounce timer のクリアと controller.abort() を **両方** cleanup で実行する
4. **debounce 値**: 既存 comment-section の 250ms と同オーダーの **300ms** を採用。短いと連打 API 呼出、長いとレスポンス遅延

### 関連する罠

- **zod の UUID 検証は variant ビットも要求**: テスト用に `22222222-2222-2222-2222-222222222222` のような「単純な repeat」UUID を使うと zod が reject (variant 桁が 8/9/a/b でないため)。テストでは valid な v4 UUID (例: `11111111-1111-4111-8111-111111111111`) を使う
- **`react-hooks/set-state-in-effect` lint**: Next.js 16 で追加されたルール。「effect 内で setState」は通常避けるが、props 変化に追随した reset が必要な場合は `eslint-disable-next-line` で局所許容 (理由コメント必須)

### 横展開で漏らしやすい箇所

- [ ] 入力連動 preview を作るときは **必ず**: debounce + AbortController + 共通 hook の 3 点セット
- [ ] preview API は GET でクエリパラメータ受け、zod で必須項目検証
- [ ] **テナント分離 (severity-1)**: service 層 `project: { tenantId: viewerTenantId }` フィルタ + route 層 `checkProjectPermission` の二重防御
- [ ] **UI 表示制御**: 該当機能の権限ロール (例: PM/TL) でガード。UI 側 `{canEditPmTl && <Preview />}` + API 側 task:read レベル認可

### 関連

- PR #361 (2026-05-14): 本パターン確立
- 実装ファイル:
  - [src/components/hooks/use-workload-preview.ts](../../src/components/hooks/use-workload-preview.ts) — debounce hook 共通実装
  - [src/components/wbs/workload-preview-line.tsx](../../src/components/wbs/workload-preview-line.tsx) — 1 行表示コンポーネント
  - [src/services/task.service.ts](../../src/services/task.service.ts) — previewActivityWorkload (集計ロジック)
  - [src/app/api/projects/[projectId]/tasks/workload/preview/route.ts](../../src/app/api/projects/[projectId]/tasks/workload/preview/route.ts) — GET endpoint
  - [src/config/workload.ts](../../src/config/workload.ts) — 閾値定数

## 5.X+53 Supabase Data API は **デフォルトで public 全テーブルが anon に grant 済み** ─ Prisma 直結のみのプロジェクトでも放置すれば全件漏洩 (2026-05-14 で確立)

### 背景

2026-05-11 付の Supabase Security Advisor メールで `rls_disabled_in_public` (37 件) と `sensitive_columns_exposed` (sessions) が Critical Error として通知された。本プロジェクトは Prisma 直結のみで Data API (supabase-js / PostgREST) を未使用なので一見「無関係」だが、実は以下の構造的リスクがあった:

- Supabase デフォルト privileges:
  ```sql
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
  ```
  により、Prisma migration が作成する全テーブルに **anon ロールへの GRANT ALL が自動付与**される。
- RLS 無効状態なので、anon JWT (Supabase Dashboard で誰でも取得可) を提示すれば PostgREST `/rest/v1/users` 等から全件 read/insert/update/delete 可能。
- 漏洩対象には `sessions.session_token` / `password_reset_tokens.token_hash` / `recovery_codes` / `password_histories` 等の **認証クリティカル情報**が含まれる。

### 教訓

**「Prisma を使っているから supabase-js は無関係」ではない**。Supabase に Postgres をホスティングしている時点で PostgREST/GraphQL は自動有効化されており、デフォルト privileges による暗黙の grant がアプリ経路と独立した攻撃面を作る。

### 対策パターン (多層防御)

| Layer | 場所 | 内容 | 効果 |
|---|---|---|---|
| **Layer 1 (主防御)** | Supabase Dashboard → Integrations → Data API → Settings | Exposed schemas から `public` を削除。可能なら Enable Data API も OFF | PostgREST/GraphQL 経由の全アクセスを遮断 (即時) |
| **Layer 2** | Prisma migration | `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` を public 全テーブルに適用 (ポリシー未定義 = 完全 deny) | Dashboard 設定が誤って戻されても anon/authenticated は何も見えない |
| **Layer 3** | Prisma migration | `REVOKE ALL ... FROM anon, authenticated` + `ALTER DEFAULT PRIVILEGES ... REVOKE` | 将来 migration で追加されるテーブルにも自動適用、grant 自体を剥がす |

参照実装: [prisma/migrations/20260518_revoke_data_api_grants_and_enable_rls/migration.sql](../../prisma/migrations/20260518_revoke_data_api_grants_and_enable_rls/migration.sql)

### Prisma との互換性 (重要)

- Prisma は `DATABASE_URL` の `postgres` ロールで接続 = 全テーブルの owner
- PostgreSQL 標準動作で **owner は RLS をバイパス** (※ `FORCE ROW LEVEL SECURITY` は絶対に使わない)
- REVOKE / ALTER DEFAULT PRIVILEGES は anon/authenticated のみ対象、postgres ロール無影響
- → アプリ動作・既存テスト 1700+ 件への影響はゼロ

### ローカル DB との互換性 (重要)

ローカル開発 DB (pure PostgreSQL on Docker / 直接実行) には `anon` / `authenticated` ロールが存在しない。**そのまま `REVOKE ... FROM anon` を書くと `role "anon" does not exist` で migration が失敗する**ため、必ず `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN ... END IF; END $$;` で存在確認してから REVOKE する。E2E CI (`pgvector/pgvector:pg16`) も pure PostgreSQL なので同じ条件分岐が必要。

### 横展開チェックリスト

- [ ] **新規プロジェクト作成時**: Supabase Dashboard → Data API → Exposed schemas から `public` を削除 (Enable Data API OFF が理想)
- [ ] **新規テーブル追加時**: `ALTER TABLE public.<new_table> ENABLE ROW LEVEL SECURITY` を migration に含める (Layer 3 で grant は阻止されているが、Layer 2 の防御層は手動で都度有効化が必要 — Postgres に "RLS デフォルト ON" 設定が存在しないため)
- [ ] **AWS 移行時**: Supabase 由来のデフォルト privileges は不要になる。`anon` / `authenticated` ロールも作らないので Layer 3 の意味がなくなる。Layer 2 (RLS) も owner バイパスで実害ないが、移行時に検討
- [ ] **Security Advisor 定期確認**: 月 1 回 Dashboard → Advisors → Security Advisor を確認 (新規テーブル追加で再発する可能性)

### 検出のしかた

| 症状 | 真因の可能性 |
|---|---|
| Supabase からの定期メール「These issues require your immediate attention」 | Security Advisor が Critical Error を検出 |
| `rls_disabled_in_public` Advisor Error | RLS 無効テーブルが Exposed schemas に含まれている |
| `sensitive_columns_exposed` Advisor Error | password / token 系カラムを含むテーブルが API exposed |

### 関連

- 適用 migration: [prisma/migrations/20260518_revoke_data_api_grants_and_enable_rls/](../../prisma/migrations/20260518_revoke_data_api_grants_and_enable_rls/migration.sql)
- 運用 runbook: [docs/operations/SECURITY_OPS.md §13.5](../operations/SECURITY_OPS.md) (Supabase Security Advisor 定期確認)
- Supabase 公式: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase Default Privileges 仕様: https://supabase.com/docs/guides/database/postgres/roles-superuser
- 関連 KDD: §5.42 (migration を含む PR の本番手動適用ルール)

## 5.X+54 KDD 末尾コンフリクトで **section 番号が両ブランチで衝突**するケース ─ §5.X+30 のサブパターン (PR #362 / 2026-05-14)

### 罠の正体

§5.X+30 は「両ブランチが KDD ファイル末尾に **異なる番号** の新セクションを足してコンフリクトする」パターンを記述するが、本 PR #362 では更に踏み込んだ事故が発生:

- 開発開始時点の最大 section は `5.X+49` (PR #355 でコミット済)
- HEAD (PR #362): `5.X+50` として Supabase Data API ナレッジを追加
- main: PR #357 / #358 / #361 が並行マージされ、**同じ `5.X+50` 番号**で別トピック (Bulk LLM)、続けて `5.X+51` (visibility=draft)、`5.X+52` (workload-preview) を採番

結果: コンフリクトマーカーで挟まれた両側が **同じ section 番号で別内容** という状態。素朴に「両方残す」(§5.X+30 流) と **同番号セクションが 2 つ並ぶ破損ドキュメント**になる。

### 解消手順 (本 PR #362 で実践)

1. **main 側を全保持 + HEAD 側をリナンバリング** が正解:
   - main の `5.X+50` / `5.X+51` / `5.X+52` をそのまま採用 (歴史的経緯を保持)
   - HEAD の `5.X+50` を **`5.X+53` にリナンバリング** (main の最大番号 + 1)
2. **クロスリファレンスを同時更新**:
   - 他ドキュメントから `§5.X+50` を参照していたら新番号に置換 (本 PR では [docs/operations/SECURITY_OPS.md §13.5](../operations/SECURITY_OPS.md))
   - MEMORY.md / auto-memory に古い番号が残っていないかも grep で確認
3. **本サブパターン自体を新セクション (`5.X+54`) として記録** — 次の衝突で同じ判断を再生できるよう

### 検出のしかた

| 症状 | 真因 |
|---|---|
| `git merge` で `KDD_PATTERNS.md` のみ conflict、他ファイルは clean | §5.X+30 末尾コンフリクト (典型) |
| HEAD 側と main 側で **同じ `## 5.X+N` 見出し**が出現 | 番号衝突 (本サブパターン) ─ リナンバリング必須 |
| 他ドキュメントから `§5.X+N` 参照を grep でヒット | クロスリファレンス更新が必要 |

### 横展開で漏らしやすい箇所

- [ ] **リナンバリング後の cross-reference 一括 grep**: `grep -rn "§5\.X+50" docs/` で参照漏れを検出
- [ ] **auto-memory (MEMORY.md / memory/\*.md) の参照**: KDD section 番号が memory に記載されていれば更新 (本 PR では該当なし)
- [ ] **PR description の参照**: PR description 内に `§5.X+50` 等を書いていた場合は GitHub 上で edit
- [ ] **本サブパターン記録**: 同じ事象が再発したら、本 §5.X+54 を更新 (再発事例の連番方式 ─ CLAUDE.md「§10.5 末尾追記コンフリクトの 5 例目まで」の前例に倣う)

### 予防策 (§5.X+30 の表に追加)

| 戦略 | 効果 | コスト |
|---|---|---|
| **KDD ファイル末尾編集前に `git fetch origin main && git log origin/main -- docs/knowledge/KDD_PATTERNS.md \| head -20` で最新採番を確認** | 番号衝突を事前検知 | 軽 (1 コマンド) |
| **長期 PR でなくとも、main 高頻度マージ日 (例: PR #357-#361 が連続マージされた 2026-05-14) は必ず採番再確認** | 短期 PR でも番号衝突は起きる事実への対処 | 軽 (運用ルール) |

### 関連

- 親パターン: §5.X+30 (KDD 末尾コンフリクト・両方残す)
- 修正例: PR #362 (本 PR で実体験)
- 修正コミット: `fix(kdd): PR #362 で 5.X+50 が main と衝突、5.X+53 にリナンバリング + cross-reference 更新`

## 5.X+55 「is_sample_data エンティティを管理テナントに移動する」migration は **親 FK エンティティの移動漏れに注意** ─ Project だけ移し Customer は残った例 (2026-05-14)

### 罠の正体

`20260513_seed_to_management_tenant` migration では `is_sample_data=TRUE` の **Project / Knowledge / RiskIssue / Retrospective** を default-tenant から management-tenant へ移動した。
しかし **Project の親エンティティである Customer (`projects.customer_id` で参照)** はテーブルに `is_sample_data` 列が無いため対象選定から漏れ、default-tenant に残置された。

結果として:

- management-tenant の Project が default-tenant の Customer を `customer_id` で参照する **テナント越境 FK** 状態が継続。
- 「テナント分離の不変条件: 1 リソースは 1 テナントに属する」を破る。
- システム管理者 (super_admin / 管理テナント所属) が `/customers` 画面でシード Customer を編集しようとしても、自身の tenantId スコープ (= management-tenant) には該当 Customer が存在せず操作不能だった。

機能的には提案エンジンが Customer フィールドを直接読まないため壊れていなかったが、**整合性違反が長期間放置** されていた。

### 検出のしかた

| 症状 | 真因 |
|---|---|
| sysadmin 画面に「シードデータ管理」が無いと感じる | 既存 admin 画面 (`/customers` 等) が super_admin に open されていない可能性 |
| シード CRUD UI を入れようとすると「該当 Customer が見つからない」 | 親 FK エンティティが管理テナント未移行 (本パターン) |
| `SELECT p.tenant_id, c.tenant_id FROM projects p JOIN customers c ON p.customer_id = c.id WHERE p.is_sample_data = TRUE` で **両者の tenant_id が異なる行が存在** | テナント越境 FK の決定的検出クエリ |

### 解消手順 (本 PR / 2026-05-14 で実践)

1. **追従 migration を発行**: `20260519_seed_customer_to_management_tenant` で、`management-tenant` の sample Project が `customer_id` で参照している default-tenant 残置 Customer を `UPDATE tenant_id` で移動。
   ```sql
   UPDATE customers SET tenant_id = '..ffffffffffff'
   WHERE tenant_id = '..00000000001'
     AND id IN (SELECT DISTINCT customer_id FROM projects WHERE tenant_id = '..ffffffffffff' AND is_sample_data = TRUE AND customer_id IS NOT NULL);
   ```
2. **冪等性**: WHERE 句で「default-tenant に残っているもの」だけを対象にする → 再実行 NO-OP。
3. **横展開チェック**: 移行対象になったエンティティの **全 FK 親/子** を一覧化し、対応漏れがないか目視確認 (本ケースでは Customer のみだった)。

### 横展開で漏らしやすい箇所

- [ ] 「`is_sample_data` を持たない親エンティティ」(Customer のように) は **JOIN 経由でしか sample 識別できない**。`is_sample_data` flag だけを WHERE 条件にした migration は親を取りこぼす。
- [ ] **テナント越境 FK 検出クエリ** を migration 追加時のセルフレビュー項目に入れる:
  ```sql
  -- 全主要 FK 関係について実行 (Project ↔ Customer / Risk ↔ Project / 等)
  SELECT a.tenant_id AS a_tenant, b.tenant_id AS b_tenant, count(*)
    FROM <child> a JOIN <parent> b ON a.<parent_id> = b.id
   WHERE a.tenant_id <> b.tenant_id
   GROUP BY 1, 2;
  ```

### sysadmin (super_admin) によるシード CRUD UI の最小実装パターン

新たに `/admin/super/customers` 等の別 UI を作る必要は無い。**既存の admin 画面に super_admin を露出させる** だけで済む:

| 変更箇所 | 内容 |
|---|---|
| 認可ガード (page + API route) | `systemRole !== 'admin'` を **`isAdminOrAbove(user)` ([src/lib/permissions/role.ts](../../src/lib/permissions/role.ts))** に置換。super_admin も通過する。 |
| ナビ表示 | `adminOnly: true` の項目に **`visibleToSuperAdmin: true`** を併記。`isVisibleItem()` が super_admin に項目を表示する。 |
| サービス層 | **変更不要**。super_admin の `session.user.tenantId = MANAGEMENT_TENANT_ID` がそのまま `where: { tenantId: viewerTenantId }` に渡り、管理テナントスコープになる。 |

**設計判断の根拠**: テナント分離 (where に tenantId 必須) を厳守してきた service 層は、`session.user.tenantId` のみに依存している。super_admin の所属テナントを管理テナントに設定 ([prisma/seed.ts:227](../../prisma/seed.ts#L227)) しておけば、認可の壁さえ通せば既存ロジックがそのまま管理テナント運用ツールとして機能する。新規 service / 新規 API を増やさずに済むため、テスト工数と attack surface が最小化される。

### 横展開: 他の admin-only 画面を super_admin に開放するとき

他資産 (Project / Knowledge / RiskIssue / Retrospective) の sysadmin 直接編集が必要になった場合、上記 3 点 (auth gate / nav flag / service-layer 無改修) を **同じパターン** で適用する。

**2026-05-14 追加対応 (PR #364 同梱)**: 横展開チェック中に「**Project POST だけが super_admin をハードブロック**」していることが判明した。

| 操作 | Customer | **Project (修正前)** | **Project (修正後)** | Knowledge (seed=standalone) | Risk | Retrospective |
|---|---|---|---|---|---|---|
| CREATE | ✅ | ❌ ([api/projects/route.ts:59](../../src/app/api/projects/route.ts#L59) `systemRole !== 'admin'`) | ✅ `isAdminOrAbove` | ✅ | ✅ (via `checkProjectPermission`) | ✅ (via `checkProjectPermission`) |
| UPDATE | ✅ | ✅ (`checkMembership` の super_admin 短絡) | ✅ | ✅ | ✅ | ✅ |
| DELETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**根拠**:
- Risk / Retrospective は project-scoped ルート (`/api/projects/[id]/risks` 等) が `checkProjectPermission` 経由で [src/lib/permissions/membership.ts:87](../../src/lib/permissions/membership.ts#L87) の super_admin → pm_tl 短絡を取り込むため、認可は素通りする。
- Knowledge の seed は **standalone (projectIds 紐付けなし)** で投入される ([prisma/seed-suggestion.ts:2566-2596](../../prisma/seed-suggestion.ts)) ため、`/api/knowledge` POST のメンバーシップ検証経路 (line 79-86) には乗らない。
- Project POST のみは API route 入口で `systemRole === 'admin'` 厳密判定があり、super_admin が落ちていた。MVP-1a 制約のコメント残置が原因。

**横展開チェックリスト (`is_sample_data` を持つエンティティを sysadmin 開放するとき必須)**:

- [ ] 一覧 page (例: `/customers/page.tsx`) の auth gate を `isAdminOrAbove`
- [ ] 詳細 page (例: `/customers/[id]/page.tsx`) の auth gate を `isAdminOrAbove`
- [ ] **collection API (`/api/<entity>` の GET/POST) の認可を `isAdminOrAbove`** ← Project はここが漏れていた
- [ ] item API (`/api/<entity>/[id]` の GET/PATCH/DELETE) の認可を `isAdminOrAbove`
- [ ] project-scoped ルート (`/api/projects/[id]/<child>`) は **`checkProjectPermission` 経由なら無改修**で super_admin 通過
- [ ] nav 表示: `adminOnly: true` の場合は `visibleToSuperAdmin: true` を併記
- [ ] super_admin POST/PATCH/DELETE のユニットテスト追加

### 検出のしかた (Project POST 漏れの再発防止)

```bash
# super_admin に開放したいエンティティの全 route ファイルを grep。
# admin 判定が「=== 'admin'」直書きなら漏れ候補:
grep -rn "systemRole !== 'admin'\|systemRole === 'admin'" src/app/api/<entity>/
# → 1 件でもヒットしたら isAdminOrAbove に置換 + テスト追加
```

### 関連

- migration: [prisma/migrations/20260519_seed_customer_to_management_tenant/migration.sql](../../prisma/migrations/20260519_seed_customer_to_management_tenant/migration.sql)
- 先行 migration: [prisma/migrations/20260513_seed_to_management_tenant/migration.sql](../../prisma/migrations/20260513_seed_to_management_tenant/migration.sql) (Customer 移行漏れの起点)
- 認可ヘルパ: [src/lib/permissions/role.ts](../../src/lib/permissions/role.ts) `isAdminOrAbove`
- nav 拡張: [src/components/dashboard-header.tsx](../../src/components/dashboard-header.tsx) `visibleToSuperAdmin` flag
- seed 維持ガイド: [docs/developer-guide/SEED_DATA_MAINTENANCE.md §1-2 / §1-3](../developer-guide/SEED_DATA_MAINTENANCE.md)

## 5.X+56 業務仕様書と実装で挙動が乖離していたら **仕様書を真実とみなして実装を寄せる** ─ Expert↔Pro ダウングレード即時化 (2026-05-14)

### 罠の正体

業務仕様書 ([docs/business/TENANT_AND_BILLING.md §F-13.11](../business/TENANT_AND_BILLING.md)) に:

> 「**Expert ↔ Pro の切替は即時反映**」

と明記されていたが、実装 ([src/services/tenant-self.service.ts](../../src/services/tenant-self.service.ts)) では:

```ts
if (isUpgrade(currentPlan, nextPlan)) { 即時 } else { 翌月予約 }
```

と「ダウングレード全般を一律で翌月予約」していた。結果、Pro→Expert ダウングレードが業務仕様書と異なる挙動 (= 翌月適用) で動作していた。

ユーザ指摘で発覚するまで気付かれなかった。**仕様書と実装の乖離は、テストが「実装の現状」を検証してしまうとサイレントに固定化される** (本件の単体テスト [tenant-self.service.test.ts:265](../../src/services/tenant-self.service.test.ts) は「Pro → Expert ダウングレード: 翌月 1 日 (UTC) に予約」を期待していた)。

### 真因と判断材料

旧実装で「Pro→Expert も翌月適用」だった根拠は、ダウングレード共通の悪用防止策 ([§NF-13.15](../business/TENANT_AND_BILLING.md)):

> 月末ぎりぎりにダウングレードして当月分を 0 円にする悪用を防ぐ

を **Expert↔Pro にも適用してしまった** こと。しかし:

- 課金モデルは **per-call 従量課金** (Expert ¥5/call / Pro ¥15/call、2026-05-15 改定後。`withMeteredLLM` が呼出時点の plan で単価を確定)
- 「月途中でダウングレードして当月分 0 円化」は **Beginner (¥0 / 月 100 回上限) への退避だけが該当**
- Expert↔Pro 間は per-call 課金のため、月途中の切替でも当月分は新旧単価の混在で正しく課金記録される → 悪用が成立しない

→ §NF-13.15 の射程は **Beginner ダウングレードのみ**。Expert↔Pro に適用したのは過剰防衛だった。

### 横展開チェックリスト (「仕様 vs 実装」乖離検出)

新規機能の挙動を回答するとき、または ユーザに仕様を説明するときは:

- [ ] **必ず実コードを直接読む** (推測・記憶ベース回答禁止 / CLAUDE.md「情報源の信頼性ルール」)
- [ ] **業務仕様書 (`docs/business/*`) も並行参照** し、コードと記述に齟齬がないか確認
- [ ] 齟齬があれば「**業務仕様書を真実とみなして実装を寄せる**」を原則とする
  - 例外: 仕様書側が古い / 安全側に振った決定が後から覆っていない場合のみ。明示確認すること
- [ ] **既存テストの期待値も仕様 vs 実装乖離の証拠になる** ─ テストが「翌月予約」を assert していても、それが業務仕様と合致するか別チェック
- [ ] 修正時は **ロードマップ文書 (V1_FINAL_TASKS.md)** + **業務仕様書 (TENANT_AND_BILLING.md)** + **既存テスト** の 3 点を同期更新

### 修正のしかた (本件の実例)

1. [tenant-self.service.ts](../../src/services/tenant-self.service.ts): `isUpgrade` 分岐を撤去し、`if (nextPlan === 'beginner') 拒否 else 即時更新` の 2 分岐に簡素化
2. [tenant-self.service.test.ts](../../src/services/tenant-self.service.test.ts): 「Pro→Expert ダウングレード: 翌月予約」を「即時反映」に書き換え
3. [plan-change-flow.e2e.test.ts](../../src/services/plan-change-flow.e2e.test.ts): 月跨ぎシナリオの「M3 cron で予約適用」を「M2 中即時 + cron での適用は 0 件」に書き換え + Pro→Expert 即時反映の単発テスト追加
4. [tenant-settings-client.tsx](../../src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx): 確認 dialog の「月末から適用」文言を「即時反映 + Pro 限定機能が即座に使えなくなる」文言に修正
5. [V1_FINAL_TASKS.md §150](../roadmap/V1_FINAL_TASKS.md) / [TENANT_AND_BILLING.md §F-13.11 / §NF-13.15 / §357](../business/TENANT_AND_BILLING.md): 「翌月適用」記述を全消去し「Beginner downgrade は完全禁止、Expert↔Pro は即時」に統一
6. 旧予約フィールド (`scheduledPlanChangeAt` / `scheduledNextPlan`) を新規にセットするコードパスを撤去。月初 cron 側 + `cancelScheduledPlanChange` は **legacy DB レコード対策** として残置

### 関連

- 業務仕様: [docs/business/TENANT_AND_BILLING.md §F-13.11 / §NF-13.15](../business/TENANT_AND_BILLING.md)
- 課金モデル: [src/lib/llm/metered.ts](../../src/lib/llm/metered.ts) (withMeteredLLM が呼出時点の plan で単価を確定)
- 単価解決: [src/config/llm.ts](../../src/config/llm.ts) `resolveCostForPlan` / `resolveModelForPlan`
- 改修コミット: (本 PR)


## 5.X+57 「**仕様確定 docs PR を先行マージせず**、実装 PR を後追いすると **同一ファイルで JSDoc コンフリクト** が発生する」 ─ PR #367 → PR #368 で実体験 (2026-05-14)

### 罠の正体

仕様確定〜実装の 2 段階リリースで「先に docs だけ更新する PR」と「後で実装する PR」を分けるパターンは整理が効くが、両 PR が **同じファイル (本件は `src/config/suggestion.ts`)** のコメント / 定数を触ると、後発 PR で merge conflict が起きる。本件 PR #368 は `feat/degraded-mode-impl` ブランチを `main` から切ったあとで PR #367 (docs/help-client.tsx + config コメント) が main にマージされ、JSDoc 部分でコンフリクトを起こした。

- 本質: 「docs だけ」だと油断するが、`src/config/*` の **コメントは src 配下の "実装" ファイル** であり、`src/` 以下を両 PR が触ると競合する
- PR #367 は ACTIVE 縮退を「TODO」とコメント、PR #368 はその TODO を実装して同じコメント領域を「実装済」に書き換える → 同行コンフリクト確定

### 検出のしかた

```bash
# 仕様確定 docs PR (= 実装 TODO を明記する PR) と実装 PR の **両方で触れるファイル** を事前に列挙する
gh pr view <docs-pr> --json files -q '.files[].path' > /tmp/docs.txt
gh pr view <impl-pr> --json files -q '.files[].path' > /tmp/impl.txt
sort /tmp/docs.txt /tmp/impl.txt | uniq -d
# ↑ ここに出るファイル (本件は src/config/suggestion.ts) は コンフリクト確定の予備軍
```

`docs/` は方針が衝突しない限り conflict しないので大半は問題ない。**重要なのは `src/config/`、`src/lib/` 配下の "仕様コメント"** で、実装 PR で必ず変更されるため。

### 解消手順 (本 PR #368 で実践)

1. `git fetch origin main && git merge origin/main` で実コンフリクトを発生させる
2. **コンフリクトの両側を読み比べる**: docs PR 側は「TODO」、impl PR 側は「実装済」と書いてある → 両者は時系列で整合する (docs PR が先 = TODO 時点の説明、impl PR が後 = 実装後の説明)
3. **実装 PR 側を採用 + docs PR 側の用語 (PASSIVE / ACTIVE 縮退) を残す** ように手動マージ
4. **実装状況テーブル (TENANT_AND_BILLING.md §34.14.4 H 等) の "⚠️ 未実装" を "✅ 実装済 (PR #368 / ...)" に書き換え** ─ ここを忘れると docs と実装が再び乖離する
5. lint + tsc + test を再実行して検証
6. `git commit` でマージコミット、`git push`

### 横展開で漏らしやすい箇所

| 場所 | 何を更新するか |
|---|---|
| `src/config/*.ts` JSDoc | docs PR が書いた「TODO」を「実装済 (PR #N)」に書き換え |
| `docs/business/*.md` 実装状況表 | 「⚠️ 未実装」を「✅ 実装済」に書き換え |
| `docs/operations/*_RELEASE_NOTES.md` Q&A | 「backfill スクリプト未実装」等の文言を「PR #N で実装」に書き換え |
| `docs/roadmap/V1_FINAL_TASKS.md` | TODO ボックスをチェック (`[ ]` → `[x]`) |
| 既存テスト | 旧仕様 (passive 縮退の score 0.1 等) で書かれた assertion を新仕様 (5:5 = 0.25 等) に更新 |

### 予防策

- **仕様確定 docs PR を立てる時点で、後続実装 PR の有無 / 担当者を決める**: 「いつかやる」では同一ファイルが長期間 TODO のまま放置され、別の修正で意図せず conflict する
- **実装 PR の冒頭で `gh pr view <docs-pr>` を実行**: 直近マージされた仕様 PR があれば、自分の作業ブランチを切るタイミングを `git fetch && git rebase origin/main` で main 同期しておく
- **docs PR 側のレビュー時に「実装 PR で同じ箇所を触るか」を必ず質問する**: docs だけの PR と思って rubber-stamp すると、後発 PR で必ず conflict 確認のラリーが発生する
- **本 KDD パターンを認識する**: 「仕様 docs を一度に揃える」ことのトレードオフ (= 実装 PR の merge コストが上がる) を理解した上で、それでも先行マージするか判断する

### 関連

- PR #367 (docs/degraded-mode-spec): 縮退モード仕様の docs を確定、実装は TODO で残置
- PR #368 (feat/degraded-mode-impl): TODO を実装、PR #367 の docs コメントとコンフリクト
- 同型パターン (末尾追記 conflict): §5.X+30 末尾の「`### 関連` の末尾追記コンフリクト」
- 衝突したファイル: [src/config/suggestion.ts](../../src/config/suggestion.ts) JSDoc 冒頭の「embedding NULL の扱い」段落

## 5.X+58 PR push 前のセルフチェックリストに **`pnpm e2e:coverage-check` を含めないと CI でしか発覚しない** ─ メモリ / feedback ノートに記録するだけでは不十分 (PR #372 で実体験 / 2026-05-14)

### 罠の正体

PR #372 (Tenant.suspendedAt 実装) で、新規 API route 2 本 (`/api/admin/super/tenants/[id]/suspend` と `/resume`) を追加したが、`docs/test/E2E_COVERAGE.md` への追記を忘れて push。

ローカルで実行したセルフチェックは:
1. ✅ `pnpm test` (143 ファイル / 2156 件 PASS)
2. ✅ `pnpm lint` (errors 0)
3. ✅ `pnpm tsc --noEmit` (改修分は型エラー 0)

しかし **`pnpm e2e:coverage-check` は実行していなかった**ため、CI の最初の job (Lint / Test / Build) で:

```
❌ docs/test/E2E_COVERAGE.md に未記載の機能があります:
   - /api/admin/super/tenants/[id]/suspend
   - /api/admin/super/tenants/[id]/resume

対応方法:
   docs/test/E2E_COVERAGE.md の該当セクションにエントリを追加してください。
ELIFECYCLE  Command failed with exit code 1.
```

加えて、coverage-summary.json が生成されないため後続の `davelosert/vitest-coverage-report-action` も連鎖失敗。

### 「メモリに記録があっても発動しない」根本問題

このリポジトリで開発する Claude Code の user memory には、既に [feedback_e2e_coverage_gate.md](C:/Users/SF02512/.claude/projects/.../feedback_e2e_coverage_gate.md) として「新規 route.ts / page.tsx を追加したら pnpm e2e:coverage-check を必ずローカル実行」が登録されていた。

それでも事故が起きた理由:
- メモリは「想起ベース」: 関連キーワード (E2E / coverage / route 追加) が会話に出てこないと自動想起されない
- 今回の PR は「機能追加 → テスト → ドキュメント → コミット → push」の流れで「**lint / tsc / test の 3 点セット**」を機械的に実行し、4 点目 (e2e:coverage-check) を漏らした
- **チェックリストはコード (script) か CI に組み込まないと、人 / AI の認知に頼っている限り必ず漏れる**

### 対応 (= 機械化しないチェックは信用しない)

1. **既存の CI ガードを信頼**: 本ケースは CI が確実に止めてくれるため、最低保証はある (= 本番に流出しない)
2. **ローカル実行は `pnpm` script 集約**: `pnpm pre-push` のようなコマンドで lint / tsc / test / e2e:coverage-check をまとめて実行できるよう script を集約しておく
3. **PR テンプレートに必須項目化**: `.github/pull_request_template.md` の Test plan セクションに `[ ] pnpm e2e:coverage-check` 行を追加し、PR 作成時に必ず目に入るようにする
4. **AI 用の checklist は memory ではなく CLAUDE.md / docs 内のチェックリストに記載**: memory は会話ごとに「想起されるとは限らない」ため、永続的な参照源 (= read される確率の高い場所) に置く

### 推奨スクリプト構成 (= 将来追加候補)

```json
// package.json
{
  "scripts": {
    "pre-push": "pnpm lint && pnpm tsc --noEmit && pnpm test --run --no-coverage && pnpm e2e:coverage-check"
  }
}
```

これで「push する前に毎回 1 コマンド」運用が可能。git hooks (husky) で `pre-push` フックに繋げると更に強固。

### 派生・関連パターン

| 教訓 | 対象 | 機械化方法 |
|---|---|---|
| 新規 route / page 追加時の E2E_COVERAGE.md 追記 | 本 §5.X+58 | `pnpm e2e:coverage-check` (既存 CI ガード) |
| Default テナント / 削除済テナントのフィルタ 3 レイヤ同期 | §5.X+23 / §5.X+30 | サービス層テスト (3 レイヤすべて assert) |
| 仕様 docs PR → 実装 PR の JSDoc コンフリクト | §5.X+57 | 実装 PR 作成時に `gh pr view <docs-pr>` |

このパターン全般に共通する原則: **「人間 / AI の認知に頼る部分」を減らし、「自動的に止まる仕組み」に置き換える**。

### 関連

- PR #372: 本パターン発覚の元 PR (tenant suspend 機能追加)
- 既存 §5.X+22 (PR #327 / PR-1 tenant-i18n): 同型の「新規 route 追加 → E2E_COVERAGE.md 更新」の確立パターン (本 §5.X+58 はそれを補強する立場、= 「memory + チェックリストでも 1 年経つと忘れる」事実)
- 既存 memory: [feedback_e2e_coverage_gate.md](C:/Users/SF02512/.claude/projects/c--Users-SF02512-GitHub-Private-BusinessManagementPlatform/memory/feedback_e2e_coverage_gate.md)

## 5.X+59 **並列 docs PR が同じ README テーブルの末尾に行を追加すると、後発 PR で確実にコンフリクト** ─ §5.X+30 / §5.X+54 の再発 (PR #373 → PR #374 で実体験 / 2026-05-14)

### 罠の正体

`docs/specification/README.md` のような **「ファイル一覧テーブル」を持つ README ファイル** に対し、独立した 2 つの docs PR が並列で **末尾に新規行を追加** すると、後発 PR で必ず 3-way merge conflict が発生する。

具体例: PR #373 (CHAT_SEMANTIC_SEARCH の docs) と PR #374 (STRIPE_PAYMENT_UI の docs) が時間差で進行:

```
共通祖先:
| [SUGGESTION_FEATURE.md](./SUGGESTION_FEATURE.md) | ... |  ← 表の最終行

PR #373 (先発):
| [SUGGESTION_FEATURE.md](./SUGGESTION_FEATURE.md) | ... |
| [CHAT_SEMANTIC_SEARCH.md](./CHAT_SEMANTIC_SEARCH.md) | ... |  ← 追加

PR #374 (後発、main を取り込む前に作成):
| [SUGGESTION_FEATURE.md](./SUGGESTION_FEATURE.md) | ... |
| [STRIPE_PAYMENT_UI.md](./STRIPE_PAYMENT_UI.md) | ... |  ← 追加
```

PR #373 がマージされて main が更新された後、PR #374 で `git merge origin/main` を実行すると:

```
| [SUGGESTION_FEATURE.md](./SUGGESTION_FEATURE.md) | ... |
<<<<<<< HEAD (PR #374 が追加)
| [STRIPE_PAYMENT_UI.md](./STRIPE_PAYMENT_UI.md) | ... |
=======
| [CHAT_SEMANTIC_SEARCH.md](./CHAT_SEMANTIC_SEARCH.md) | ... | (PR #373 がマージ済)
>>>>>>> origin/main
```

両者は内容的には独立した行で、両方とも残せば OK な「無害な conflict」だが、**機械的には解決できない** (= git は意味を理解しない)。

### なぜこれが繰り返し発生するか

- §5.X+30 (= 2026-04 / SUGGESTION_ENGINE 末尾追記)
- §5.X+54 (= 2026-05 / KDD 末尾追記)
- §5.X+57 (= 2026-05-14 / src/config 末尾追記)
- **§5.X+59 (= 2026-05-14 / docs/specification/README.md 末尾追記)** ← 本パターン

**4 回目の再発**。`README.md` のテーブル末尾追記は **発生確率がほぼ 100%** にもかかわらず、Claude Code も人間も「忘れる」 → KDD 化するだけでは効果が薄いことが判明。

### 推奨対応 (段階的)

#### Tier 1: 即時対応 (= 仕様 docs PR を立てる人がやる)

1. **新規 docs PR を立てたら、`/docs/**/README.md` を編集する前に main 同期**:
   ```bash
   git fetch origin main
   git rebase origin/main  # or git merge origin/main
   ```
2. README 編集後はすぐ commit + push (= 競合窓を狭める)
3. PR レビュー期間が長引きそうなら、競合検知のために定期的に main 取込み

#### Tier 2: ファイル構造の改善 (= 抜本的)

README の「ファイル一覧テーブル」を以下のいずれかに置換:
- (a) **glob 自動生成**: `docs/<category>/*.md` を読んでテーブルを自動生成する script + CI チェック
- (b) **テーブルではなくサブセクション** (`### ファイル: SCREENS.md\n説明...` のような独立段落構造) で末尾追記 conflict を減らす
- (c) **PR template で警告**: 「`docs/**/README.md` を編集した場合、main 取込み済みか?」をチェックリスト化

#### Tier 3: 自動化 (= 究極系)

- pre-commit hook で `docs/**/README.md` 変更を検出したら自動 fetch & rebase
- GitHub Actions の job で「merge conflict の予兆」を PR にコメント

### 本 PR (#374) での対処

- conflict 解消: 両方の行 (= CHAT_SEMANTIC_SEARCH + STRIPE_PAYMENT_UI) を残してマージ
- 本 KDD §5.X+59 を追記して、4 度目の再発の事実と段階的対応の方針を明文化
- Tier 2 / Tier 3 の実装は v2 の改善タスクとして切り出し (= 本 PR スコープ外)

### 関連

- §5.X+30: 末尾追記 conflict の初出パターン
- §5.X+54: KDD 自身の末尾追記 conflict (= meta な再発)
- §5.X+57: src/config の JSDoc 末尾追記 conflict
- 本パターンと §5.X+30 / §5.X+54 / §5.X+57 は **同一の根本問題** (= 「末尾追記 = 機械的競合」)
- PR #373 (CHAT_SEMANTIC_SEARCH): 先発 docs PR
- PR #374 (STRIPE_BILLING): 後発 docs PR、本 conflict の発生源

## 5.X+60 **「1 業務操作 = 1 ApiCallLog」ルールが新規エンティティ作成で抜けやすい — プロジェクト作成で 2 件発生し Beginner 上限が実質半分で枯渇 (2026-05-15)**

### 罠の正体

新しいエンティティの作成・更新フローを実装するとき、自動タグ抽出 (Anthropic) と embedding 生成 (Voyage) を **それぞれ独立して `withMeteredLLM` でラップしてしまう** 罠。

`createProject` の旧実装:
```typescript
const autoTagResult = await extractAutoTags({...});  // withMeteredLLM (#1)
const project = await prisma.project.create({...});
await generateAndPersistProjectEmbedding(...);        // withMeteredLLM (#2)
```

結果:
- ApiCallLog に **2 件** レコードが作られる
- `Tenant.currentMonthApiCallCount` が **+2** される
- `costJpy` も **2 回分** 課金される (Expert ¥20 / Pro ¥60 が、ユーザ視点では「1 操作 ¥20 / ¥60」と認識される)
- Beginner プラン月 100 回上限が **実質 50 件** で枯渇する (= ユーザ仕様の半分)

memory に保存していた **「Bulk な LLM 操作は『1 業務操作 = 1 ApiCallLog』に集約する」ルール** (PR #357 で外部 import 経路に適用済) が、平時 CRUD のプロジェクト作成では未適用だった事実が、課金体系フルスキャンで発覚した。

### なぜ発生するか

- `withMeteredLLM` は「LLM 呼出 1 回 = ApiCallLog 1 件」という素朴な対応で実装されており、デフォルトでは「業務操作 1 回 = ApiCallLog 1 件」を強制しない
- サービス層で 2 種類の外部 API (Anthropic / Voyage) を逐次呼ぶ自然な実装が、自動的に 2 件の ApiCallLog を生み出す
- Voyage 専用 `generateBatchEmbeddings` のようなバッチ集約は import 経路でのみ整備されており、平時の create/update では非適用
- 課金根拠データ (ApiCallLog) は法的に重要だが、テナント月間カウンタとは独立した数字なので、UI 表示・テスト・ドキュメント整合の確認が後手に回りやすい

### 推奨対応 (横展開チェック)

新規エンティティの作成・更新フローを書く・レビューする際は以下を自問する:

1. **複数の外部 API を呼んでいるか?** (Anthropic + Voyage 等)
2. それぞれが独立して `withMeteredLLM` を呼んでいないか?
3. 呼んでいる場合、ユーザ視点で 1 業務操作なら **1 度の `withMeteredLLM` ラップ内で全 API を実行** する設計にできないか?
4. 内部 API のどれかが失敗してももう一方が成功すれば「業務として成功」扱いで課金する設計か?
5. 全 inner API が失敗した場合は `throw` で `withMeteredLLM` の `llm_error` 経路に乗せ、課金させない設計か?

実装パターン (`extractTagsAndEmbedForProject` / `generateBatchEmbeddings` 参照):

```typescript
const result = await withMeteredLLM({...}, async ({modelName, requestId}) => {
  let opSucceededCount = 0;
  try { /* Anthropic 呼出 */; opSucceededCount++; } catch { /* log */ }
  try { /* Voyage 呼出 */;    opSucceededCount++; } catch { /* log */ }
  if (opSucceededCount === 0) throw new Error('all inner ops failed');  // 課金なし
  return { result, usage: { ...合算 }, requestId };
});
```

### 本 PR での対処

- `extractTagsAndEmbedForProject()` を [src/services/project.service.ts](../../src/services/project.service.ts) に新設し、`featureUnit='project-upsert'` で 1 度だけ `withMeteredLLM` をラップする実装に集約
- `createProject` / `updateProject` 両方で旧 `extractAutoTags` + `generateAndPersistProjectEmbedding` の二重ラップを廃止
- 旧 featureUnit (`auto-tag-extract` / `project-embedding`) は backfill 経路の互換のため metered.ts では受理を残す
- 仕様書 [docs/business/TENANT_AND_BILLING.md §34.14.2](../business/TENANT_AND_BILLING.md) で「プロジェクト作成 = 1 回」を明文化
- 単体テスト追加 ([src/services/project.service.test.ts](../../src/services/project.service.test.ts)): `withMeteredLLM.toHaveBeenCalledTimes(1)` で 1 件集約を assert

### 関連

- memory: `feedback_bulk_llm_call_unit.md` (PR #357 で外部 import に適用された同ルール)
- PR #357 (2026-05-14): `generateBatchEmbeddings` で外部 import の bulk 集約を実装
- 本 PR (2026-05-15): 平時 CRUD (プロジェクト作成・更新) に同ルールを横展開

## 5.X+61 **「公開範囲: 自分のみ」の DB 表現が資産種別ごとに違う — Knowledge/RiskIssue/Retrospective は 'draft'、Memo は 'private' (2026-05-15)**

### 罠の正体

「公開範囲: 自分のみ」と「公開範囲: 全メンバー」というユーザ向け概念は、DB スキーマ上ではエンティティ種別ごとに異なる文字列で表現されている:

| エンティティ | 「自分のみ」 | 「全メンバー」 |
|---|---|---|
| Knowledge | `visibility='draft'` | `visibility='public'` |
| RiskIssue | `visibility='draft'` | `visibility='public'` |
| Retrospective | `visibility='draft'` | `visibility='public'` |
| **Memo** | **`visibility='private'`** (← 異なる!) | `visibility='public'` |

embedding 生成の skip 条件 / 提案エンジンのスコープ条件を実装するとき、`visibility !== 'draft'` という条件で全資産を統一的に書くと **Memo だけ意図と逆の挙動になる** (Memo の private がスキップされず、Memo の draft が誤ってマッチする)。

### なぜ発生するか

- Memo は PR #70 で「タグを持たない個人ノート」として後発で追加され、Schema は他資産に揃えずに `private`/`public` の独自値を採用
- `Memo` モデル定義 (`prisma/schema.prisma`) の `visibility @default("private")` が Knowledge/RiskIssue/Retrospective の `@default("draft")` と異なる
- 「自分のみ = draft」と覚えていると、Memo を追加するときに無意識に同じ条件を書いてしまう

### 推奨対応 (横展開チェック)

エンティティ種別を跨いで visibility による条件分岐を書くときは:

1. 対象エンティティの schema.prisma 定義を **確認してから** 条件式を書く
2. 「公開範囲: 自分のみ」相当の文字列が複数ある場合、定数化 or `visibility !== 'public'` のような **「公開しているもの以外」反転条件** で書く
3. テストで visibility 別の API 呼出有無を必ず両方検証する (draft / private / public / その他)

### 本 PR での対処

- Memo の `createMemo` / `updateMemo` では `visibility !== 'private'` を embedding 生成の判定軸に採用
- 月初 backfill cron ([src/services/embedding-backfill.service.ts](../../src/services/embedding-backfill.service.ts)) では Memo は `visibility = 'public'` でフィルタ (= 他資産は `visibility <> 'draft'`)
- 仕様書 ([docs/business/TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md)) に「Knowledge/RiskIssue/Retrospective: `visibility='draft'` / Memo: `visibility='private'`」を併記

### 関連

- memory: `feedback_visibility_embedding.md` (visibility='draft' のエンティティには embedding 生成しない)
- prisma/schema.prisma: `Memo.visibility @default("private")` (line 1165)
- prisma/schema.prisma: `Knowledge.visibility` / `RiskIssue.visibility` / `Retrospective.visibility` は `@default("draft")`

## 5.X+62 **提案候補化に state 等の追加条件があるエンティティでは、作成・更新時の embedding 生成判定もその条件で絞る (RiskIssue state='resolved' / 2026-05-15)**

### 罠の正体

`visibility='public'` だけで embedding 生成を判定すると、提案エンジンが **さらに別軸でフィルタしているエンティティ** では「embedding を作ったのに永遠に検索されない」浪費が発生する。

具体例: RiskIssue。提案エンジン ([src/services/suggestion.service.ts](../../src/services/suggestion.service.ts)) は過去課題・過去リスクの候補化条件として **`state='resolved'`** を必須にしている (= 「過去に解消された学び」のみ次案件の参考になる、という設計判断)。

```typescript
// suggestion.service.ts
const issues = await prisma.riskIssue.findMany({
  where: {
    type: 'issue', state: 'resolved', visibility: 'public',
    // ...
  },
});
```

ところが旧 `createRisk` / `updateRisk` は **`visibility !== 'draft'` だけで** embedding を生成していた:

```typescript
// 旧実装
if (r.visibility !== 'draft') {
  await generateAndPersistEntityEmbedding({ ... });
}
```

結果:
- `state='open'` で `visibility='public'` のリスクを起票 → embedding 生成 (Voyage 課金) → 提案エンジンには乗らない (state filter で落ちる)
- 解消するまで text を編集すると毎回 embedding 再生成 → 全部ゴミ
- 解消されずに deletedAt → 課金分が完全に無駄

中規模テナント (月間 20 件、半分が中途状態で公開化) で **月 ¥120〜360** の無駄、年間 **¥1,500〜4,500** のコスト発生。

### なぜ発生するか

- 「visibility = 提案候補化条件」と思い込みやすい (Knowledge/Retrospective/Memo はそう)
- RiskIssue だけ提案候補化に `state='resolved'` の追加条件があるが、create/update 時に意識されにくい
- `state` フィールドは「業務的に処理が進む」軸であり、コード上で embedding 判定と結びつけるのは非直観的
- 提案エンジン側 (read path) と embedding 生成側 (write path) の整合性が「同じ場所で書かれていない」ため、片方修正時にもう片方が漏れる

### 推奨対応 (横展開チェック)

エンティティが提案エンジンの候補化フィルタに **`visibility` 以外の WHERE 条件** を持つ場合、以下も embedding 生成判定に組み込む:

1. **suggestion.service.ts の `where` 句を read してから判定を書く**
2. 提案候補化条件 (例: `state='resolved'`) を満たす **遷移時** に embedding を生成 (初回 embedding 化)
3. 既に条件を満たしている状態で対象 text が変更されたとき、再生成
4. 条件を満たさなくなる遷移 (例: `resolved` → `open` 再オープン) では既存 embedding を保持 (削除しない、提案エンジン側 filter で除外される)
5. **月初 backfill cron** の WHERE にも同じ条件を反映 (= NULL 補完対象を一致させる)
6. **外部 import** で当該条件を満たさない行 (例: state='open' で import) も batch から除外
7. **「なぜ?」説明文 (suggestion-explanation.service.ts)** の `loadCandidate` でも同条件を WHERE に強制 (= API 直叩きで state='open' な id が来ても候補拒否)

### 本 PR での対処

- `src/services/risk.service.ts`:
  - `createRisk`: `r.visibility === 'public' && r.state === 'resolved'` のときのみ embedding 生成 (通常 create は state='open' 既定なので生成されない、import 経由など resolved 直接生成のみ embedding)
  - `updateRisk`: `existing.state` を select に追加し、state 遷移マトリクスに従って判定
    - state: open→resolved への遷移 (becameResolved) → text 変更不要で生成
    - state: resolved→resolved + text 変更 → 再生成
    - state: resolved→open (再オープン) → 生成しない (既存保持)
- `src/services/embedding-backfill.service.ts`: 月初 cron の risks_issues WHERE に `state='resolved'` 追加 (collectNullEmbeddingItems / countNullEmbeddings の両方)
- `src/services/external-data-import.service.ts`: import 行に `state!='resolved'` があれば batch から skip + embeddingSkippedDraft +1
- `src/services/suggestion-explanation.service.ts`: `loadCandidate` の issue/risk ケースに `state: 'resolved'` を WHERE 強制
- 単体テスト: 6 ケースの state 遷移マトリクスを risk.service.test.ts に追加

### 関連

- memory: `feedback_visibility_embedding.md` (visibility='draft' のエンティティには embedding 生成しない) — 本 KDD は state 軸への拡張
- suggestion.service.ts: `where: { type: 'issue', state: 'resolved', visibility: 'public' }`
- 同様パターンの将来候補: 「Retrospective に `conducted` 状態が追加される」「Knowledge に `approved` 状態が追加される」場合は同じく state 軸の embedding 判定が必要

## 5.X+63 **作成時の入力が全空文字でも LLM を呼んでしまう罠 (Project 全空 text → Anthropic 課金 / 2026-05-15)**

### 罠の正体

`createProject` / `updateProject` の `extractTagsAndEmbedForProject()` は purpose / background / scope の text を Anthropic auto-tag + Voyage embedding に渡すが、**全 3 フィールドが空文字でも `withMeteredLLM` を呼び出す** 実装になっていた。

- Voyage 側は `willCallEmbedding = embeddingText.trim().length > 0` で skip (OK)
- **Anthropic 側はガードなし** で常に呼出 (NG)

Anthropic は空入力に対しても空タグ JSON `{businessDomainTags:[], techStackTags:[], processTags:[]}` を正常返却するため、**`withMeteredLLM` の callback は成功** → ApiCallLog 1 件発行 + Tenant counter +1 + costJpy 1 回分課金。

ユーザ価値ゼロ (空タグが返るだけ) なのに課金が発生する。

### なぜ発生するか

- 「embedding 側でガードしているから OK」と読み流しがち
- Anthropic の auto-tag は「user 入力が空でもエラーにならず動く」性質を持つため、テストでも検出されにくい
- 空入力でプロジェクトを作るユースケース (テンプレート保存、ドラフト挙動の保存) は実運用で発生する

### 推奨対応

`extractTagsAndEmbedForProject()` の冒頭で 3 フィールドの空チェックを行い、すべて空なら **`withMeteredLLM` 自体を呼ばずに早期 return**:

```typescript
const hasAnyContent =
  args.purpose.trim().length > 0 ||
  args.background.trim().length > 0 ||
  args.scope.trim().length > 0;
if (!hasAnyContent) {
  return { tags: null, embedding: null };
}
```

これで:
- Anthropic も Voyage も呼ばれない
- ApiCallLog 0 件、counter / costJpy も増分なし
- 本体 INSERT/UPDATE は通常通り続行 (= ユーザ操作は成功扱い、ただし AI 処理は無し)

### 本 PR での対処

- `src/services/project.service.ts` の `extractTagsAndEmbedForProject()` に `hasAnyContent` ガードを追加
- `src/services/project.service.test.ts` に 3 ケース追加:
  - 3 フィールド全空 → `withMeteredLLM` 呼ばれない
  - 1 フィールドのみ非空 → `withMeteredLLM` 呼ばれる (= 早期 return しない)
  - 3 フィールド全空白のみ (タブ/改行/全角空白) → `withMeteredLLM` 呼ばれない

### 関連

- 削減見積もり: 月 ¥20〜50 程度 (テンプレ作成等の限定ケース) — 大きくないが実装コストもほぼゼロなので「ついで」に削減
- 同型の罠を防ぐ一般則: **外部 API を呼ぶ前に「入力が空かどうか」をチェックする習慣をつける** (空入力 = ユーザ価値ゼロ ≒ 課金回避可能)

## 5.X+64 **価格・定数の一括変更で「UI 表示文字列のテスト」が unit test grep から漏れる ─ Playwright spec の `toContainText('3,000')` が旧価格のまま CI で fail (2026-05-15)**

### 罠の正体

- PR #388 で per-API-call 単価を改定 (Expert ¥10→¥5 / Pro ¥30→¥15) する際、`pricePerCallHaiku` / `pricePerCallSonnet` を schema / migration / service / docs / mock 値 / CSV 行 (`',1500,'`) まで一通り更新したが、Playwright spec の **UI テーブル行アサーション** だけが旧値で残り、CI E2E が 1 件 fail。
- 該当箇所:
  ```ts
  // e2e/specs/13-super-admin-dashboard.spec.ts:141 (修正前)
  await expect(tenantARow).toContainText('3,000'); // 当月 LLM 費用 ¥3,000
  ```
  Fixture は `current_month_api_cost_jpy = 1500` に更新済 (= 300 calls × ¥5)、UI も `toLocaleString()` で `¥1,500` を描画する状態。**テスト側だけが旧 ¥3,000 を期待** していたため失敗した。

### なぜ発生するか

1. **複数表記の存在**: 同じ「価格 1500」が 3 通りで現れる。
   - 生値: `1500` (fixture SQL, CSV row)
   - 表示文字列: `1,500` / `¥1,500` (UI、`toLocaleString()`)
   - JSDoc / コメントの自然文: `¥1500` / `¥1,500`
   - **旧→新の grep を「旧の生値」だけで回すと、表示文字列側 (`3,000`) を取り逃す**。
2. **検証経路の盲点**: `pnpm test` (Vitest unit) と `pnpm e2e:coverage-check` は通っても、**Playwright spec のテキスト一致アサーションは CI まで走らない**。ローカル人間駆動だと "全テスト pass = 安心" と誤認する。
3. **過去の同型を踏襲**: §5.X+30 系で何度も指摘されている「片側 grep の罠」と本質同じ。

### 推奨対応 (横展開チェック)

価格・閾値・列挙値など **「同一意味の値が複数の文字列表現で現れる定数」** を一括変更したら、必ず以下を全部 grep:

| 対象 | grep パターン例 (旧 ¥10/call → ¥5/call の場合) |
|---|---|
| 生値 (DB / CSV / fixture) | `\b10\b` `\b30\b` `\b3000\b` `\b22500\b` ... |
| `toLocaleString` 表示文字列 (UI / Playwright) | `'3,000'` `'¥3,000'` `'¥30,000'` |
| 自然文 (JSDoc / docs / LP) | `¥10/call` `¥30/call` `10 円/call` `30 円/call` |
| マスター定義 (schema / migration / config) | `@default(10)` `@default(30)` `pricePerCall` |
| アサーション系 (テスト) | `toContainText` `toContain.*[0-9],` `expect.*¥` |

ローカル検証で **`pnpm test` の pass で確信せず、価格・UI 文字列を変えた PR は `pnpm test:e2e` (該当 spec だけでも) をローカルで走らせる**。最低限 grep スコープを `e2e/specs/` まで広げる。

### 本 PR での対処

- `e2e/specs/13-super-admin-dashboard.spec.ts:141` の `'3,000'` → `'1,500'` に修正、コメントも `¥1,500 (300 calls × ¥5)` で改定後仕様を明記。
- 横展開 grep (`toContainText.*[0-9],` / `toContainText\(['"]3,?000` / `22,?500` / `30,?000`) で他 spec に同種残留なしを確認。

### 関連

- 似た罠: §5.X+30〜+35 系の「片側 grep / 同名重複 / 表記揺れ」テーマ。
- 検証の盲点: §3.X+58 系の「lint/tsc/test/build の 4 点セットには含まれない別 CI ガード」。Playwright もここに含めるべき。
- 一般則: **「ユーザに見える数値文字列」と「DB の生値」は別物として grep 対象を分ける**。表示層は `toLocaleString` でカンマが入るため、生値検索だけでは網羅できない。


## 5.X+65 **複数 PR 並行進行時に同一ファイルを変更する場合は事前の rebase 計画が必須 ─ docs/business/README.md で PR #391/#392 が衝突 (2026-05-17)**

### 罠の正体

- 人間駆動運用への切替準備で、複数の独立した小さい PR を並行進行させていた:
  - PR #391: C1〜C5 + D3〜D6 の運用ドキュメント追加 (5/15-5/16 着手、5/17 マージ)
  - PR #392: ドキュメント整理 Phase 1 (archive 再新設 + 横断索引、5/17 着手)
- PR #391 が先にマージされた直後、PR #392 で **`docs/business/README.md` のコンフリクト** が発生:
  - PR #391 が「ファイル一覧」表に `FEATURE_CATALOG.md` 行を追加 (`新規 (2026-05-16)`)
  - PR #392 が「ファイル一覧」表の **直後** に「横断索引: Stripe / 課金関連」「横断索引: 提案エンジン関連」を追加
  - 両方とも GLOSSARY.md 行の直後を編集対象としたため、git は両方を残せず conflict marker を出した
- 内容的には **両方の変更が必要** (FEATURE_CATALOG 行は active な索引、横断索引はそれを補完) のため、片方を捨てる選択肢はない。

### なぜ発生するか

1. **役割別 README はホットスポット**: `docs/<area>/README.md` は新規ファイル追加のたびに索引行が増える。複数 PR が同時に「索引追加」を行うと容易に衝突する。
2. **「末尾追記」を異なる粒度でやると衝突する**: PR #391 は「表に 1 行追加」 (末尾の表内追記)、PR #392 は「表の後に新セクション追加」 (ファイル末尾追記)。どちらも「ファイル末尾付近の編集」だが、編集対象範囲が **重なる**ため git が autoresolve できない。
3. **本 KDD の §5.X+30 系「2 段構え PR の docs コンフリクト」と同型**: 仕様確定 docs PR → 実装 PR の時のコンフリクトパターンが、今回は「機能追加 docs PR → ドキュメント整理 PR」で再現した。

### 推奨対応

#### 着手前 (PR 設計時)

1. **`gh pr list --search "in:title docs"` で進行中の docs PR を確認**: 進行中の他 PR が同一ディレクトリを触っているなら、マージ順を事前に取り決める
2. **README の編集箇所が重なる可能性が高い場合は、片方を完了させてから着手** する (並行進行を諦める判断)
3. **どうしても並行進行する場合は、編集対象セクションを明示的に分ける**:
   - PR A: 表の中身を変更 (新規行追加)
   - PR B: ファイル末尾に新セクション追加 (表の外)
   - この場合でも「表の最終行」と「新セクション開始」の境界で衝突しうるため、空行を 2 行入れる等の防衛策が有効

#### 衝突発生後 (rebase 時)

1. **`git rebase origin/main`** で conflict を表面化
2. **conflict marker (`<<<<<<<` / `=======` / `>>>>>>>`)** を確認、**両側の変更を残す** (普通は両方必要)
3. 解消後 `git add <file>` → `git rebase --continue`
4. **`git rebase --continue` が `You must edit all merge conflicts` で止まる場合の対処**:
   - 実際には conflict が残っていないことを `git diff --diff-filter=U --name-only` で確認
   - ワークツリーの **非関連の uncommitted 変更 (例: .claude/settings.json)** が rebase を妨げているケースがある → `git stash push <file>` で stash してから `git rebase --continue`
   - エディタを開かせない場合は `GIT_EDITOR=":" git rebase --continue` で no-op editor を使う

#### 一般則 (本サービスでの運用)

- **同一 README を 2 つの PR で同時に触る予定があるなら、PR description に注意書きを書く** (例: "本 PR は PR #391 のマージ後に rebase が必要")
- **「索引行追加」だけなら `docs:` プレフィックスで小粒に分ける** ことでマージ待ち時間を短縮し、衝突期間を最小化
- **メンバー追加時の教育ポイント**: rebase コンフリクトの対処は最初の壁になるため、本エントリを参照させる

### 検証経路

- 本ケースで CI は通常通り通っていた (lychee リンクチェッカーも green)。
- conflict は **GitHub PR 画面で目視確認するまで気づきにくい** ため、PR マージ後は他の open PR の `mergeStateStatus` を `gh pr list --json mergeStateStatus` で確認する習慣を持つ。

### 過去の関連 KDD

- §5.10 / §5.14: マージコンフリクトの一般パターン (末尾追記の衝突)
- §5.X+30 系: 2 段構え PR (docs PR → 実装 PR) の docs/business/README.md コンフリクト

## 5.X+66 **NextAuth v5 + @netlify/plugin-nextjs では `useSession().update()` の Set-Cookie がブラウザに反映されない ─ Vercel → Netlify 移行で MFA・テーマ・i18n が同時に壊れた (PR #395 / PR #396 で実体験 / 2026-05-18)**

### 罠の正体

- Vercel Hobby の商用利用不可問題で Netlify Starter に移行 (PR #394) した直後、複数の機能が同時に「DB は更新されているが画面に反映されない」状態に陥った:
  - **テーマ変更**: 設定画面でダークテーマを選択 → DB は `dark` だが `<html data-theme="light">` のまま (PR #395)
  - **MFA TOTP 検証**: コード入力成功 → `/login/mfa` に戻されるループ (super_admin の場合ログイン不能、想定)
  - **テナント TZ/Locale 変更**: 保存後も SSR が古い値で描画
- 全てに共通する仕組み: **クライアントが `useSession().update({ X: ... })` を呼び、NextAuth が `POST /api/auth/session` でレスポンスに `Set-Cookie` を返す経路**を使っていた。
- 現象: **DB 更新 ✓ / クライアント側 React state 更新 ✓ / 新しい `__Secure-authjs.session-token` cookie だけがブラウザに届いていない** → 次のリクエストで古い JWT が送られる → SSR / middleware が古い値を読む。
- F5 (フルリロード) や `router.refresh()` でも回復せず (= cookie 自体が更新されていないため)。

### なぜ発生するか

- **`useSession().update()` の Set-Cookie 経路が Netlify の Function 応答パイプラインで吸収される** (一次ソース未検証だが、`POST /api/auth/session` のレスポンスにつく `Set-Cookie` ヘッダだけがブラウザに届かない事象を複数機能で再現確認)。
- 同じ NextAuth ハンドラでも、**ログイン時の Set-Cookie は正常**に届く (= cookie set そのものが壊れているわけではなく、`/api/auth/session` 経由が特殊)。
- Vercel 環境では同じコードで動いていたため、レビュー / E2E / 単体テストの**いずれでも検出できなかった**。

### 推奨対応

#### 即時 (本サービスでの fix)

1. **テーマのような中継不要な値**: PATCH ルートが直接「専用 cookie (`tasukiba-theme` 等) を Set-Cookie」する設計に切替 (PR #395)。SSR layout は `cookies().get('tasukiba-theme')` を JWT より優先して読む。
2. **JWT に乗せたままにしたい値 (mfaVerified / timezone / locale)**: API route が **NextAuth の encode/decode (`next-auth/jwt`) で JWT を直接再署名 + Set-Cookie** する設計に切替 (PR #396、`src/lib/auth-jwt-helper.ts`)。クライアント側の `useSession().update()` は削除。

#### 設計原則

- **「`useSession().update()` を新規コードで使わない」を本サービスの方針として確定**。同等の更新は以下のいずれかで実現する:
  - **専用 cookie**: 値が独立で、`useSession()` で読まれていない場合 (= SSR / middleware のみが読む)。例: テーマ
  - **JWT 直接再署名**: middleware / useSession / SSR の複数経路で読まれる場合。`reissueAuthJwtOnResponse(req, res, patch)` ヘルパに集約
- **JWT 再署名時に許可する claim は型で絞る** (`JwtReissuePatch` 型)。`tenantId` / `id` / `systemRole` 等の機密 claim は patch 対象外にして改竄経路を作らない。
- **テストで `set-cookie` ヘッダの存在を必ず assert する** (デグレ検出)。route テスト + helper の単体テストの両方で確認する (PR #396 では合計 26 ケース追加)。

#### 引き継ぎチェックリスト (他 NextAuth + Netlify 環境)

新規に `useSession().update()` パターンを見つけたら以下の手順:

1. `grep -rE "useSession\(\)\.update|updateSession" src/` で全箇所を列挙
2. 各箇所の用途を分類: 専用 cookie で良い / JWT 再署名が必要
3. 該当 route handler に `reissueAuthJwtOnResponse` を追加、クライアント側の `update()` は削除
4. `auth.config.ts` の jwt callback `trigger === 'update'` ハンドラは**残しておく** (将来 NextAuth / Netlify 側で fix された場合の二段構え)
5. route テストに「`set-cookie` が含まれる」assertion を追加

### 検証経路

- **症状の最終確認は View Source の `<html data-theme="..."` / `<html lang="..."` 属性で実施可能** (JWT 内容が SSR 出力に直接表れる属性が存在する場合)。
- 修正後の検証: ローカル `pnpm dev` では完全再現できない (Netlify Function ランタイムでのみ発生)。**Netlify Deploy Preview** で実機確認することが推奨手順 (KDD §5.X+58 と同方針)。
- `reissueAuthJwtOnResponse` の単体テストは `src/lib/auth-jwt-helper.test.ts` で「既存 claim が消えない」「許可外 claim は無視」をカバー。デグレ検出ライン。

### 過去の関連 KDD

- §5.X+58: ローカル単体テストで検出できない CI 専用ガード (E2E coverage) の話。本件も**ローカル単体ではなくクラウド環境で初発覚**したという点で同型
- §5.X+57: 環境差異が顕在化する PR 順序問題 (docs PR → 実装 PR)。本件は「Vercel → Netlify 移行」が引き金

## 5.X+67 **`useSession().update()` を削除する PR は、E2E が `POST /api/auth/session` を await している箇所も同時に削除しないとタイムアウトで CI が落ちる + CodeQL の "user-controlled bypass" は条件分岐内の sensitive action 呼出しを単一出口に集約することで構造的に解消できる (PR #396 で実体験 / 2026-05-18)**

### 罠の正体

§5.X+66 の対応 (`useSession().update()` 削除 + サーバ側 JWT 再署名) を PR #396 で実装したところ、ローカル全 quality gate (lint / test / build) は green だったが **PR レビューで 2 種類の CI 失敗が発覚**した:

1. **Playwright E2E (Step 2b)**: テストが旧仕様前提で `page.waitForResponse('/api/auth/session', POST)` を 10s 待っていた。PR #396 で update() を削除したため当該リクエストが永遠に来ず、テストがタイムアウトで fail。
2. **CodeQL** ("This condition guards a sensitive action, but a user-provided value controls it." × 2 高 severity): `body.code` / `body.recoveryCode` (user-provided) が直接 `reissueAuthJwtOnResponse` 呼出しをガードする構造になっていた。条件分岐内の sensitive action 呼出しを「user-controlled bypass」と判定された。

### なぜ発生するか

#### E2E 側

- 当時の MFA 検証フロー (PR #67) は **2 段階の API 呼出し** (`verify` → `session update`) で、片方だけ await すると `window.location.href` の遷移が間に合わず flake った経緯がある (LESSONS §4.18 / §4.24)。
- PR #396 でクライアントの `update()` 呼出しを削除した瞬間、`POST /api/auth/session` の発火源が消滅。テスト側がこの API を待ち続けるとタイムアウトで fail する。
- ローカル単体テストでは `useSession().update()` を mock しているため発覚しない。**E2E は Playwright を回す PR レビューでしか踏まない**。

#### CodeQL 側

- 旧コードは `route.ts` が `JSON 応答のみ` (sensitive action なし) で、CodeQL は条件分岐をスルーしていた。
- PR #396 で「条件分岐内に Set-Cookie する `reissueAuthJwtOnResponse` 呼出しを追加」した結果、CodeQL は user-input `body.code` / `body.recoveryCode` が sensitive action 経路を分岐させていると判定。
- **`verifyTotp` / `compare` による validation gate を CodeQL は認識しない**。コードの「validation 後の sensitive action」というセマンティクスは、構造的に「validation 結果 (boolean / outcome 型) でガード」する形に書き換えないと CodeQL に伝わらない。
- **★ 1 度目の single-exit refactor では不十分**: 検証関数 (`verifyTotpPath` / `verifyRecoveryPath`) を抽出して reissue を関数末尾の 1 箇所に集約しても、**main 関数内に `if (body.code)` / `else if (body.recoveryCode)` の分岐が残っていれば** CodeQL は依然として user-controlled bypass と判定する (PR #396 で実体験、line 75/77 で再警告)。
- **2 度目の refactor (完全分離) で解消**: body.X による分岐を **main 関数から完全に排除** し、`dispatchMfaValidation(body, t)` などのヘルパ関数内に閉じ込める。main 関数は `outcome.kind === 'error'` という validation 結果のみで分岐させる。これにより CodeQL の taint flow が関数境界で validation gate に置換され、警告が消える。

### 推奨対応

#### 着手前の予防策

- **`useSession().update()` を削除する PR では必ず `e2e/specs/` と `e2e/fixtures/` を全 grep**:
  ```bash
  grep -rE "api/auth/session|/api/auth/session" e2e/
  ```
  該当 wait があれば**同 PR 内で削除**する。残すと CI で必ず timeout する。
- **sensitive action (Set-Cookie / signed JWT / encrypted token 等) を route handler に追加する PR では、CodeQL を意識した構造を最初から採用**:
  - 検証ロジックを `verifyXxxPath(body): Promise<VerifyOutcome>` のような関数に分離
  - 戻り値型を `{ kind: 'success' } | { kind: 'error'; response }` の判別 union に
  - sensitive action 呼出しは関数末尾の **1 箇所**に集約し、`outcome.kind === 'success'` でガード
  - **★ さらに**: `if (body.X)` / `else if (body.Y)` の分岐自体も `dispatchValidation(body)` のような**ヘルパ関数に完全分離**する。main 関数からは user input に基づく分岐を一切見せず、validation 結果 (kind: 'success' / 'error') だけで sensitive action を gate する。これにより CodeQL の interprocedural taint analysis が関数境界で停止し警告が消える。
- ローカルでも CodeQL を簡易に再現したい場合: `gh api repos/<owner>/<repo>/check-runs/<id>/annotations` で PR 起票後の警告を確認 (push 後 1-2 分)

#### refactor で消えない場合の最終手段: alert の dismissal

CodeQL は interprocedural taint を追跡するため、ヘルパ関数への分離でも追跡しきれる場合がある。3 度目の refactor でも警告が残るようなら **GitHub Security タブから dismissal**:

```bash
# PR の CodeQL alert 番号取得
gh api repos/<owner>/<repo>/code-scanning/alerts \
  --jq '.[] | select(.most_recent_instance.ref | endswith("<branch>")) | {n: .number, rule: .rule.id, path: .most_recent_instance.location.path, line: .most_recent_instance.location.start_line}'

# False positive として dismiss
gh api repos/<owner>/<repo>/code-scanning/alerts/<N> -X PATCH \
  -f state=dismissed \
  -f dismissed_reason=false_positive \
  -f dismissed_comment="<理由を明記。例: 検証ゲート (verifyTotp / bcrypt.compare) が ...>"
```

Dismissal の使用条件:
- **真の false positive のみ**: 実コードが secure であることを別途レビューで確認済であること
- **理由を必ず明記**: 将来のレビュー者・監査者が判断を追跡できるように
- **横断罠**: 同じパターンが repo の別箇所で再発する可能性。検出時の対応手順を本 KDD に残しておく

#### 発生後の対処

1. **CI fail を早期発見**: PR 起票後 5 分以内に `gh pr checks <PR#>` を確認。fail があれば即時調査する習慣 (CI fail を放置するとマージできず 6/1 期限に影響)
2. **E2E timeout が `waitForResponse` 起因の場合**: ほぼ確実に「コードから当該 API 呼出しが消えた」が原因。spec / fixture の wait も削除する
3. **CodeQL "user-controlled bypass" が出た場合**: 条件分岐内の sensitive action を単一出口に refactor する (本 PR の `verifyTotpPath` / `verifyRecoveryPath` 抽出が前例)

#### 検証経路

- 修正 push 後、`gh pr checks 396 --watch` で再 CI を確認
- E2E は Playwright のローカル実行 (`pnpm test:e2e`) で MFA 経路を踏むテスト (`01-admin-and-member-setup.spec.ts Step 2b`) を事前回帰可能。Docker DB 立ち上げが要るので CI 任せが多いが、本 PR 規模の変更では手元で 1 回回すのが安全

### 過去の関連 KDD

- §5.X+58: CI 専用ガード (E2E coverage check) の罠。本件も「ローカルで通って CI で fail」の典型
- §5.X+66: 本件の前提となる Netlify + NextAuth Set-Cookie 問題。本エントリは「その fix を E2E + CodeQL に整合させる」付随作業の記録

## 5.X+68 **「DB 更新成功 + cookie 再署名サイレント失敗 = 200 OK」の組合せは無限ループを生む ─ helper の戻り値型を boolean から判別 union に格上げして呼出側に強制 check させる (PR #397 で実体験 / 2026-05-18)**

### 罠の正体

PR #396 で導入した `reissueAuthJwtOnResponse(req, res, patch)` の初版は失敗時に `false` を silent return する設計だった (theme cookie 同様の安全側設計を意図)。
本番デプロイ後、MFA 検証画面で「正しい TOTP コードを入れてもダッシュボードに辿り着けない」事象が発生:

1. ユーザが TOTP コード入力 → `POST /api/auth/mfa/verify`
2. サーバが `verifyTotp()` で DB 検証 ✓ 成功
3. `reissueAuthJwtOnResponse(req, res, { mfaVerified: true })` 呼出し
4. ヘルパが decode 失敗 (原因不明) で **silent `false` return**
5. route は **200 OK + 何も Set-Cookie せず** を返す
6. クライアントは `window.location.href = callbackUrl` で遷移
7. middleware が旧 JWT (mfaVerified=false) を読み `/login/mfa` にリダイレクト
8. ループ (5-7 を永遠に繰り返し)

ユーザは正しいコードを入れているのに通れない、という UX 上致命的な状態。

### なぜ発生するか

- **`return false` 設計の意図は良かった**: 元々は「もし再署名できなくても DB は正しく更新されているので、次回ログインで自然回復する」という安全側 fallback。
- **しかし MFA は特殊**: middleware が JWT を直接読んで `/login/mfa` への redirect を決めるため、cookie 更新失敗 = MFA 検証が永遠に成立しない。
- **theme cookie とは性質が違う**: theme は SSR の `<html data-theme>` を決めるだけで、失敗しても「次回まで色が変わらない」程度。MFA は「失敗するとログインできない」。同じ helper の同じ失敗が、claim によって致命度がまったく違う。

### 推奨対応 (本 PR で確立)

1. **Helper の戻り値型を boolean から判別 union に**:
   ```ts
   export type ReissueResult =
     | { ok: true }
     | { ok: false; reason: 'cookie_missing' | 'decode_failed' | 'encode_failed' };
   ```
2. **呼出側で失敗を必ず check + 5xx で通知**:
   ```ts
   const r = await reissueAuthJwtOnResponse(req, res, patch);
   if (!r.ok) {
     return NextResponse.json({error: {code: 'MFA_SESSION_REFRESH_FAILED', reason: r.reason}}, {status: 500});
   }
   ```
3. **ただし claim による criticality 差は設計判断**:
   - **致命 (= middleware 経路) — MFA / mfaVerified**: 失敗時 5xx を返してクライアントにエラー表示。ユーザに再ログインを案内
   - **非致命 (= 表示だけ) — i18n / timezone / locale**: DB は成功扱いで 200 を返しつつ `X-Jwt-Refresh-Failed` レスポンスヘッダで警告。次回ログインで自然回復
4. **診断ログを `console.error` で必ず出す**: Netlify Functions logs に記録され、`netlify logs` で確認可能。`reason` + `nodeEnv` + `availableCookieNames` 等の context を添える

### 検証経路

- 単体テスト: helper の `{ ok: false, reason: ... }` パターンを判別 union ごとに assert (`src/lib/auth-jwt-helper.test.ts`)
- 単体テスト: route の reissue 失敗時 5xx を assert (`src/app/api/auth/mfa/verify/route.test.ts` の `★ TOTP 検証成功でも reissue 失敗時は 500` ケース)
- 実機: Netlify production で `netlify logs --tail` を見ながら MFA 検証フローを実行、`[auth-jwt-helper] reissue_failed` ログが出ないことを確認

### 一般則

「**サーバが成功と判断したがクライアントが古い状態のまま** という状態は、ループや UX 破綻の温床」。次の設計時にチェック:

- Cookie / Header / Body の更新を「サーバ側成功 + クライアント反映失敗」で起こす可能性があるか
- 反映失敗時に **次のリクエストが古い状態で処理される** か (= ループ要因)
- そうなら、サーバ側で必ず失敗を 5xx で通知し、クライアントが retry / 再ログイン誘導できるようにする

### 過去の関連 KDD

- §5.X+66: 本件の前提 (Netlify + NextAuth Set-Cookie 不達)。本エントリは「サーバが silent failure を許してはいけないケース」を整理
- §5.X+58: CI 専用ガードの罠。本件は「ローカル単体テストで通るが本番でループする」という別種の "CI と本番の乖離"

### 後日判明した真因 (PR #398 追跡調査 / 2026-05-18)

PR #397 のサイレント失敗→明示通知化の後、Netlify Functions logs で実観測した結果、reissue 失敗は **`decode_failed` が原因** だった。さらに掘ると **cookie 名の auto-detect が NextAuth の判定と食い違っていた** ことが根本原因:

| 主体 | 「secure cookie かどうか」の判定方法 |
|---|---|
| **NextAuth (`@auth/core`)** | `config.useSecureCookies ?? url.protocol === "https:"` (URL protocol) |
| **本ヘルパ (旧実装)** | `process.env.NODE_ENV === 'production'` |

Netlify Functions runtime で `NODE_ENV` が `'production'` でないケースがあり、両者の判定が食い違って:

- NextAuth: signing 時に salt = `__Secure-authjs.session-token` (URL が https のため)
- 本ヘルパ: decode 時に salt = `authjs.session-token` (NODE_ENV != production)

→ HKDF の派生鍵が異なる → kid mismatch で "no matching decryption secret" エラー → decode 失敗 → MFA ループ。

**修正**: 本ヘルパを **request の cookies に実在する名前を auto-detect** する方式に変更 (`detectAuthCookieName`)。検出した名前を decode/encode の salt と Set-Cookie の name の双方に使用することで、NextAuth がどちらの prefix で署名していても整合する。

**一般則**: NextAuth と連携するコードで「secure context かどうか」を独自判定してはいけない。NextAuth の判定基準 (URL protocol) と環境変数 (`NODE_ENV`) は runtime によって食い違う可能性がある。実在 cookie 名 / NextAuth の `getToken()` API などで「NextAuth が決めた事実」を参照する。

## 5.X+69 **`/api/auth/*` 配下にカスタム route を置くと、NextAuth middleware の auto-refresh が我々の Set-Cookie を上書きする ─ middleware matcher で当該 path を除外する (PR #400 で実体験 / 2026-05-18)**

### 罠の正体

PR #398 で MFA verify を JWT 直接再署名方式に移行した後、本番でユーザが正しい TOTP コードを入力しても /projects に到達できないループが継続した。DevTools の Network タブで `POST /api/auth/mfa/verify` レスポンスを観察すると **`Set-Cookie: __Secure-authjs.session-token=...` が 2 回**現れていた:

```
Set-Cookie [1]: ...; Path=/; Secure; HttpOnly; SameSite=strict        ← 本ヘルパ (mfaVerified=true)
Set-Cookie [2]: ...; Path=/; Expires=...; HttpOnly; Secure; SameSite=Strict  ← NextAuth (古い値)
```

ブラウザは **同名 cookie の最後の Set-Cookie を採用**する仕様のため、2 つ目 (NextAuth 由来) が勝ち、`mfaVerified=false` のまま記録される。次のリクエストで middleware が再び /login/mfa にリダイレクト → 永久ループ。

**[2026-05-18 §5.X+71 で訂正]**: 当初は「NextAuth の auto-refresh は `/api/auth/*` 配下にしか作用しない」と書いていたが、実際は **matcher 対象の全 protected path で発生する**。PR #401 で `/api/tenants/me/i18n` でも同じ事象 (EN→JA 切替が UI に反映されない) を実観測。詳細は §5.X+71 を参照。

### なぜ発生するか

NextAuth v5 の middleware ラッパ (`NextAuth(authConfig)` が返す `auth` 関数) は `/api/auth/*` 名前空間のリクエストを「自社の認証関連エンドポイント」として処理し、レスポンスにセッションリフレッシュの Set-Cookie を**自動付与**する。これは:

- /api/auth/session : 標準的なセッション読取・更新エンドポイント
- /api/auth/callback/* : OAuth callback
- /api/auth/signin / signout : 認証フロー

これらは NextAuth の本来の役割。しかし `/api/auth/mfa/verify` のような**カスタム route**もパス前方一致で「同じ扱い」になり、NextAuth が「セッション読んだから refresh しておく」とばかりに古い JWT で Set-Cookie を上書きする。

カスタム route 側で `reissueAuthJwtOnResponse` を呼んで mfaVerified=true の cookie を書いても、middleware が後段で「気を利かせて」古い値で上書きしてしまうため、努力が無効化される。

### 推奨対応

**`middleware.ts` の matcher で当該 path を除外**する:

```ts
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/auth/mfa/verify).*)'],
};
```

これで NextAuth の middleware が当該 path に介入せず、カスタム route が書いた Set-Cookie がそのままブラウザに届く。

#### 除外しても security 要件は壊れないか

カスタム route 内で以下を実施していれば middleware 除外しても安全:

1. **`await auth()` で session を読み、未認証なら 401 を返す** (代替の認証チェック)
2. **userId 一致確認** (他人の verify を防ぐ)
3. **業務 gate (Beginner 期限切れ / Suspend 中など)** が auth flow を妨げない設計

MFA verify は「これからログインしようとしているユーザ」が叩く endpoint であり、業務 gate (suspend / beginner) の適用対象外で構わないため、middleware bypass で問題なし。

### 一般則 (本サービスで確立)

- **`/api/auth/*` 配下にカスタム route を作るときは要注意**: NextAuth の名前空間に介入されることを前提に設計する
- **理想**: カスタム auth-related route は `/api/auth/` 外 (例: `/api/mfa/verify`) に配置する。ただし既存 URL を変えると client / e2e の URL 更新コストが大きいため、本サービスでは middleware exclude を採用
- **新規 `/api/auth/*` route 追加時のチェック**: レスポンスに想定外の Set-Cookie が含まれないかを Network タブで実機確認

### 検証経路

- Network タブで `POST /api/auth/mfa/verify` のレスポンスを開き、**`Set-Cookie` が 1 件のみ**であることを確認
- TOTP 検証成功 → `/projects` に到達できることを実機確認
- E2E `01-admin-and-member-setup.spec.ts Step 2b` が pass する (= 自動化された回帰検出)

### 過去の関連 KDD

- §5.X+66: Netlify + NextAuth Set-Cookie 不達 (元問題)
- §5.X+68: helper の silent failure を fail-loud に変更 (本件の発覚に寄与)
- §5.X+67: PR レビューで E2E / CodeQL が顕在化する罠 (同型の "本番でしか分からない" 罠)

---

## 5.X+70 **外部 cron 移行で middleware の `PUBLIC_PATHS` 同期 + Stripe disabled 時の no-op ガードを忘れると本番 cron が 302/500 で全滅する (Vercel→Netlify 移行で実体験 / 2026-05-18)**

### TL;DR

- Vercel Cron (内部呼出) → cron-job.org (外部 HTTP) 移行で 7 件中 **4 件が失敗**した
  - **3 件は 302 → `/login`**: `/api/cron/daily-notifications` / `/daily-usage-aggregation` / `/tenant-monthly-reset` が `PUBLIC_PATHS` 未登録のまま放置され、middleware の auth check が `LOGIN_PATH` に redirect
  - **1 件は 500**: `/api/cron/stripe-auto-suspend` が `getSystemUserId()` を呼ぶが、Netlify env に `SYSTEM_USER_ID` 未設定で throw。兄弟関数 `flushStripeUsageRecordQueue` には `isStripeEnabled()` ガードがあったが本関数だけ漏れていた
- **教訓**: 「外部 HTTP に晒される cron route」と「環境依存 env を内部呼出する service」は移行/有効化時に専用の checklist が無いと必ず漏れる

### 何が起きたか (時系列)

1. PR #394 で Vercel → Netlify 移行、cron は cron-job.org で外部 HTTP 化
2. 7 件の cron を順次設定し test run 実施
3. 結果:
   - ✅ `health-check` (`/api/health` は PUBLIC_PATHS 登録済) / `lock-inactive-users` / `stripe-usage-flush` (= isStripeEnabled() ガード有 → no-op 200)
   - ❌ 302 → `/login`: `daily-notifications` / `daily-usage-aggregation` / `tenant-monthly-reset` (`PUBLIC_PATHS` 未登録)
   - ❌ 500: `stripe-auto-suspend` (Stripe 無効環境で `getSystemUserId()` throw)

### 根本原因

#### 不具合 A: PUBLIC_PATHS 同期漏れ

[`src/config/routes.ts`](../../src/config/routes.ts) の `PUBLIC_PATHS` は「未認証で middleware 通過できるパス」一覧。Vercel Cron 時代は内部呼出 (= request に session cookie が付かないが Vercel-internal な header で別経路許可) で動いていた path が、外部 HTTP では通常の保護 path 扱いで [`auth.config.ts authorized`](../../src/lib/auth.config.ts#L69) の `LOGIN_PATH` redirect に乗ってしまう。

Stripe 系 2 件 (`stripe-usage-flush` / `stripe-auto-suspend`) は PR-S6 (2026-05-14) で外部 HTTP を想定して `PUBLIC_PATHS` に登録されていたが、それより古い 3 件 (`daily-notifications` / `daily-usage-aggregation` / `tenant-monthly-reset`) は登録されないまま放置されていた。

Vercel 時代は通っていた → 移行作業中もテストで気付かなかった → cron-job.org の test run で初めて顕在化。

#### 不具合 B: Stripe disabled 時の cron no-op ガード漏れ

[`autoSuspendDelinquentTenants`](../../src/services/stripe-auto-suspend.service.ts) は冒頭で `isStripeEnabled()` をチェックせず、いきなり `getSystemUserId()` を呼ぶ。Netlify env に `STRIPE_ENABLED` も `SYSTEM_USER_ID` も未設定 (= 6/1 MVP リリースは Stripe 無効スタート) のため、`getSystemUserId()` が `throw new Error('SYSTEM_USER_ID is not configured...')` → 500。

兄弟関数 [`flushStripeUsageRecordQueue`](../../src/services/stripe-usage-flush.service.ts#L76) は同じ前提下でも `if (!isStripeEnabled()) return { ..., skipped: true }` で no-op 早期 return している。レビュー時に両関数を見比べていれば気付けたが、PR-S6 で本関数だけガードが入らないままマージされていた。

### 修正

```typescript
// src/config/routes.ts (PUBLIC_PATHS)
'/api/cron/daily-notifications',         // 追加
'/api/cron/daily-usage-aggregation',     // 追加
'/api/cron/tenant-monthly-reset',        // 追加

// src/services/stripe-auto-suspend.service.ts
export async function autoSuspendDelinquentTenants(): Promise<AutoSuspendResult> {
  if (!isStripeEnabled()) {
    return { candidates: 0, suspended: 0, skipped: 0, errors: [], skippedStripeDisabled: true };
  }
  // ... 既存処理
}
```

### 再発防止ルール

1. **外部 HTTP 化される cron route を追加/移行する際の Checklist**
   - [ ] `PUBLIC_PATHS` (`src/config/routes.ts`) に登録したか
   - [ ] route 側で `isCronAuthorized()` (`Authorization: Bearer <CRON_SECRET>` 定数時間比較) を呼んでいるか
   - [ ] cron-job.org / 移行先 cron 管理画面で test run して **200 OK** を確認したか
   - [ ] 外部からの POST/GET method を route の `export` と一致させたか
   - [ ] 詳細手順は [`docs/operations/DEPLOYMENT.md §6`](../operations/DEPLOYMENT.md) を参照

2. **環境依存 env を要求する service を cron から呼ぶ際の Checklist**
   - [ ] その env が未設定の環境 (= dev / 機能 disabled 状態) でも throw しないか
   - [ ] feature flag (`isStripeEnabled()` 等) で早期 return しているか
   - [ ] 兄弟関数 (= 同じ env を読む他関数) のガードと整合しているか (= grep `getSystemUserId\|isStripeEnabled` で横展開チェック)

3. **後付け検出 (= 横展開 grep の自動化)**

   ```bash
   # 「PUBLIC_PATHS に未登録の cron route があれば fail」を CI に組み込む候補
   pnpm tsx scripts/check-cron-public-paths.ts  # 未整備、TODO
   ```

### 過去の関連 KDD

- §5.X+58: 新規 route/page を追加した時の `pnpm e2e:coverage-check` ガード漏れ (= 同型の「設定ファイル同期漏れ」)
- §5.X+66: Netlify 移行で顕在化したクラスの罠 (本件もその一種)
- §5.X+69: middleware matcher の除外漏れ (= 同じ routes 系設定の同期問題)

---

## 5.X+71 **`Set-Cookie` で JWT を再署名するカスタム route は `/api/auth/*` 配下でなくとも middleware matcher から除外する ─ NextAuth `auth()` wrapper は protected な全 path で session refresh を打ち、我々の Set-Cookie を上書きする (PR #401 で実体験 / 2026-05-18)**

### TL;DR

- §5.X+69 で `/api/auth/mfa/verify` を middleware から除外したが、**同じ罠が `/api/tenants/me/i18n` でも顕在化**した
- 症状: テナント設定画面で言語を EN → JA に切替 → API は 200 を返すが UI は EN のまま残る
- 原因: NextAuth `auth()` middleware wrapper は **`/api/auth/*` 配下に限らず matcher 対象の全 path で** session refresh の Set-Cookie を打つ。route handler 側で `reissueAuthJwtOnResponse` した直後にこの refresh で旧 locale 値の cookie が上書きされる (= dual Set-Cookie の last-write-wins)
- 対策: JWT 再署名する route は **`/api/auth/*` の内外を問わず matcher から除外**する。route 側は自前で `getAuthenticatedUser` 等の認可チェックを行う前提

### 何が起きたか

1. PR #395 で theme cookie 分離、PR #396 で MFA/TZ/Locale を `reissueAuthJwtOnResponse` ヘルパに統一
2. PR #400 で `/api/auth/mfa/verify` を middleware 除外、MFA verify はループ解消
3. しかし `/api/tenants/me/i18n` は `/api/auth/*` ではないので除外漏れ → 同じ症状 (UI に新 locale が反映されない) が残存
4. PR #401 で `/api/tenants/me/i18n` も matcher 除外、解消

### 根本原因 (§5.X+69 の補足)

§5.X+69 では「`/api/auth/*` 配下で発生」と限定して書いていたが、実際は NextAuth v5 の `auth()` middleware wrapper は **matcher 対象の全 protected path で** 同じ動作をする (session のスライディング更新)。`/api/auth/*` の話に限らない。

つまり「JWT 内 claim を route 側で再署名する」という設計を取る限り、**当該 route は middleware matcher の除外リストに追加する** ことが必須要件になる。

### 修正

```typescript
// src/middleware.ts
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/auth/mfa/verify|api/tenants/me/i18n).*)'],
  // 新規追加: api/tenants/me/i18n
};
```

### 再発防止ルール

1. **JWT 再署名 (`reissueAuthJwtOnResponse`) を呼ぶ route を追加したら、middleware matcher の除外リストにも同 path を追加する**
   - チェック方法: `grep -rn "reissueAuthJwtOnResponse" src/app/api` の結果と middleware matcher の除外リストを突き合わせる
   - 漏れがあれば「200 だが UI に反映されない」という再現性のある罠が生まれる

2. **route 側の自前認可チェックは省略しない**
   - `await getAuthenticatedUser()` 等で middleware と等価の認可を route 内で実施
   - middleware 除外 = "auth が無効" ではなく "auth は route 側で行う" 規律

3. **CI ガードの整備 (TODO)**

   ```bash
   # 「reissueAuthJwtOnResponse を呼ぶ route が matcher 除外されているか」を grep で照合する CI 候補
   pnpm tsx scripts/check-middleware-exclusions.ts  # 未整備、TODO
   ```

### 過去の関連 KDD

- §5.X+66: NextAuth + Netlify Set-Cookie 不達 (元問題)
- §5.X+69: `/api/auth/mfa/verify` の middleware 除外 (本件の前段、限定的に書きすぎていた)
- §5.X+70: routes 系設定ファイルの同期漏れパターン (PUBLIC_PATHS / matcher の漏れは同型問題)

---

## 5.X+72 **cron-job.org の外部監視に依存すると本番障害の発見が遅れる ─ アプリ内に cron 実行履歴テーブルを持ち super_admin から可視化する (PR feat/cron-execution-log で実装 / 2026-05-18)**

### 罠の正体

Vercel Cron 時代は Function logs を Vercel ダッシュボードで一元確認できた。Netlify + cron-job.org に移行後、cron の実行結果を確認するには:

1. cron-job.org の外部ダッシュボード (= サードパーティ依存)
2. Netlify CLI で `netlify logs --source functions` (= CLI 操作必須、リアルタイム性なし)

社内に統合された監視導線が無く、特に **Netlify Functions の 10 秒 timeout で殺された Lambda** は Function logs にすら明確なエラーが残らない (Lambda 自体が SIGKILL される)。

### 何が起きうるか

具体的な失敗シナリオ:

- 月末締めの `tenant-monthly-reset` が timeout で部分実行 → 翌月の請求金額が一部テナントで 0 円集計 → 誤請求
- `daily-notifications` の途中で timeout → 通知が一部ユーザに届かず → リマインダ欠落
- 失敗が連続しているのに気付かない → 監視画面を毎日見る運用者がいない (cron-job.org に習慣化しないと見ない)

### 対策パターン

1. **`cron_execution_logs` テーブル** を新設し、開始時 status='running' で書込 → 完了時に 'success'/'failure' に update
2. **timeout 検知**: 終了の update が走らなければ `status='running'` のまま残るため、`now - startedAt > 30s AND status='running'` を「stale = timeout 疑い」として super_admin UI で警告色表示
3. **動作概要を中央集約** (`src/config/cron-jobs.ts`): 各 cron の「何をする処理か」を 1 ファイルにまとめ、super_admin UI が一覧表示。開発者以外でも cron 失敗時の影響範囲を把握できる
4. **logging 失敗で本体を fail させない (fail-soft)**: log 書込みエラーを try/catch で吸収。監視機能の故障で本番処理を巻き添えにしない

### 実装の急所

```ts
// withCronExecutionLogging(name, req, async () => { ... })
//   1. create({ status: 'running' })  ← timeout でもこのレコードが残る
//   2. 本体実行
//   3. update({ status: 'success'|'failure', durationMs, payloadJson|errorMessage })
//   logging 部分は全て try/catch でくるみ、失敗時は console.warn のみで本体結果は返す
```

### 再発防止ルール

- 新規 cron route を追加する際は **必ず `withCronExecutionLogging()` でラップ** する (= 監視盲点を作らない)
- `src/config/cron-jobs.ts` に **動作概要 + スケジュール** を登録する (= 未登録 cron は UI で「(未登録の cron: ...)」と表示される)
- super_admin ダッシュボードを **週次で確認**する運用 (= 監視疲れを避けるため日次ではなく週次、stale running が出たらアラート色で目立つ前提)

### 過去の関連 KDD

- §5.X+70: cron route の PUBLIC_PATHS / Stripe ガード漏れ (本件と同様、Netlify 移行で顕在化した cron 系の罠)
- §5.X+68: helper の silent failure を fail-loud にする原則 (本件は逆に fail-soft = 監視機能ゆえの設計判断)


## 5.X+73 **UI 変更時に視覚回帰 baseline 更新を忘れて CI fail (2026-05-19)**

### 罠の正体

PR #403 で `src/app/(auth)/login/page.tsx` に「招待制案内」のフッタブロックを追加したが、視覚回帰 baseline (`e2e/visual/auth-screens.spec.ts:20:7` ログイン画面初期表示) を再生成していなかったため、CI の Playwright `toHaveScreenshot` で pixel diff が検出され fail。

該当 spec:
```
[chromium]        e2e/visual/auth-screens.spec.ts:20:7 ログイン画面 初期表示
[chromium-mobile] e2e/visual/auth-screens.spec.ts:20:7 ログイン画面 初期表示
```

両 viewport で baseline は別ファイル (`*-chromium-linux.png` / `*-chromium-mobile-linux.png`) のため、UI 変更時は **PC + Mobile 両方** で baseline 更新が必要。

### なぜ発生するか

1. **UI 変更が視覚回帰対象画面かの判断が漏れがち**: ログイン / 各ダッシュボード / テーマ 10 色等は `e2e/visual/*.spec.ts` で baseline が定義されているが、UI を触る側はその spec の存在を即座に思い出せない
2. **`pnpm lint && pnpm tsc --noEmit && pnpm test && pnpm build` の 4 点セットには視覚回帰が含まれない**: 視覚回帰は CI でしか実行されず、ローカル検証では検出されない
3. **PR レビュー時に「UI を変えた」事実 → 「視覚 baseline 更新必要」の連想が抜ける**

### 推奨対応

UI を変更したら(特に既存画面の見た目に影響する変更)、必ず以下を実行:

```bash
# 1. 空コミットで [gen-visual] タグ commit
git commit --allow-empty -m "chore: regenerate visual baselines [gen-visual]"

# 2. push → e2e-visual-baseline.yml が発火 → CI が baseline PNG を再生成して
#    自動 commit する
git push
```

`[gen-visual]` タグの仕組みは `.github/workflows/e2e-visual-baseline.yml` に集約されており、main マージ後は workflow_dispatch でも実行可能。

### 検証対象画面 (2026-05-19 時点)

`e2e/visual/` 配下の spec で visual regression baseline を持つ画面:

- `auth-screens.spec.ts` — ログイン / パスワードリセット / 等
- `customers-screens.spec.ts` — 顧客一覧 / 詳細
- `dashboard-screens.spec.ts` — ダッシュボード各種
- `settings-themes.spec.ts` — 10 テーマ × 主要画面

これらの画面に **見える要素を 1 px でも変える** UI 変更を加えたら、必ず baseline 再生成。

### 横展開: PR template / CONTRIBUTING への明示

[CONTRIBUTING.md §5](../../CONTRIBUTING.md) の **横展開チェック** に以下を追加候補:
- [ ] UI を変更した場合: `e2e/visual/` の該当 spec を確認し、必要なら `[gen-visual]` 空コミットで baseline 再生成

### 同型の過去事例

- §5.X+58 (E2E カバレッジゲート): 新規 `page.tsx` / `route.ts` 追加時の `pnpm e2e:coverage-check` 漏れと同じパターン (CI でしか検出されないゲートを認識し損ねる)

## 5.X+74 **E2E fixture cleanup の foreign key 制約違反による flake (2026-05-19)**

### 罠の正体

PR #403 の E2E 実行で `e2e/specs/13-super-admin-dashboard.spec.ts:89:7` が `users_tenant_id_fkey` 制約違反で fail。エラー発生箇所は `e2e/fixtures/super-admin.ts:77` の super_admin user 作成時。

cleanup ログ:
```
[e2e cleanup tenants] DELETE tenants 失敗 (継続):
  update or delete on table "tenants" violates foreign key constraint
  "users_tenant_id_fkey" on table "users"
```

**根本原因**: 前のテストの teardown で tenants 削除を試みた際、users が先に削除されておらず FK 制約違反で失敗。tenants が残り、その状態で次のテスト (13-super-admin-dashboard) の fixture が同 ID の user を作ろうとして衝突。

### なぜ flake か

- main 最新 (PR #402 マージ後) では同テストが **success**
- PR 単発実行で散発的に再現
- 並列実行順序やタイミングに依存

### 推奨対応 (短期)

CI を **Re-run failed jobs** で再実行。多くの場合これで成功する。

### 推奨対応 (中長期、別 PR)

`e2e/fixtures/super-admin.ts` および各 spec の teardown で、削除順序を **依存の逆順** で明示:

```ts
// 削除順序 (子から親へ):
// 1. memos, knowledges, risks_issues, retrospectives, tasks, estimates
// 2. project_members
// 3. projects
// 4. users
// 5. tenants
```

または、各 spec の teardown で `try/catch` ではなく **CASCADE 削除** に切替も検討:
```sql
DELETE FROM tenants WHERE id = ANY($1) CASCADE;
```

ただし `ON DELETE CASCADE` 設定の有無に依存するため、schema 側との整合確認が必要。

### 横展開

E2E 全体の fixture cleanup を統一する基盤関数 (`e2e/fixtures/cleanup.ts` 等) を作る案が
[docs/test/E2E_LESSONS.md](../../docs/test/E2E_LESSONS.md) で議論されているか確認 → 議論なしなら TODO 起票。

---

## 5.X+75 **Prisma schema 変更後の `prisma generate` 忘れで CI tsc が落ちる + 新 enum 値の MailParams.type 反映漏れ (2026-05-19 / PR #411)**

### 発生背景

PR #411 (= PR-V7a 請求業務横展開実装) で以下 2 つの種類の変更を加えた:

1. **Schema 変更**: `BillingHistory` に 5 新規フィールド (paymentDueDate / overdueAlertSentAt / nextPaymentAttempt / confirmedBy / confirmedAt) を追加
2. **新規 mail 種別**: `admin-alert.service.ts` から `provider.send({ type: 'admin_alert' })` で送信

ローカルでは:
- `pnpm test` (= vitest) は **通った** (= 2539/2539 pass)
- `pnpm e2e:coverage-check` も通った
- 私自身でも `pnpm tsc --noEmit` を実行したが、見た目「pre-existing errors のみ」で見落とした

しかし **CI (GitHub Actions の Lint / Test / Build)** が失敗。原因 2 つ:

#### 原因 A: Prisma 生成型が未更新

```
src/services/admin-alert.service.ts(123,11): error TS2353:
  Object literal may only specify known properties, and 'overdueAlertSentAt'
  does not exist in type 'BillingHistoryWhereInput'.
```

`src/generated/prisma/client.ts` が古いまま (= 5 月 19 日午前の schema 変更前のバージョン)。新規フィールドを参照するすべての `prisma.billingHistory.findMany` / `.update` / `.upsert` で TypeScript 型エラーが発生。

**なぜローカルでは気付けなかったか**:
- `pnpm test` (vitest) は **mock 経由** で Prisma を呼ぶため、generated 型の整合性をチェックしない
- `pnpm tsc --noEmit` を実行すると本当はエラーが出るが、pre-existing errors (BigInt literal 等) が大量にあって紛れた
- 私が `grep -v "BigInt"` で除外しなかったため見逃した

#### 原因 B: `MailParams.type` union への新規値追加漏れ

```
src/services/admin-alert.service.ts(84,7): error TS2322:
  Type '"admin_alert"' is not assignable to type
  '"unknown" | "invitation" | ... | "beginner_auto_delete_warning_170" | undefined'.
```

`src/lib/mail/mail-provider.ts` の `MailParams.type` union literal は `'invitation' | 'password_reset' | ... | 'unknown'` で定義されている。`admin-alert.service.ts` で `type: 'admin_alert'` を渡したが、union に未追加だった。

似たような型定義が `src/services/email-send-log.service.ts` の `EmailSendType` にもあり、こちらも更新漏れ (= 2 箇所同期が必要)。

### 教訓

1. **schema 変更時は必ず `pnpm prisma generate` を最初に実行**
   - `prisma migrate dev` を使えば自動で generate されるが、migration SQL を手書きする場合は明示実行必須
   - CI/CD は `pnpm build` 内の `prisma generate && next build` で都度生成するため CI では検知される
   - ローカルでも tsc を信頼するには generate を先に走らせる必要あり

2. **`pnpm tsc --noEmit` の出力は必ず grep 結果で「PR 関連の error 数」を確認**
   - `grep -E "error TS" | grep -v "BigInt literals\|usage-monitoring.service.test\|user.service.test"` 等で pre-existing を除外して PR 由来の error 数を確認するワンライナーを使う

3. **新規 mail 種別追加時は 2 箇所同期** (= 横展開チェック)
   - `src/lib/mail/mail-provider.ts` の `MailParams.type` union
   - `src/services/email-send-log.service.ts` の `EmailSendType`
   - どちらか一方だけ更新すると CI で tsc が落ちる

### 推奨対応

#### 短期 (= 今回の PR で実施済)
1. `pnpm prisma generate` を明示実行
2. `MailParams.type` と `EmailSendType` 両方に `'admin_alert'` を追加
3. `MailParams.html` (required) を満たすため、`admin-alert.service.ts` で `<pre>` ラップ HTML を生成

#### 中長期
- **pre-commit hook で `pnpm prisma generate` を schema 変更時に自動実行** する仕組み (husky + lint-staged 等) を検討
- **`MailParams.type` と `EmailSendType` の type union を 1 箇所に集約** (= `src/config/mail-types.ts` 等) して同期漏れを物理的に防止する case を検討

### 横展開

- 他の生成型 (= Prisma 以外で `*.generated.*` 系がないか確認) → 該当なし
- 似たような「union 型の 2 箇所同期」パターンがないか grep で確認推奨

### 関連
- PR #411 で発生・修正 (commit `5ea24a3` で `admin_alert` 導入 → CI fail → 本 commit で修正)
- KDD §5.X+72 cron-execution-log (= 似た「ローカルでは出ない CI fail」事例) と併読推奨

---

## 5.X+76 **Next.js dynamic segment の slug 名衝突で WebServer が起動失敗 → E2E 全停止 (2026-05-19 / PR #411)**

### 発生背景

PR #411 (= PR-V7a 請求業務横展開実装) で同じ階層に 2 つの API route を追加:

```
src/app/api/admin/super/billing/
  [id]/confirm-payment/route.ts        ← A-1 (PR-V7a)
  [yearMonth]/export/route.ts          ← C-5 (PR-V7a)
```

E2E (Playwright) が WebServer 起動段階で大量のエラーを吐いて全停止:

```
[WebServer] Error: You cannot use different slug names for the same dynamic path
            ('id' !== 'yearMonth').
```

### 根本原因

**Next.js のルーティング制約**: 同じ階層 (= 同じ親ディレクトリ) にある dynamic segment (`[xxx]`) は、**すべて同一の slug 名でなければならない**。

```
api/admin/super/billing/[id]/confirm-payment       ← slug = "id"
api/admin/super/billing/[yearMonth]/export          ← slug = "yearMonth"
                       ^^^^^^^^^^^^
                       同階層に異なる slug 名 → ERROR
```

これは Next.js App Router の制約で、Pages Router 時代から継続している仕様。
ルーティングテーブル構築時に「`/billing/{動的}/...` のパラメタ名は何?」が一意に決まらないため。

**なぜローカルテストでは気付けなかったか**:
- `pnpm test` (vitest) は API route のルーティング解決を行わない
- `pnpm tsc --noEmit` は型チェックのみで、Next.js のルーティング解析は行わない
- `pnpm build` で **本来は検出される** が、私が「`pnpm build 2>&1 | grep -E "error|Error|..."`」で粗い grep をした際に
  本エラーが grep にマッチせず取り漏らした (= "different slug" は error 文字列を含むが、私の filter で skip された)
- CI の Playwright だけが「WebServer 実行時」に到達して発覚

### 教訓

1. **同階層の動的セグメントは slug 名を統一**: `[id]` と `[yearMonth]` を同階層に混在させない
   - 解決策: いずれかを下層 (= 別ディレクトリ) に移動
   - 例: `billing/export/[yearMonth]` (= `export` の下に `[yearMonth]` を置く)

2. **`pnpm build` の出力は full text で確認**: grep で error 文字列を絞り込むと、Next.js 固有の特殊エラー文言 ("You cannot use different slug names...") を取り漏らす危険性がある
   - 推奨: `pnpm build 2>&1 | tail -100` 等で末尾を直接読む、または `2>&1 | tee build.log` してログを残す

3. **同階層に動的セグメントを 2 つ以上配置したくなった場合は path 構造を見直す**:
   - 「リソース別の操作」(= `[id]/action1`, `[id]/action2`) = OK
   - 「異なる識別子の操作」(= `[id]/...`, `[yearMonth]/...`) = NG、 階層を分ける

### 修正対応

`/api/admin/super/billing/[yearMonth]/export/` → `/api/admin/super/billing/export/[yearMonth]/` にリネーム移動。

- UI 側 (= billing/[yearMonth]/page.tsx の CSV エクスポートボタンの href) も同期更新
- E2E_COVERAGE.md の API 行を新 path に更新
- route.ts の JSDoc に「slug 衝突回避のための path 構造」コメントを追加

### 横展開

たすきば内に同様のパターンがないか grep で確認:

```bash
find src/app -type d -name "[*]" | sort
```

同じ親ディレクトリの兄弟が `[xxx]` と `[yyy]` で異なる名前になっていないか棚卸し。
現状 (本修正後) は問題なし。

### 関連
- PR #411 commit `63fb9ff` で C-5 (CSV export) を `[yearMonth]/export` で追加 → E2E fail → 本 commit で修正
- Next.js 公式ドキュメント: [App Router - Dynamic Routes](https://nextjs.org/docs/app/building-your-application/routing/dynamic-routes)
- KDD §5.X+75 (= 同 PR 内の別 CI fail) と併読推奨

---

## 5.X+77 **`prisma migrate deploy` を `package.json` の build script に組み込むと CI (dummy DATABASE_URL) で P1001 失敗 → CI と Netlify で build script を分離する (2026-05-19 / PR #412)**

### 事象

PR #412 (PR-V8.1) で **migration 適用漏れの構造的予防** を目的に `package.json` の `"build"` を以下に変更:

```json
"build": "prisma generate && prisma migrate deploy && next build"
```

→ GitHub Actions の `Lint / Test / Build` workflow で以下のエラーで失敗:

```
DATABASE_URL: ***localhost:5432/dummy
...
Datasource "db": PostgreSQL database "dummy", schema "public" at "localhost:5432"
Error: P1001: Can't reach database server at `localhost:5432`
```

### 根本原因

- CI ワークフロー (`.github/workflows/test.yml` 等) は **ビルドの artifact 生成のみが目的** で、実 DB に接続する必要がない
- そのため `DATABASE_URL=postgresql://...localhost:5432/dummy` のダミー値を渡して `pnpm build` を実行する
- `prisma generate` は `schema.prisma` のみ参照するため DB 不要 → OK
- `prisma migrate deploy` は **実 DB に接続して `_prisma_migrations` を読み書きする** ため、ダミー URL では `P1001: Can't reach database server` で失敗

### 教訓

1. **`prisma migrate deploy` は CI には組み込めない (実 DB が必要)**
2. **本番環境 (= Netlify) と CI では build script を分けるべき**
3. ローカル `pnpm build` も同じ問題に遭遇する可能性 (= ローカル DB が起動していない開発者環境ではビルド失敗)

### 修正対応

`package.json` で 2 種類の build script を提供:

```json
"build":         "prisma generate && next build",                          // CI / ローカル開発用
"build:netlify": "prisma generate && prisma migrate deploy && next build"  // Netlify 本番用
```

`netlify.toml` の `command` を `pnpm build:netlify` に変更し、Netlify でのみ migrate deploy が実行されるようにする。
DEPLOYMENT.md §1.1 にも 2 種類の build script の使い分けを明記。

### 横展開

似たパターン (= 実 DB 接続が必要な処理を build に組み込む) は他にもないか確認:

- `prisma db push` (= 開発時の schema sync) も同様の P1001 リスク
- `prisma db seed` (= 本番でも seed したい場合) も実 DB 必要
- 「DB に副作用がある任意のコマンドを build script に入れる前に CI 影響を考える」というルール化が望ましい

### 関連
- KDD §5.X+72 (cron-execution-log = 似た「ローカルでは出ない CI fail」事例) と併読推奨
- DEPLOYMENT.md §1.1 (build script 2 種類の使い分け)
- 元事故: PR-V7a で migration 適用忘れ → `billing-overdue-alert` cron 500 → PR-V8.1 で migrate 自動化を試みたが本件 CI fail を引き起こした

---

## 5.X+78 **画面表示の真値ベース化 (counter → ApiCallLog SUM) は E2E fixture の seed 整合性を破壊する → fixture も同時に整合させる (2026-05-19 / PR #412)**

### 事象

PR #412 (PR-V8.1) で、システム管理者ダッシュボードのテナント一覧画面表示を **`Tenant.currentMonthApiCallCount` (counter) → `ApiCallLog` SUM (真値)** に変更:

```tsx
// 旧 (PR-V8 以前):
<td>{t.currentMonthApiCallCount.toLocaleString()}</td>
<td>¥{t.currentMonthApiCostJpy.toLocaleString()}</td>

// 新 (PR-V8.1):
const r = reconcileByTenant.get(t.id);
const sumCall = r?.reconciledCallCount ?? t.currentMonthApiCallCount;
const sumCost = r?.reconciledCostJpy ?? t.currentMonthApiCostJpy;
<td>{sumCall.toLocaleString()}</td>
<td>¥{sumCost.toLocaleString()}</td>
```

→ E2E spec 13 (`13-super-admin-dashboard.spec.ts`) が `'1,500'` (= counter 値) を expect していたが、fixture は **counter のみ seed** していて **ApiCallLog を seed していなかった** ため、SUM=0 + drift 警告 `150000%` が表示されて fail:

```
Expected substring: "1,500"
Received string:    "7E2E Tenant A ...expert0¥0⚠ 150000%12026-05-19"
```

### 根本原因

- 旧 fixture は「counter に直接値を埋め込めば請求金額表示は正しく出る」という前提で書かれていた
- これは **counter と ApiCallLog SUM が乖離している不健全な状態** を fixture で作っていたことを意味する
- 本来あるべき姿は「ApiCallLog を seed し、counter は increment 動作で同期される」だが、E2E では性能上 ApiCallLog seed を省略していた
- 表示が SUM ベースに変わった結果、この前提が崩れて test fail

### 教訓

1. **表示ロジックを `Tenant` 行直読みから `ApiCallLog` aggregation に変える時は fixture も同時に修正必須**
2. **fixture は production 同型の不変条件 (= counter == SUM) を満たすべき**。「counter だけ seed」は production では絶対に起きない状態
3. **drift 警告が出る fixture は「テスト用」ではなく「drift シナリオを意図したテスト」専用** であるべき

### 修正対応

各テナントに ApiCallLog を 1 行 seed し、counter を SUM と一致させる:

```ts
// テナント A: ¥1500 の請求金額を 1 件の代表 ApiCallLog で表現
await pool.query(
  `INSERT INTO api_call_logs (tenant_id, feature_unit, model_name, cost_jpy, latency_ms, created_at)
   VALUES ($1, 'risk-issue-embedding', 'claude-haiku-4-5', 1500, 100, NOW())`,
  [tenantAId],
);
// counter を SUM (= 1 件 / ¥1500) と一致させる
await pool.query(
  `UPDATE tenants
   SET current_month_api_call_count = 1, current_month_api_cost_jpy = 1500
   WHERE id = $1`,
  [tenantAId],
);
```

代表 1 行で集計を表現する (= 300 行 INSERT は遅いので回避)。テストの assertion は呼出数ではなく費用 (¥1,500) を見ているため、件数を 1 にしても通る。

### 横展開

PR-V8.1 では以下の画面・経路で counter → SUM 変更を実施。それぞれの fixture / test がこのパターンに当てはまる可能性がある:

- `/settings/tenant` (テナント管理者画面)
- `/admin/super` top の Default テナントセクション
- `/admin/super/tenants/[id]` 詳細
- `/admin/super/tenants` 一覧
- `/api/admin/super/usage/export` CSV

将来、同様の「キャッシュ値 → 真値 SUM」リファクタを行う際は **fixture 棚卸し** を必須項目にする。

### 関連
- KDD §5.X+77 (= 同 PR 内の別 CI fail) と併読推奨
- memory: `feedback_billing_invariant.md` (★最重要★ 請求 invariant = ApiCallLog SUM = 全画面表示 = 請求金額)
- PR #412 (PR-V8.1) で「画面表示の真値ベース化」と「fixture 修正」を同 PR でカバー

---

## 5.X+79 **月次 snapshot を `currentMonthApiCallCount` (counter) ベースで保存すると過去月の請求書根拠が永久に drift で固定される → ApiCallLog SUM ベースに統一 (2026-05-19 / PR #412)**

### 事象

`saveMonthlyUsageSnapshots` (= 月初 cron) が `tenant_monthly_usage_history` に snapshot を upsert する際、`Tenant.currentMonthApiCallCount` (= リアルタイム counter) をそのまま保存していた。
counter が drift している月 (= 本件 Default テナント 1 vs SUM 8 のような状態) の月初を跨ぐと、**drift 状態のままの値が「過去月の請求書根拠」として永久に固定**される。

過去月 CSV ダウンロード (`/api/admin/super/usage/export?yearMonth=YYYY-MM`)、UI 履歴テーブル、再請求調査の全経路で間違った金額が表示され、後から修復しようとしても snapshot が真値を上書きしているため診断不能。

### 根本原因

- snapshot は「請求書根拠の永続化」が目的だが、ソースが内部 cache (= counter) だった
- 一方、当月 CSV / 当月画面表示は ApiCallLog SUM ベースに移行済 (PR-V8.1) → 過去月 (snapshot) と現在月 (SUM) で **同じ月を 2 種類の方法で見ると違う金額が出る** UX 不整合
- counter drift 検知 + 修復は PR-V8.1 で診断ダッシュボードに実装したが、**月初 cron が走った瞬間に過去月 snapshot は永久確定** するため、月初前に drift を修復しないと取り返せない

### 教訓

1. **「永続化される数値」は必ず真値ソース (= 監査ログ的な不変テーブル) から計算すべき**。cache から派生させると cache 不整合が永続化される
2. ApiCallLog のような append-only テーブルは集計コストが高い印象があるが、月 1 回の cron なら per-tenant aggregate でも実用範囲
3. 「リアルタイム表示 = cache」「請求書根拠 = 真値」と層を分けるのが正しい

### 修正対応

`saveMonthlyUsageSnapshots` (`tenant-monthly-reset.service.ts:177-213`) を以下に変更:

```ts
// 旧: counter を snapshot に直接書く
apiCallCount: tenant.currentMonthApiCallCount,
apiCostJpy: tenant.currentMonthApiCostJpy,

// 新: ApiCallLog SUM (前月の TZ 範囲) を取って snapshot に書く
const prevMonthStart = getTenantMonthStart(prevMonthMid, tenant.timezone);
const currentMonthStart = getTenantMonthStart(now, tenant.timezone);
const apiAgg = await prisma.apiCallLog.aggregate({
  where: { tenantId: tenant.id, createdAt: { gte: prevMonthStart, lt: currentMonthStart } },
  _count: { _all: true },
  _sum: { costJpy: true },
});
apiCallCount: apiAgg._count._all,
apiCostJpy: apiAgg._sum.costJpy ?? 0,
```

集計範囲はテナント TZ 月初 〜 翌月初。`getTenantMonthStart(prevMonthMid, tz)` で「前月 15 日」を渡して per-tenant 月初を計算 (UTC とテナント TZ で月境界が違っても 15 日なら同じ月)。

### 横展開

「キャッシュ値を永続化テーブルに書いている」パターンを棚卸し:
- 解約時 snapshot (`deleteTenant` 内): 同じ counter を書いている → 同じ修正を将来適用検討
- `BillingHistory.totalAmountJpy`: 既に ApiCallLog SUM ベース ✅ (billing-aggregation.service.ts:91-104)
- 他キャッシュ系 (`Tenant.storageBytesUsed`): cron で毎日 update されるが drift 検知未実装 → 別 PR で対応

### 関連
- KDD §5.X+78 (= 表示の真値ベース化 = 本件と同一ファミリー)
- memory: `feedback_billing_invariant.md` (★最重要★ 全経路で SUM = 真値)
- memory: `feedback_3layer_sync_filter.md` (現在値 / cron snapshot / 履歴クエリ の 3 層同期パターン)
- PR #412 (PR-V8.1) で 3 大 HIGH 漏れ (cross-tenant summary / tenant detail 合計 / snapshot) を同時修正

---

## 5.X+80 **fixture で生 SQL INSERT する際は NOT NULL カラムを schema.prisma で確認する (Prisma Client なら型で防がれるが、生 SQL は実行時 fail) (2026-05-19 / PR #412)**

### 事象

PR #412 (PR-V8.1) で e2e fixture `super-admin.ts` に ApiCallLog seed を追加した時、以下の INSERT 文で `request_id` カラムを省略:

```sql
INSERT INTO api_call_logs (
  tenant_id, feature_unit, model_name, cost_jpy, latency_ms, created_at
) VALUES ($1, 'risk-issue-embedding', 'claude-haiku-4-5', 1500, 100, NOW())
```

ローカル test は **vitest mock** で prisma を mock するため通過し、CI Playwright で **実 DB INSERT 時に初めて発覚**:

```
error: null value in column "request_id" of relation "api_call_logs" violates not-null constraint
```

### 根本原因

- `prisma/schema.prisma` で `ApiCallLog.requestId` は `String @map("request_id") @db.VarChar(64)` (= NOT NULL、Optional でない)
- 通常コードは `prisma.apiCallLog.create({ data: { ... } })` 経由で Prisma Client が型チェックする → IDE/tsc で漏れに気付ける
- 一方、**E2E fixture は性能上の理由で `pool.query(SQL)` 経由の生 SQL** を使用 → 型チェックなし、ランタイム fail
- ローカル vitest mock では実 DB に届かないため、コミット前に気付けない

### 教訓

1. **生 SQL を書く時は `prisma/schema.prisma` で対象 model の全カラムを確認**。特に `String @map(...)` の Optional vs Required を区別
2. **既存実装の Prisma `create` 呼出をテンプレートにする**: 既存ファイル (例: `src/lib/llm/metered.ts:262-275` の `apiCallLog.create({ data: { id, tenantId, ..., requestId, ... }})`) を見れば必須フィールドが分かる
3. **Local で `pnpm test:e2e` を回すコストが高い場合**、せめて生 SQL INSERT は `RETURNING *` 付きでリクエスト構造を確認するだけでもよい

### 修正対応

```sql
-- 修正前
INSERT INTO api_call_logs (tenant_id, ..., created_at) VALUES (...)

-- 修正後
INSERT INTO api_call_logs (tenant_id, ..., request_id, created_at)
VALUES ($1, ..., $2, NOW())
-- $2 = `e2e-sa-${runId}-${suffix}-a-req` (= 一意で人間可読な fixture 識別子)
```

`request_id` は VarChar(64) なのでテストでは UUID でなくとも一意文字列で OK。`gen_random_uuid()::text` でも可。

### 横展開

`grep -rn "INSERT INTO" e2e/fixtures/` で生 SQL を使う他 fixture を棚卸し:
- `multi-tenant.ts` / `super-admin.ts` 等が該当
- 各 INSERT の対象テーブルの NOT NULL カラムを再度 schema 突合

将来的に **fixture も Prisma Client 経由に統一** すれば本問題は構造的に解消する。性能上問題なら部分的に。

### 関連
- KDD §5.X+78 (= 表示の真値ベース化に伴う fixture 修正 = 本件と同 PR 同一ファミリー)
- 元 PR commit: PR #412 commit `901b159` (fixture INSERT 追加) → CI fail → 本 commit で `request_id` 追加

---

## 5.X+81 **E2E fixture は外部 seed 状態に依存しない (= 自己完結化する) ─ MANAGEMENT_TENANT_ID 等の前提テナントは fixture 自身が `ON CONFLICT DO NOTHING` で保証する (2026-05-19 / PR #412)**

### 事象

PR #412 (PR-V8.2) で別 spec (12-suggestion-seed-data) の cleanup が FK 違反で失敗した直後、13-super-admin-dashboard spec の fixture setup で以下のエラー:

```
error: insert or update on table "users" violates foreign key constraint "users_tenant_id_fkey"
   at fixtures/super-admin.ts:77 (super_admin user INSERT)
```

`super_admin user` は `MANAGEMENT_TENANT_ID` (= `00000000-0000-0000-0000-ffffffffffff`) を tenant_id に指定するが、その瞬間に管理テナント行が DB に存在しない状態だった (= CI の並列実行・cleanup タイミング・seed タイミングの組み合わせで一時的に消えた)。

### 根本原因

- E2E fixture は「`pnpm db:seed` 完了済 = MANAGEMENT_TENANT_ID 等の system tenant が存在する」前提で書かれていた
- ただし CI では:
  - 並列 worker による複数 spec 同時実行
  - 前 spec の cleanup が FK 違反等で部分失敗 → 状態が不確定
  - db:reset + seed の途中に test が start する可能性
- これらが組み合わさり「fixture 開始時に system tenant が存在しない瞬間」が発生

### 教訓

1. **E2E fixture は冪等 + 自己完結であるべき**。外部 state (seed 結果、別 spec の事後状態) に依存しない
2. system tenant / system user 等の「前提として必要な行」は fixture 自身が `INSERT ... ON CONFLICT DO NOTHING` で保証する
3. cleanup 失敗の影響を「次 spec の setup 失敗」に伝播させないため、setup 側で防御的にゼロ化する

### 修正対応

`e2e/fixtures/super-admin.ts` の `setupSuperAdminFixture` の冒頭に管理テナント保証 upsert を追加:

```ts
await pool.query(
  `INSERT INTO tenants (
     id, slug, name, plan, payment_method, created_at, updated_at
   )
   VALUES ($1, 'mgmt', 'Knowledge Relay Platform', 'pro', 'invoice', NOW(), NOW())
   ON CONFLICT (id) DO NOTHING`,
  [MANAGEMENT_TENANT_ID],
);
```

`ON CONFLICT DO NOTHING` で既存があれば no-op、なければ INSERT する idempotent な seed。

### 横展開

他の fixture でも「seed 済を前提にしている」箇所がないか棚卸し:
- `multi-tenant.ts`: DEFAULT_TENANT_ID 前提だが setup は新規テナントを作る (= 直接参照しないので OK)
- `db.ts`: 共通 connection pool のみ
- 各 spec 内の `beforeAll` で seed 系を呼び出していないか確認

将来的に「全 fixture は ON CONFLICT 防御を持つ」のチェックリスト化が望ましい。

### 関連
- KDD §5.X+80 (= 同 PR 内の前 E2E fail = request_id NOT NULL 漏れ)
- 元事故: CI run 26093793392 で `users_tenant_id_fkey` 違反 → 本修正で防御

---

## 5.X+81 **請求金額計算ロジック自体のバグは「保存値 vs 再計算値」突合でしか検知できない (2026-05-19 / PR #412 / PR-V8.4)**

### 事象

PR-V8.1〜V8.3 で「ApiCallLog SUM (真値) → 全画面表示 + CSV + 請求書根拠」の経路統一は完了したが、**`BillingHistory.totalAmountJpy` の計算ロジック自体** (= `amountJpy + taxAmountJpy` の単純和 / 消費税四捨五入 / 負値ガード) のバグは検知経路がなかった。

例: `billing-aggregation` cron の改修で `taxAmountJpy` 計算式が誤って `Math.floor` (四捨五入ではなく切り捨て) になった場合、保存される `taxAmountJpy` は計算式通りで「内部的には整合」しているように見えるが、業務仕様 (= 四捨五入) に違反して **顧客から見て数円少なく徴収** されてしまう。

### 根本原因

- 不変条件 (invariant) `totalAmountJpy = amountJpy + taxAmountJpy` を **誰もチェックしていなかった**
- 不変条件 `taxAmountJpy = Math.round(amountJpy * 0.10)` も同上
- 「コードレビューで弾けば良い」では人為的な漏れに弱い

### 教訓

1. **「請求金額」のような金銭直結データは保存後にも不変条件チェックを実装する** (= 検知の二重化)
2. **チェックロジックは「保存値」ではなく「再計算値」で行う** — 同じバグが計算と検知に潜むのを避ける (`amountJpy` と `taxAmountJpy` は **DB から SELECT した値**、それを基に **改めて `calculateTaxJpy()` を呼び直す**、その結果を保存値と比較)
3. **直近 N ヶ月だけスキャン** — 全期間スキャンはコスト高、古い不整合は実害消滅済の可能性

### 修正対応

`src/services/billing-integrity.service.ts` 新設:
- `detectBillingHistoryIntegrityIssues(monthsBack=6)`: 不変条件 4 種 (`total_mismatch` / `tax_mismatch` / `negative_amount` / `negative_total`) を走査
- `status='canceled' / 'replaced_by_stripe'` は意図的不一致を許容するため対象外
- 1 円差は `AMOUNT_RECONCILE_TOLERANCE_JPY` (= 1) で許容 (Stripe Tax 端数吸収用)

診断ダッシュボード `/admin/super/diagnostics` に「請求書計算ロジック整合 ★請求最終防衛★」セクション追加。差分検出時は対応手順 (= `billing-aggregation` cron 再実行 or SQL 直接修正 + audit_log) をテキスト案内。

加えて、ダッシュボード未閲覧期間の無音対策として **日次 cron `diagnostics-daily-alert`** (`admin-alert.service.ts:detectAndAlertDiagnosticsAnomalies`) を新設。`totalAnomalies > 0` で super_admin に push 通知。

### 横展開

「金銭直結データの不変条件チェック」棚卸し:
- `StripeUsageRecordQueue.quantity = 1` 固定 → 違反検知の必要性検討
- `Tenant.currentMonthApiCostJpy >= 0` → 既存 reconcile で間接カバー
- `ApiCallLog.costJpy >= 0` → 同上

将来的に「不変条件 DSL」を導入し、全 schema model に対して `CHECK 制約` (= DB レベル) を併用するのが理想。

### 関連
- KDD §5.X+79 (= 月次 snapshot を真値ベースに、請求 invariant チェーンの 1 つ)
- memory: `feedback_billing_invariant.md` (★最重要★ 全経路で SUM = 真値)
- PR-V8.4 (= 本件 + 日次 cron-push alert + Stripe UTC 月境界の docs 化)

---

## 5.X+82 **Supabase Direct connection (`db.*.supabase.co:5432`) は IPv6 のみ → Netlify build runner からの `prisma migrate deploy` が P1001 で失敗 → Session pooler (5432) を DIRECT_URL に設定する (2026-05-20 / PR #412 deploy 後)**

### 事象

PR #412 (PR-V8.1 で導入した `pnpm build:netlify` = `prisma generate && prisma migrate deploy && next build`) を Netlify が実行したところ、以下のエラーで deploy 失敗:

```
Error: P1001: Can't reach database server at `db.ejexwhjrnkttmmuvaxrh.supabase.co:5432`
Please make sure your database server is running at `db.ejexwhjrnkttmmuvaxrh.supabase.co:5432`.
ELIFECYCLE Command failed with exit code 1.
"build.command" failed: pnpm build:netlify
```

ただしアプリ層 (= Netlify Functions の Prisma Client) は **既に同 DB に正常接続して動作中** (`billing-overdue-alert` cron 等が 200 OK)。つまり **DB は active、build runner からだけ到達不能** という非対称状態。

### 根本原因

Supabase は 2024 年に DB 接続の IPv4 提供を有料化:
- **Direct connection** (`db.[ref].supabase.co:5432`): **IPv6 のみ**提供 (IPv4 add-on 有料)
- **Transaction pooler** (`aws-0-[region].pooler.supabase.com:6543`): IPv4 対応 (Supavisor transaction mode)
- **Session pooler** (`aws-0-[region].pooler.supabase.com:5432`): IPv4 対応 (Supavisor session mode)

Netlify build runner は IPv4 経由で DNS 解決 → Supabase Direct connection の IPv6 アドレスに到達不能で P1001。
Netlify Functions runtime は AWS Lambda 上で IPv6 サポートあり、または別 IP プールで Direct connection に到達可能なため、アプリ層は動作するが build 時のみ落ちる **非対称状態** が生じる。

### 教訓

1. **Supabase を本番で使う場合、Direct connection (`db.*.supabase.co:5432`) を直接使うのは避ける**。常に Pooler 経由にする
2. **`prisma migrate deploy` は prepared statement に依存** → Transaction pooler (port 6543) では動かない → **Session pooler (port 5432)** を使う
3. **`DATABASE_URL` と `DIRECT_URL` を分けて設定** することが Prisma + Supabase の標準パターン
   - `DATABASE_URL` = Transaction pooler (port 6543、ランタイム用、prepared statement 自動回避)
   - `DIRECT_URL` = Session pooler (port 5432、migrate 用、prepared statement OK)
4. **アプリが動いている = DB が正常」とは限らない**。build 時の接続失敗は別経路の問題

### 修正対応

**コード変更不要** (本リポジトリは既に `prisma.config.ts` で `DIRECT_URL || DATABASE_URL` の優先順を実装済):
```ts
// prisma.config.ts
datasource: {
  url: process.env['DIRECT_URL'] || process.env['DATABASE_URL'],
},
```

**Netlify env 設定のみ** (運用作業):
1. Supabase Dashboard → Project Settings → Database → Connection string で 2 つの URL を取得:
   - Transaction (6543): `postgresql://postgres.[ref]:[PW]@aws-0-[region].pooler.supabase.com:6543/postgres`
   - Session (5432): `postgresql://postgres.[ref]:[PW]@aws-0-[region].pooler.supabase.com:5432/postgres`
2. Netlify Dashboard → Environment variables で:
   - `DATABASE_URL` を Transaction pooler URL に**変更** (= 既存値が `db.*.supabase.co:5432` なら必須)
   - `DIRECT_URL` を Session pooler URL で**新規追加**
3. Trigger deploy → 成功

**docs 追記**: [DEPLOYMENT.md §2.0](../operations/DEPLOYMENT.md) で本パターンを明文化。

### 横展開

- 他の build 時 DB アクセスコマンド (`prisma db push` 等) も同じ問題に遭遇する → 全て DIRECT_URL 経由に
- 将来 Supabase を別 PaaS (AWS RDS, Neon 等) に移行する場合、本問題は発生しない (IPv4/IPv6 両対応)
- ローカル開発では `.env.local` の DATABASE_URL = `localhost:5432` で問題なし (= IPv6 制約なし)

### 関連
- KDD §5.X+77 (= 同じ PR #412 で build script を CI/Netlify 分離した、本件と同じ「build 時 DB 接続」が論点)
- DEPLOYMENT.md §2.0 (= 本件の運用手順)
- 元事象: PR #412 マージ直後の deploy log 6a0cf3e5
- Supabase 公式: https://supabase.com/docs/guides/database/connecting-to-postgres

---

## 5.X+83 **`prisma migrate deploy` 失敗時の `_prisma_migrations.finished_at=NULL` 残骸が次回 deploy で「未完了」と再解釈され、永久に同じエラーで失敗し続ける (2026-05-20 / PR #413 deploy 後)**

### 事象

PR #413 (Netlify env を Pooler URL に変更) 後の deploy で P1001 (IPv6) は解消したが、新たに以下のエラーで失敗:

```
Error: P3018
A migration failed to apply. New migrations cannot be applied before the error is recovered from.
Migration name: 20260523_cron_execution_log
Database error code: 42P07
ERROR: relation "cron_execution_logs" already exists
```

`_prisma_migrations` を確認すると **`20260523_cron_execution_log` は既に行として存在しているが `finished_at=NULL`** の状態。同様に **`20260416_add_actual_dates` も NULL 残骸が重複存在** (= 同名の完了済レコードが別途あるのに NULL 行も並存)。

### 根本原因

`prisma migrate deploy` の挙動:
1. migration 実行開始時に `INSERT INTO _prisma_migrations (started_at=NOW, finished_at=NULL, ...)`
2. SQL 実行
3. 成功 → `UPDATE _prisma_migrations SET finished_at=NOW WHERE id=...`
4. **失敗 → finished_at は NULL のまま放置** (rollback もされず、ただの「未完了」状態のレコードが永久に残る)
5. 次回 deploy 時は NULL 行を見て「**まだ完了していない migration がある**」と判断し、同じ migration を再実行 → 同じエラー (= 永久ループ)

本件 `20260523_cron_execution_log` は元々 `migration.sql` 冒頭コメントに「**手動適用 (Supabase SQL Editor):**」と書かれており、過去に手動適用された経緯がある。その時点では Netlify build に `prisma migrate deploy` が組み込まれていなかったため不整合は顕在化しなかったが、PR-V8.1 で `build:netlify` に migrate deploy を追加した瞬間に過去の負債が一斉に顕在化。

PR-V8.1 マージ直後の 1 回目 deploy で `prisma migrate deploy` が 20260523 を「未適用」と判定 → INSERT して CREATE TABLE → 失敗 → NULL 残骸生成。それが次回 deploy でも繰り返し参照される構造。

### 教訓

1. **`prisma migrate deploy` の失敗時、`_prisma_migrations` には NULL 残骸が残る**。これは Prisma の標準挙動で、自動 rollback しない
2. **「手動適用 (SQL Editor)」前提の migration は `_prisma_migrations` への INSERT も必須**。Prisma migrate を介さない DB 変更は記録漏れを生む
3. **NULL 残骸の修復は INSERT ではなく UPDATE (= 既存行の補正)**。INSERT を試みると主キー衝突や一意制約違反になる可能性
4. **重複 NULL 残骸 (= 同名の完了済が別途存在) は DELETE で安全に削除可**

### 修正対応

**コード変更不要**。DB レコード補正のみ:

```sql
-- ============ Step 1: 全 NULL 残骸を確認 ============
SELECT migration_name, started_at
FROM _prisma_migrations
WHERE finished_at IS NULL;

-- ============ Step 2: 既存 NULL を「適用済」に補正 (UPDATE) ============
-- 該当 migration の SQL が DB に既に反映されている場合
UPDATE _prisma_migrations
SET finished_at = NOW(),
    logs = '手動適用済 / NULL 残骸補正',
    applied_steps_count = 1
WHERE migration_name = '20260523_cron_execution_log'
  AND finished_at IS NULL;

-- ============ Step 3: 重複 NULL 残骸を DELETE ============
-- 同名の完了済レコードが別途存在する場合 (= 過去の失敗試行の残骸)
DELETE FROM _prisma_migrations
WHERE migration_name = '20260416_add_actual_dates'
  AND finished_at IS NULL;

-- ============ Step 4: 全 NULL が解消されたことを確認 (0 行が期待) ============
SELECT migration_name, started_at
FROM _prisma_migrations
WHERE finished_at IS NULL;
```

Step 4 で 0 行が返ったら Netlify Trigger deploy → 成功。

または `prisma migrate resolve --applied` CLI でも可能 (NULL 行があれば finished_at 補正):
```bash
DIRECT_URL="postgresql://...session-pooler:5432/postgres" \
  pnpm prisma migrate resolve --applied "20260523_cron_execution_log"
```

### 横展開・予防

1. **過去の手動適用 migration を全て棚卸し**: `prisma/migrations/*/migration.sql` で「手動適用 (SQL Editor)」コメントを grep → 該当全件で `_prisma_migrations` の記録有無を確認
2. **将来は SQL Editor 手動適用を廃止**: すべて `pnpm prisma migrate deploy` (= `DIRECT_URL` 経由) で適用に統一
3. **CONTRIBUTING.md / DEPLOYMENT.md に「migration は Prisma migrate CLI 経由でのみ適用」を明記**
4. **deploy 失敗時のロールバック手順を docs 化**: `_prisma_migrations` の NULL 残骸検知 + 修復 SQL をすぐ実行できるよう運用ガイド整備

### 関連
- KDD §5.X+77 (= PR #412 で `prisma migrate deploy` を build に組み込んだ、本件の前提)
- KDD §5.X+82 (= 同じ deploy が IPv6 で失敗、本件の前段)
- DEPLOYMENT.md §4.1 (= migration の運用フロー、要更新)
- Prisma 公式: https://pris.ly/d/migrate-resolve
- memory: `feedback_post_merge_branch_push.md` (= 本件対応中、PR #413 マージ後にブランチに追加 push して orphan commit を作る同種ミスも体験)

## 5.X+84 **NextAuth v5 + Netlify の Set-Cookie 脱落は signOut にも及ぶ ─ Cookie 削除に依存せず tokenVersion increment + layout 層 DB 照合で「実質削除」を達成、explicit-signout route も middleware matcher 除外必須 (2026-05-20 / PR fix/session-clearance)**

### 罠の正体

KDD §5.X+66 で「NextAuth v5 0-beta.31 + @netlify/plugin-nextjs では `useSession().update()` 経路の Set-Cookie がブラウザに脱落する」事象を記録済だった。当時は「ログイン時の Set-Cookie は正常」と書かれていたが、**signOut も同じ Function 応答パイプラインを通る**ため、`signOut()` (POST /api/auth/signout) が返す `Set-Cookie: Max-Age=0` も同様に脱落する事象を本番で実観測:

1. ユーザ A (テナント管理者) でログイン
2. ログアウトボタン → `signOut({ callbackUrl: LOGIN_ROUTE })` → POST /api/auth/signout
3. **サーバは正常に Set-Cookie で cookie 削除を返すが、Netlify Function 応答パイプラインで脱落** → ブラウザに旧 cookie が残留
4. /login 画面が表示される (= ユーザは「ログアウトできた」と認識)
5. ユーザ B (システム管理者) の credentials で `signIn('credentials', { redirect: false })`
6. **`signIn` の Set-Cookie も同経路で脱落するシナリオでは、旧 cookie が温存される**
7. `window.location.href = callbackUrl` → middleware は旧 JWT を検証 (= 署名は valid) → **ユーザ A のテナント管理者として着地** ← 「他人になりすます」事故

`(dashboard)/layout.tsx` の `auth()` も JWT 署名検証のみで通すため、旧 cookie 残留時に Server Component が**ユーザ A の tenantId で `listProjects()` 等を実行して画面に出してしまう**。

### なぜ発生するか

- NextAuth v5 の JWT セッションは**サーバ側で都度検証されない設計** (JWT 署名さえ通れば信用)。
- `tenantId` / `systemRole` は JWT claim に焼き込まれているのみで、middleware・layout 層では DB 照合が行われない。
- Netlify Function 応答パイプラインの仕様で `/api/auth/*` 系の Set-Cookie が一部脱落する (KDD §5.X+66 と同根)。

### 推奨対応 (本 PR で確立)

**「Cookie 削除に依存しない」設計に倒す**。Cookie が残っても無意味化する。

1. **自前 `POST /api/auth/explicit-signout` route を新設** ([src/app/api/auth/explicit-signout/route.ts](../../src/app/api/auth/explicit-signout/route.ts)):
   - **【P0】 `user.tokenVersion` を increment** (既存パターン `src/services/user.service.ts` を踏襲)。
     これで旧 JWT は API route (`getAuthenticatedUser`) / Server Component layout (`requireAuthForLayout`) 双方で 401 / redirect に倒れる
   - **【P0】 auth 系 4 cookie (`__Secure-authjs.session-token` / `authjs.session-token` / `__Host-authjs.csrf-token` / `authjs.csrf-token`) を `Max-Age=0` で削除** (両環境名を網羅して salt 判定ズレ事故を回避)
   - **【P1】 UI preference cookie (`tasukiba-theme`) も削除** (ユーザ要望: ログアウトでテーマもデフォルトに戻る)
     - 副作用なし: DB の `themePreference` は維持され、再ログイン時に [src/app/layout.tsx](../../src/app/layout.tsx) の `cookie > JWT > 'light' fallback` で復元
   - **べき等性**: 未認証 POST でも cookie 削除 Set-Cookie は付与 (残留 cookie 防御)
   - **失敗時は 500** で明示エラー (silent fail = ユーザに「ログアウトできた」誤認させない)

2. ★ **`/api/auth/explicit-signout` を middleware matcher から除外必須** ([src/middleware.ts](../../src/middleware.ts)):
   - KDD §5.X+69 / §5.X+71 と同型の罠。NextAuth v5 の `auth()` middleware wrapper が `/api/auth/*` 配下に対して**セッションリフレッシュ (旧 JWT 値で Set-Cookie 上書き) を行う**ことがあり、本 route の cookie 削除が打ち消される
   - 既存除外 (`api/auth/mfa/verify` / `api/tenants/me/i18n`) に `api/auth/explicit-signout` を追加
   - 本 route 自身が `await auth()` で認証チェック + DB tokenVersion increment を行うため、middleware 除外でも認証要件は維持

3. **Server Component 層に `requireAuthForLayout()` ヘルパを導入** ([src/lib/page-auth.ts](../../src/lib/page-auth.ts)):
   - `getAuthenticatedUser` ([src/lib/api-helpers.ts](../../src/lib/api-helpers.ts)) と同等の tokenVersion + isActive + deletedAt 検証を行い、失敗時は `redirect(LOGIN_ROUTE)`
   - `(dashboard)/layout.tsx` と `(dashboard)/admin/super/layout.tsx` の `auth()` 呼出を本ヘルパに差し替え
   - layout 配下の 28 page.tsx は個別修正不要 (Next.js は layout が redirect すれば配下の page を描画しない)

4. **`signIn` の前にも `explicit-signout` を pre-clear で呼ぶ** ([src/app/(auth)/login/page.tsx](../../src/app/(auth)/login/page.tsx)):
   - 旧 cookie が `/login` 着地時点で残留しているシナリオを想定。signIn 前に確実に破棄
   - pre-clear が失敗したら signIn を実行しない (= 中途半端な状態で signIn しない)

5. **既存の `signOut()` 呼出 2 箇所を全廃**:
   - [src/components/dashboard-header.tsx](../../src/components/dashboard-header.tsx) (ログアウトボタン)
   - [src/app/(auth)/login/mfa/mfa-form.tsx](../../src/app/(auth)/login/mfa/mfa-form.tsx) (MFA キャンセル)
   - いずれも `fetch('/api/auth/explicit-signout', { method: 'POST' }) + window.location.href` に置換

### 検証経路

- **単体テスト**: `src/app/api/auth/explicit-signout/route.test.ts` で「**5 種類の cookie 全てに Set-Cookie が含まれる**」を assert (KDD §5.X+66 の「set-cookie 存在を必ず assert」原則)
- **単体テスト**: `src/lib/page-auth.test.ts` で tokenVersion 不一致 / isActive=false / deletedAt!=null → `redirect(LOGIN_ROUTE)` を網羅
- **Netlify Deploy Preview** で実機確認 (ローカルでは Netlify 脱落を再現できないため必須):
  1. テナント admin でログイン → ログアウト
  2. DevTools > Application > Cookies で 5 cookie 全消去を確認
  3. /login がデフォルト light テーマで表示される (= テーマ cookie 削除確認)
  4. システム admin でログイン → 管理テナントに着地 (テナント admin のデータが一切表示されない)
  5. (失敗ケース) cookie 残留時でも `requireAuthForLayout` の tokenVersion 不一致検出で `/login` リダイレクト

### 過去の関連 KDD

- §5.X+66: 本件の前提となる Netlify + NextAuth Set-Cookie 脱落の初発見 (`useSession().update()` 経路)
- §5.X+68: 本件と同じく「DB 更新成功 + cookie サイレント失敗 = 200 OK」の組合せが致命的になる設計教訓 (helper 戻り値型を判別 union にする原則)
- §5.X+69: middleware の matcher 除外が必要な NextAuth `/api/auth/*` 経路の罠 (= 本件の `api/auth/explicit-signout` 除外の根拠)
- §5.X+71: 同型の罠で `api/tenants/me/i18n` を matcher 除外した前例

## 5.X+85 **UI=API 一致原則で API ハンドラを削除すると 405 が返るようになり、テナント越境 E2E の期待値配列に 405 を追加する必要がある (2026-05-20 / PR #416 E2E fail)**

### 発生事象

PR #416 (feat/crud-permission-redesign) で Phase 4「○○一覧/全○○ 削除の経路別認可」の一環として、横断 `/api/knowledge/[knowledgeId]` の PATCH ハンドラを **UI=API 一致原則** (UI から到達できない経路は API でも 403) に従い、**ハンドラごと削除**した。プロジェクト内更新は `/api/projects/[pid]/knowledge/[kid]` PATCH 経由で creator-only enforce される設計で、横断更新の経路は不要と判断。

CI で 1 件だけ E2E が失敗:

```
[chromium] › e2e/specs/11-tenant-isolation.spec.ts:198:7
  › PATCH /api/knowledge/[B-id] → 404 (越境 knowledge 更新不可)
  Error: expect(received).toContain(expected)
  Expected value: 405
  Received array: [400, 403, 404]
```

### 根本原因

旧仕様の挙動:
- 横断 `PATCH /api/knowledge/[knowledgeId]` は service 層 (`updateKnowledge`) で `existing.createdBy !== userId` → `FORBIDDEN` を throw → route が 403 を返す
- tenant 越境 (`findFirst` の `tenantId` フィルタで不一致) → `NOT_FOUND` → 404
- → 越境攻撃に対する期待値は `[400, 403, 404]`

新仕様 (PR #416 Phase 4):
- 横断 PATCH ハンドラ自体を削除 → Next.js の App Router は**未定義 HTTP method に対して自動的に 405 Method Not Allowed を返す**
- 越境攻撃を試行しても route がそもそも PATCH を受け付けないため 405

これは設計的により厳密な防御 (越境かどうか判定する前段でメソッド自体が閉鎖されている = fail-closed) だが、E2E テストが旧仕様の期待値配列 `[400, 403, 404]` のままだったため失敗。

### 教訓

UI=API 一致原則で **API ハンドラを削除する PR では、その endpoint を targeting している E2E テストの期待値配列に必ず 405 を追加する**。特に以下のテスト群:

- `e2e/specs/11-tenant-isolation.spec.ts` (越境攻撃)
- `e2e/specs/13-cross-tenant-defense.spec.ts` (もしあれば、tenant-isolation 系)
- `e2e/specs/*-security-*.spec.ts` (セキュリティ regression)

これらは「**越境攻撃 → 403 or 404 が返ることを期待**」の構造で書かれていることが多く、ハンドラ削除で 405 になると失敗する。期待値配列に 405 を含めて「method 自体閉鎖 = より厳密な防御」を明示するコメントを併記する。

### 適用された修正

`e2e/specs/11-tenant-isolation.spec.ts:198-211`:
```ts
test('PATCH /api/knowledge/[B-id] → 405 (越境 knowledge 更新経路は構造的に閉鎖)', async () => {
  // feat/crud-permission-redesign (2026-05-20, PR #416): 横断 `/api/knowledge/[knowledgeId]` の
  //   PATCH ハンドラを「UI=API 一致原則」に従い削除済み。プロジェクト内更新は
  //   `/api/projects/[pid]/knowledge/[kid]` PATCH 経由 (service 層で作成者本人のみ enforce)。
  //   そのため越境攻撃ベクトルとしては PATCH 405 (Method Not Allowed) が期待される。
  //   旧 200/400/403/404 期待値はハンドラ削除前の挙動で、新仕様では **構造的に到達不能**。
  const res = await adminARequest.patch(`/api/knowledge/${tenantB.knowledgeId}`, {
    data: { title: 'attacked' },
  });
  expect([400, 403, 404, 405]).toContain(res.status());
});
```

### 検証チェックリスト (E2E 期待値追従)

UI=API 一致原則で API ハンドラを削除する PR では、以下を必ず確認:

1. **ハンドラ削除した route を targeting する E2E spec を `grep` で全件抽出**
   - `grep -rn "fetch\|request\.\(get\|post\|patch\|put\|delete\)" e2e/specs/ | grep "<削除した path>"`
2. **各テストの期待値配列を確認**
   - `[200|201|400|403|404|409]` 系で書かれている場合、削除したメソッドのケースだけ `405` に置換または追加
3. **コメントで「ハンドラ削除済み = 構造的に到達不能」を明示**
   - 次回読者がテストの意図を誤解しないため
4. **`docs/test/E2E_LESSONS.md` に追記** (本 KDD と相互参照)

### 関連 KDD / PR

- PR #416 (feat/crud-permission-redesign): 本件の原因コミット
- KDD §5.X+57 (E2E 期待値網羅性): 期待値配列に必要なステータスコードを漏らさない原則
- ADR-0005 (RBAC + 二段階テナント認可): 越境防御の設計根拠

## 5.X+86 **security-check.ts の SQL injection ガードはコメント内のキーワードも文字列マッチで CRITICAL 検出する ─ Prisma の unsafe 系 API 名はコード本体だけでなくコメントからも除去する (2026-05-20 / PR #416)**

### 発生事象

PR #416 (feat/crud-permission-redesign) で 2 巡目検証 S1-G1 として、cron の duplicate execution gate に PostgreSQL advisory lock を追加した:

```ts
const result = await prisma.$queryRawUnsafe<{ pg_try_advisory_lock: boolean }[]>(
  `SELECT pg_try_advisory_lock(${key.toString()}) AS pg_try_advisory_lock`,
);
```

CI の Security Score Gate で CRITICAL 1 件検出 → スコア 80/100 で 90 閾値割れ:

```
F-01: SQLインジェクションリスク: $queryRawUnsafe / $executeRawUnsafe の使用
File: src/lib/cron-execution-log.ts (line 205)
Severity: CRITICAL
```

修正として `prisma.$queryRaw` タグドテンプレート (自動パラメータ化) に置換:

```ts
const result = await prisma.$queryRaw<{ pg_try_advisory_lock: boolean }[]>`
  SELECT pg_try_advisory_lock(${key}) AS pg_try_advisory_lock
`;
```

再実行も **スコア 80/100 のまま**。検出位置が `line 205` から `line 206` に変わっただけで再検出。

### 根本原因

`scripts/security-check.ts:402-405` の SQL injection 検出ロジック:

```ts
function checkUnsafeRawQuery() {
  const files = findFiles('src', f => f.endsWith('.ts') || f.endsWith('.tsx'));
  const pattern = /\$queryRawUnsafe|\$executeRawUnsafe/;
  for (const file of files) {
    const content = readFile(file);
    ...
```

**ファイル全体に対する単純な正規表現マッチ**で `$queryRawUnsafe` / `$executeRawUnsafe` を検出している。コード本体だけでなく **コメント内の同名キーワードもマッチ**してしまう。

私の修正コミットでは「旧実装は `$queryRawUnsafe` で…」というコメントを残していたため、Prisma 呼び出し自体は安全な `$queryRaw` に置換済みでも CRITICAL が消えなかった。

### 教訓

**Prisma の unsafe 系 raw query API 名 (`$queryRawUnsafe` / `$executeRawUnsafe`) は、コード本体だけでなくコメント / docstring / 変更履歴コメントからも完全に除去する**。代替表記:

- 「unsafe 系 raw query API」
- 「raw 文字列補間版」「タグドテンプレート版」と対比的に呼ぶ
- 必要なら `$queryRaw` + 別行で `*Unsafe* 系` のように分断

### 検証手順

PR で raw query を扱う実装を追加・修正するときは、**ローカルで `pnpm tsx scripts/security-check.ts --min-score=90` を必ず実行**してから push する。CI まで気付かないと re-run コスト + レビューブロックが発生する。

### スクリプト側の改善余地 (本 PR スコープ外)

`security-check.ts` の検出パターンを改善する案:
1. コメント行 (`//`, `/* */`) を除外してから正規表現マッチ
2. AST ベース検出 (typescript-eslint や ts-morph 経由) に変更
3. 検出パターンを「関数呼び出し形式」(`$queryRawUnsafe(...)`)  に限定: `/\$queryRawUnsafe\s*\(/`

ただしいずれも本 PR スコープ外。当面は **コメントから unsafe API 名を除去する運用** で回避する。

### 関連 KDD / PR

- PR #416 (feat/crud-permission-redesign): 本件の原因コミット (S1-G1 advisory lock 追加)
- `.github/workflows/security.yml`: 90 点閾値の CI ガード
- `scripts/security-check.ts`: 検出ロジック
- KDD §5.X+85 (UI=API 一致原則によるハンドラ削除と E2E 期待値追従): 同 PR で発見された別の CI fail パターン

## 5.X+87 **再帰 sanitize 関数で `Object.entries` の key を信頼して書き込むと CodeQL が Remote property injection (prototype pollution) を HIGH 検出する ─ `Object.create(null)` + 特殊キー除外で二重防御する (2026-05-20 / PR #416)**

### 発生事象

PR #416 (feat/crud-permission-redesign) で 2 巡目検証 S2-E1 として `sanitizeForAudit` を以下のように拡張した:

```ts
export function sanitizeForAudit(
  obj: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_FIELDS.has(key)) {
      sanitized[key] = '[REDACTED]';
    } else if (depth < 5 && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      sanitized[key] = sanitizeForAudit(value as Record<string, unknown>, depth + 1);
    } else if (...) {
      sanitized[key] = value.map(...);
    }
  }
  return sanitized;
}
```

CI の CodeQL が **HIGH severity × 2** を検出:

```
CodeQL: 2 new alerts including 2 high severity security vulnerabilities
src/services/audit.service.ts:179 - Remote property injection
src/services/audit.service.ts:181 - Remote property injection
```

### 根本原因

`Object.entries(obj)` の `key` は外部入力 (audit_logs に渡される DTO に含まれる user data) 由来の可能性がある。`sanitized[key] = ...` の動的キー書き込みで、攻撃者が以下のような payload を送ると **prototype pollution 攻撃** が成立し得る:

```json
{ "__proto__": { "isAdmin": true } }
```

これが `sanitized.__proto__` に書き込まれると、**JavaScript の全 object に対して `isAdmin = true` が伝播**する (Object.prototype に汚染が及ぶため)。後続のコードで `if (user.isAdmin)` が予期しない true を返し、認可 bypass や情報漏洩につながる。

CodeQL の `js/prototype-polluting-assignment` ルール (Remote property injection) は、**動的キー書き込み + key が untrusted source 由来** の組み合わせを HIGH として検出する。

### 教訓 + 修正パターン

外部入力の key を動的にプロパティとして使う関数は、**以下 3 つの防御を必ず実装する**:

#### 1. `Object.create(null)` で prototype-less object を作る
親プロトタイプチェーンを持たない pure dictionary にすると、`__proto__` への書き込みが Object.prototype に伝播しない。

```ts
const sanitized: Record<string, unknown> = Object.create(null);
```

#### 2. 特殊キーを書き込み対象から完全除外
`__proto__` / `constructor` / `prototype` の 3 つは prototype pollution の典型的な攻撃ベクトル。早期 continue で無視する。

```ts
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
for (const [key, value] of Object.entries(obj)) {
  if (FORBIDDEN_KEYS.has(key)) continue;
  // ...
}
```

#### 3. `Object.defineProperty` で書き込み (CodeQL の警告を更に減らす)
`sanitized[key] = value` ではなく `Object.defineProperty(sanitized, key, { value, ... })` を使うと、prototype チェーン経由の setter 攻撃も防げる。

```ts
Object.defineProperty(sanitized, key, {
  value: ..., writable: true, enumerable: true, configurable: true,
});
```

### 検証手順

PR で動的キー書き込み (`obj[key] = ...`) を含む関数を追加・修正したら、**ローカルで CodeQL チェックは難しいため、push 後に PR の checks 画面で CodeQL の結果を確認**する。GitHub Advanced Security の有料機能のため、organizations によっては自前で `semgrep` / `eslint-plugin-security` で検出する代替手段も検討。

### 関連 KDD / PR

- PR #416 (feat/crud-permission-redesign): 本件の原因コミット (S2-E1 sanitizeForAudit 拡張)
- CodeQL ルール: `js/prototype-polluting-assignment` (CWE-915 Improperly Controlled Modification of Dynamically-Determined Object Attributes)
- KDD §5.X+85 (UI=API 一致原則のハンドラ削除 + E2E 期待値): 同 PR の別 CI fail
- KDD §5.X+86 (security-check.ts のコメント文字列マッチ問題): 同 PR の別 CI fail

## 5.X+88 **CodeQL の Remote property injection は `Object.defineProperty` でも依然 HIGH 検出する ─ 動的キー書き込みを使わず JSON.stringify(obj, replacer) で sanitize する (2026-05-20 / PR #416)**

### 発生事象

KDD §5.X+87 で報告した CodeQL Remote property injection 警告に対し、以下の 3 重防御で対策した:

1. `Object.create(null)` で prototype-less object
2. `FORBIDDEN_KEYS` (`__proto__` / `constructor` / `prototype`) を `continue` で除外
3. `sanitized[key] = value` を `Object.defineProperty(sanitized, key, { value, ... })` に変更

しかし **CodeQL は依然 HIGH × 3 を検出**:

```
src/services/audit.service.ts:194 - Remote property injection
src/services/audit.service.ts:199 - Remote property injection
src/services/audit.service.ts:208 - Remote property injection
```

`Object.defineProperty` の第 2 引数も「動的に決まるキー」として CodeQL の dataflow 解析が追跡してしまう。前段の `FORBIDDEN_KEYS` ガードは static 解析では「外部入力起因の key」を tainted のままとして扱うため、警告が解除されない。

### 根本原因

CodeQL の `js/prototype-polluting-assignment` ルールは **「動的キー書き込み + key が外部由来」** という静的パターンで検出する。実行時に FORBIDDEN_KEYS でフィルタしても、CodeQL の解析時点では dataflow が切れないため検出される。

`Object.defineProperty(target, key, descriptor)` の `key` 引数も同様に「動的なプロパティ書き込み」として CodeQL は警告対象に含める。

### 解決策

**動的キー書き込みを完全に廃止し、`JSON.stringify` の replacer 関数 + `JSON.parse` で sanitize**:

```ts
export function sanitizeForAudit(obj: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(obj, (key, value) => {
    if (key === '') return value; // root
    if (FORBIDDEN_KEYS.has(key)) return undefined; // 完全除外
    if (SENSITIVE_FIELDS.has(key)) return '[REDACTED]'; // 機微フィールド redact
    return value;
  });
  const parsed = json ? JSON.parse(json) : {};
  return (typeof parsed === 'object' && parsed !== null) ? parsed : {};
}
```

利点:
- `JSON.stringify` の replacer は **each key で呼ばれ、`undefined` を返すと該当 key を出力から省略**
- nested object / 配列も replacer が **再帰的に呼ばれる**ため独自再帰実装不要
- 結果の `JSON.parse` は plain object を生成し、`__proto__` 等の特殊キーは自然に脱落
- **動的プロパティ書き込みが発生しない**ため CodeQL の警告を構造的に回避

### 教訓

1. **CodeQL Remote property injection の検出ルールは厳しい**: runtime ガード (FORBIDDEN_KEYS filter) を入れても dataflow 解析は警告解除しない
2. **`Object.defineProperty` も dataflow 上は動的キー書き込みと同等**: 修正アプローチとしては効かない
3. **JSON.stringify の replacer は dataflow を切る**: replacer で key を見て分岐するパターンは CodeQL の解析範囲外
4. **将来の検出対策**: 動的キー書き込みを必要とする場面では JSON ベース実装を第 1 候補に
5. **trade-off**: JSON.stringify/parse のオーバーヘッドは audit log のような低頻度処理では無視できる。ホットパスでは別パターンを検討

### 関連 KDD / PR

- PR #416 (feat/crud-permission-redesign): 本件の原因コミット (S2-E1 拡張 → §5.X+87 修正 → 本件の §5.X+88 修正)
- KDD §5.X+87 (前段): `Object.create(null)` + FORBIDDEN_KEYS による初回対策 (CodeQL は依然警告)
- CodeQL ルール: `js/prototype-polluting-assignment` (CWE-915)

## 5.X+89 **`User.email` を global UNIQUE のまま運用すると tenant 削除直後の email 再利用 / 同個人の複数 tenant 所属で UNIQUE 違反 500 になる ─ `@@unique([tenantId, email])` に組み替え、pre-auth フローは全て tenantSlug 必須化する (2026-05-20 / PR feat/multi-tenant-user-membership)**

### 発生事象

- 旧 schema (`@@unique([email])`) では「テナント A を解約 → 同 email でテナント B を新規作成」が UNIQUE 違反で 500
- 「同一個人が 顧客テナント + 自社運営テナント の両方に所属する」業務要件にも対応不可
- 既存のテナント削除運用 (= soft-delete) では email row が残るため、 再利用すると Prisma が P2002 を返却 → API が 500

### 根本原因

- 旧仕様は B2C SaaS 想定 (1 person = 1 email = 1 account) を引きずっていた
- B2B multi-tenant の標準は **`(tenant, email)` の複合一意** (Slack / Notion / GitHub Org)
- email を tenant 跨ぎ一意にすると、複数組織所属が必要なシナリオで詰む

### 解決策

1. **Schema 変更**: `@@unique([email])` → `@@unique([tenantId, email])`
2. **Pre-auth フローを全て tenantSlug 必須化**:
   - login (`/login` UI に 組織 ID 入力欄追加 / NextAuth authorize で `(email, tenantId)` 複合検索)
   - lock-status (`/api/auth/lock-status`: tenantSlug 必須)
   - password-reset (`verifyAndIssueResetToken` 第 3 引数で tenantSlug 必須化)
   - email-verification (send 時に `tenant.slug` を URL に埋め込み)
3. **enumeration 防止**: tenant 不存在 / user 不存在は **同一の汎用エラー** (`{status: 'none'}` or 「正しくありません」) を返す
4. **migration**: 全 user の `tokenVersion` を +1 して既存セッションを失効 (= multi-tenant 経路に再ログインで乗せる)
5. **URL helper の抽出**: `src/lib/url-builder.ts` (= 将来 Option A = subdomain 移行を容易化)
6. **EMAIL_CONFLICT 廃止**: tenant-onboarding の union 型から削除 (発生不能になったため)

### 教訓

1. **B2B SaaS で email を global UNIQUE にしてはいけない**: 同個人の複数組織所属が物理的に不可になる
2. **multi-tenant 移行は `(tenant, X) 複合化` + `pre-auth フロー再設計` の 2 段構え**: schema だけ変えても pre-auth が email 単独検索のままだと AmbiguousMembership で別 tenant の user を返す事故が起きる
3. **enumeration 攻撃面の維持**: tenant 不存在 / user 不存在を同一エラーで返さないと、攻撃者がメール在籍を絞り込み可能になる
4. **JWT は schema 切替時に必ず invalidate**: 旧 schema 想定の token が残ると次のログイン時の挙動が予測不能 (= tokenVersion increment が最小コスト)
5. **将来の subdomain 移行を考慮**: URL builder を一元化しておくと、`/login?tenant=foo` → `foo.app.example.com/login` への切替が helper 差し替えだけで済む
6. **メール URL に tenant 埋め込み**: `?tenant=<slug>` を URL クエリに付与しないと、新規招待メール経由でログイン UI が空欄になる UX バグになる

### 検証手順

```sql
-- 移行可能性チェック (期待値: 0 件)
SELECT email, COUNT(DISTINCT tenant_id) AS tenants
FROM users
WHERE deleted_at IS NULL
GROUP BY email
HAVING COUNT(DISTINCT tenant_id) > 1;
```

詳細な検証手順は [docs/operations/MULTI_TENANT_USER_MIGRATION_VERIFICATION.md](../operations/MULTI_TENANT_USER_MIGRATION_VERIFICATION.md) 参照。

### 関連 KDD / PR

- PR feat/multi-tenant-user-membership (本 PR): 原因コミット + ADR-0016
- ADR-0016: [docs/adr/0016-multi-tenant-user-membership.md](../adr/0016-multi-tenant-user-membership.md) (設計判断記録)
- 検証手順: [docs/operations/MULTI_TENANT_USER_MIGRATION_VERIFICATION.md](../operations/MULTI_TENANT_USER_MIGRATION_VERIFICATION.md)
- KDD §5.X+72 (前提): セッション解除パターン (tokenVersion increment 設計)

## 5.X+90 **multi-tenant 化 + データ import API がある SaaS で「Beginner 90日試用」を提供すると import 経由の半永久 abuse が成立する ─ 既登録 email は Beginner 払い出し不可化 + UI で事前ヒント (Phase 10 / ADR-0016 強化)**

### 発生事象

ADR-0016 で同一個人が複数テナントに所属可能になったことで、以下の abuse パターンが浮上:

1. テナント A (Beginner) を email=X で開設
2. 90日経過直前にデータを ZIP エクスポート
3. テナント A 削除
4. 同 email=X で テナント B (Beginner) を新規払い出し
5. 旧 ZIP を import → 過去蓄積を引き継ぎ
6. **新たな 90日試用枠を獲得** (= 1〜5 を繰り返せば半永久に Beginner)

### 根本原因

- ADR-0016 で email 共存を許可した結果、「同一個人が複数 Beginner テナント開設」が物理的に可能になった
- データ import API (`POST /api/tenants/me/import`) は plan 区別なくフル機能を提供していた
- 旧 P-B (BEGINNER_NOT_AVAILABLE_FOR_RETURNING) は **「解約済テナント (deletedAt: not null) 限定」** のチェックで、現役テナント並行運用での abuse は防げなかった

### 解決策

1. **P-B 強化**: tenant-onboarding.service.ts の判定を「`deletedAt: { not: null }` フィルタ削除」=
   **過去/現在を問わず**どこかに登録履歴のある email は Beginner 不可 (`BEGINNER_REQUIRES_UPGRADE`)
2. **UI 事前ヒント**: 新規 API `POST /api/auth/check-tenant-eligibility` (UI 専用) で
   メール入力時 onBlur で Beginner 可否を判定。Beginner radio を disable + Expert/Pro 誘導 CTA を表示
3. **Defense-in-depth**: サーバ層が `BEGINNER_REQUIRES_UPGRADE` を必ず返す (UI チェック bypass されても安全)
4. **既登録判定対象**: tenants.billing_contact_email / users.email の OR (削除済 user 含む) =
   旧 P-B の 4 axis 維持 (= billingContactEmail / initialAdminEmail の組み合わせ)

### 教訓

1. **multi-tenant 化と「無料試用」プランは abuse 設計上の衝突点**: import 機能がある場合は特に
   既存ユーザ判定を厳格化しないと無限延長が成立する
2. **削除済データだけ見る abuse-prevention は不十分**: 現役並行運用での重複も同じリスク (= ZIP 持ち回せる)
3. **エラー vs UI 誘導の分離**: 「BEGINNER_NOT_AVAILABLE エラーで詰まる」UX は離脱要因。
   フロント側で事前判定してプラン選択 UI を変化させると、ユーザは即座に Expert/Pro を選択できる
4. **defense-in-depth で UI 層を信頼しない**: UI は速度/UX 最適化のためのヒントで、最終判定はサーバ層

### 関連 KDD / PR

- PR feat/multi-tenant-user-membership (本 PR Phase 10): 原因 + 修正
- KDD §5.X+89 (前段): ADR-0016 本体の multi-tenant 設計
- ADR-0016 §Risk: 本 abuse パターンの記録

## 5.X+91 **WBS のような階層エンティティで「同階層名称重複」を level + name で判定すると別 WP 配下の同名 ACT を誤ブロックする ─ parent (parentRowIndex / parentTaskId) を含めたキーで判定する (2026-05-25 / PR #420 [A1/A2])**

### 発生事象

WBS タスク CSV インポートで、以下のような正当なユースケースがブロッカー判定されてプレビュー画面から進めない事象が報告された:

```
WP-A
├ AACT
├ BACT
├ CACT
└ DACT
WP-B
├ AACT  ← 同階層 (level=2) で同名だが別 WP 配下
├ BACT  ← (実務でよくある「設計レビュー」「結合テスト」等の繰り返し)
├ CACT
└ DACT
```

エラー: 「同階層・同名のタスクが CSV 内に複数あります」

### 根本原因

`task-sync-import.service.ts` の duplicateNames 判定キーが `${level}::${name}` だった。コードコメント自身が「本来は level+parent+name で判定すべき」と認める実装簡略化。

DB 既存タスクとの「誤コピー検知」も同様に `existingByName` が name 単独 Map で、project 全体スコープで「他 WP 配下の同名」も誤検知していた。

### 解決策

1. **parser 拡張**: `SyncImportRow` に `parentRowIndex: number | null` を必須フィールド化。`parseSyncImportCsv` 内で level スタックから動的に決定して埋め込む
2. **CSV 内重複キー**: `${parentRowIndex ?? '__root__'}::${name}` で判定 (= 同一親配下のみ重複扱い)
3. **DB 既存重複キー**: `existingByParentAndName: Map<string, DbTaskSnapshot[]>` で `(parentTaskId, name)` インデックス
4. **CREATE 親が CREATE の場合**: `parentIsCsvCreate=true` で DB 照合をスキップ
5. **3 経路の整合性**: CSV 内 / DB 既存 / 仕様書 (SCREENS.md) の文言を全て「同一親配下」に統一

### 教訓

1. **階層エンティティの重複判定は必ず parent + name のスコープで行う**: level + name は構造上の妥協であり、実務シナリオを誤検知する
2. **コードコメントの「本来は～すべき」は技術負債のフラグ**: 簡略化を選ぶ場合、ユーザ影響をレビューで検出して直す
3. **DB 制約 (UNIQUE) と app 層検知の二重防御を整合させる**: スコープを揃えないと「app 層 OK / DB NG」or「app 層 NG / DB OK」のズレが発生
4. **横展開先**: 将来 Knowledge / Retrospective 等にも親子関係を持たせる場合、同じ pattern で実装する

### 関連 KDD / PR

- PR #420 feat/wbs-import-uplift (本 PR): 修正コミット 6d49e49
- ADR-0017 (本 PR で追加): WBS sync-import と bulk-duplicate の設計決定
- KDD §5.X+92 (関連): WBS 一括複製での集計再計算順序
- KDD §5.X+93 (関連): OCC (Optimistic Concurrency Control) パターン

## 5.X+92 **PgBouncer 制約で $transaction が使えない環境では bulk INSERT 後の集計再計算を「呼出順序に依存しない idempotent な recalc」で組み立てる ─ task-duplicate.service.ts の WP 集計漏れ修正 (2026-05-25 / PR #420)**

### 発生事象

WBS タスク一括複製 (`POST /api/projects/.../tasks/bulk-duplicate`) で、WP + ACT を同時に複製した時、新規 WP の `plannedEffort` が 0 のまま DB に残るバグが発生。

例: ユーザが `WP-A (effort=5, 子 ACT-X effort=3 + ACT-Y effort=2)` を含む 3 件選択 → root に複製 → 結果:
- WP-A' (effort=0) ← **本来は 5 になるべき**
- ACT-X' (effort=3)
- ACT-Y' (effort=2)

### 根本原因

`task-duplicate.service.ts` のステップ 10 で `recalculateAncestorsPublic(targetParent.id)` を呼出していたが、これは「targetParent の集計と上方伝播」のみ。新規作成 WP の集計はトリガされていなかった。

加えて `recalculateAncestors` の挙動として:
- **WP 引数**: 自身を recalc + 親に伝播
- **ACT 引数**: **no-op** (親に伝播もしない!)

→ 新規 ACT 子から自動 rollup される、ということは無い。

### 解決策

```typescript
// 影響を受ける全 WP を集めて recalc を呼ぶ (順不同で OK)
const affectedWpIds = new Set<string>();
for (const s of sortedSources) {
  if (s.type === 'work_package') {
    const newId = oldToNewId.get(s.id);
    if (newId) affectedWpIds.add(newId);
  }
}
if (targetParent) affectedWpIds.add(targetParent.id);

// 順不同で OK: 各 call が自身を recalc → 親に伝播するので最終整合する
for (const wpId of affectedWpIds) {
  await recalculateAncestorsPublic(wpId);
}
```

### 教訓

1. **`recalculateAncestors` のメンタルモデルを誤らない**: 「先祖を再計算」だが、ACT 引数では何もせず、WP 引数では自身も含めて再計算する非対称仕様。利用箇所では必ず WP id を渡す
2. **PgBouncer 制約 (`$transaction` 不可) 環境での bulk INSERT 後処理は idempotent に**
3. **集計対象を Set で集める + 順不同実行**: 順序が誤って outer-first になっても上方伝播で最終整合する
4. **テストで affected WP の recalc 呼出を verify**: spy/mock で `recalculateAncestorsPublic.toHaveBeenCalledWith(<newWpId>)` を assert

### 関連 KDD / PR

- PR #420 feat/wbs-import-uplift commit 596f17b
- src/services/task-duplicate.service.ts:316-329

## 5.X+93 **PgBouncer 制約で advisory lock も使えない環境では「dry-run snapshot の最大 updatedAt を client → header 経由で apply に持ち回す OCC」で並行編集を検出する (2026-05-25 / PR #420 [C2])**

### 発生事象

WBS sync-import の dry-run (プレビュー) と本実行の間に、別ユーザが同じ project の task を更新すると、本実行が「ユーザが見ていない最新 DB 状態」に対して適用されて意図しない差分になる可能性。

通常の RDB なら `SELECT ... FOR UPDATE` や `pg_advisory_xact_lock` で防げるが、本プロジェクトは PgBouncer transaction mode を採用しており **`prisma.$transaction` も advisory lock も使用不可**。

### 解決策

OCC (Optimistic Concurrency Control) を採用:

1. **dry-run**: `computeSyncDiff` が project 配下 task の **最大 `updatedAt`** を `snapshotAt` として返す
2. **client**: dry-run response の snapshotAt を保持し、本実行時に `x-import-snapshot-at` HTTP header に添えて送信
3. **本実行**: server 側で再取得した `snapshotAt` と header の `expectedSnapshotAt` を比較
4. **不一致**: `IMPORT_CONCURRENT_EDIT` (HTTP 409) を返して中断 (= 他ユーザが dry-run 後に更新したことを検出)
5. **旧 UI (header 未送信)**: best-effort で OCC スキップ (= 移行期の互換性)

### 教訓

1. **PgBouncer 環境では transaction-level lock を諦め、application-level OCC で並行制御**
2. **snapshot キーには `max(updatedAt)` が最適**: 全タスクの updatedAt を取得済なので追加 query 不要、かつどの行が変わっても snapshot が変わる
3. **best-effort skip で migration 期間を吸収**: header 未送信は OCC skip。旧 UI が混在しても error にならない
4. **複数 application instance でも OK**: app 側で lock 状態を共有不要 (= 全部 DB 経由で確認するため)

### 関連 KDD / PR

- PR #420 feat/wbs-import-uplift commit 6d49e49 (C2 OCC 実装)
- src/services/task-sync-import.service.ts (snapshotAt 取得 + apply 時比較)
- ADR-0017 (本 PR): 設計決定の記録

## 5.X+94 **localStorage で「過去ログイン履歴」を保持する場合、保存値の型・形状・期限を読込時に全件検証して XSS 由来の改竄を破棄する (2026-05-25 / PR #420 ログイン UX 改修)**

### 発生事象

ログイン画面で組織 ID (tenantSlug) の手入力負担を減らすため、localStorage に直近 5 件の `(slug, name, lastUsedAt)` を LRU 保存する機能を追加。`<datalist>` でプルダウン候補表示する。

XSS が万一発生したら攻撃者が localStorage に細工データを書き込み、次回ログイン時に組織名のなりすまし (フィッシング誘導) が可能になる懸念。

### 解決策

`src/lib/tenant-history.ts` の `validateEntry()` で **読込時に全件検証**:

- slug pattern (lowercase + digit + hyphen, 1-63 chars)
- name 長 (1-100 chars)
- lastUsedAt は ISO8601 parsable + 90 日以内
- 未来日時 (1 分以上先) も拒否 (時計巻き戻し / 改竄対策)

**読込時の浄化**: 不正データを発見したら `safeWrite(valid)` で localStorage を書き戻し、後続呼出で再検証が走らないようにする。

**XSS DOM 経路の遮断**: 表示は React JSX のテキストノード経由 (`<option value={entry.slug}>{entry.name}</option>`) で自動 escape。innerHTML 系 API 不使用を担保。

### 教訓

1. **localStorage は「ユーザブラウザの中の信頼境界」**: 自サイトの過去状態だが、XSS で攻撃者に書き換えられる可能性ありとして読込時に検証
2. **保存値の検証 5 軸**: 型 / 形状 (regex) / 長さ / 時系列 (ISO8601 + 範囲) / 個数 (LRU 上限)
3. **`mockResolvedValueOnce` で test mock leak を防ぐ**: 「count を 1 にする」テストの直後に「default 0」前提のテストが続くと、`mockResolvedValue` が leak して別テストが落ちる
4. **post-auth で tenantName を取得**: pre-auth で `/api/tenants/by-slug` 等を作ると email enumeration の email → tenant マッピング露出に近い問題が出る。`GET /api/auth/current-tenant-info` (認証必須、自テナントのみ) を post-auth で 1 度だけ呼んで `(slug, name)` を localStorage に焼き付ける

### 関連 KDD / PR

- PR #420 feat/wbs-import-uplift commit e445433 (localStorage 履歴実装)
- src/lib/tenant-history.ts (CRUD + 検証)
- src/lib/tenant-history.test.ts (15 ケース)
- src/app/api/auth/current-tenant-info/route.ts (post-auth name 取得 endpoint)

## 5.X+95 **DB UNIQUE 制約を追加するときは「app 層の既存全 INSERT/UPDATE 経路」を網羅し、全経路で事前検知 → 400 に変換する。さもないと P2002 → 500 で UX が壊れる (2026-05-25 / PR #420 [C3])**

### 発生事象

PR #420 で `tasks(project_id, parent_task_id, name) WHERE deleted_at IS NULL` の部分 UNIQUE インデックスを追加。本 PR の新規経路 (sync-import / bulk-duplicate) では app 層で事前にリネーム or 検知していたが、**既存の `POST /tasks` 単一作成 / `PATCH /tasks/[id]` 単一編集** には事前チェックがなく、UI から同名タスクを操作すると Prisma P2002 → 500 エラーで UX が破壊される退行リスクが残存していた。

(本問題は 3 回目のフルレビューで検出。マージ前に救済修正済)

### 解決策

`src/services/task.service.ts` に共通ヘルパ `assertTaskNameUniqueInParent` を追加し、`prisma.task.count` で事前検知。`createTask` (name+parent 指定時) と `updateTask` (name/parent 変更時、自身除外) に挿入。route.ts で try/catch して `TASK_NAME_DUPLICATE_IN_PARENT` を 400 + ユーザフレンドリーメッセージに変換。

**`findFirst` を避けて `count` を使う理由**: 既存テストの `findFirst` mock と衝突して false positive を起こすため。`count` は他箇所であまり mock されないので衝突しにくい。

### 全 INSERT/UPDATE 経路の網羅性確認

| 経路 | app 層防護 |
|---|---|
| `POST /tasks` | ✅ createTask で assertTaskNameUniqueInParent |
| `PATCH /tasks/[id]` | ✅ updateTask で assertTaskNameUniqueInParent |
| `PATCH /tasks/bulk-update` | ✅ name 非対応 (zod schema で受け付けない) |
| `PATCH /tasks/[id]/progress` | ✅ name 非対応 |
| `POST /tasks/sync-import` | ✅ computeSyncDiff の dry-run 検証 (A1/A2) |
| `POST /tasks/bulk-duplicate` | ✅ pickNonConflictingName で自動リネーム |

### 教訓

1. **DB 制約追加は app 層の全経路レビューが必須**: 新規機能 (sync-import / duplicate) だけでなく **既存の単一作成・編集・bulk 系・cron** 等まで網羅して P2002 → 500 を防ぐ
2. **新規 PR でレビューを 3 回繰り返したら 1 件ずつ追加 bug が出るのは想定内**: PR scope が大きい場合、横断的影響は 1 回のレビューで全部は見つからない。マルチパスレビューを許容する
3. **テスト mock の leak 防止**: `mockResolvedValue` ではなく `mockResolvedValueOnce`、あるいは default 値を mock factory で設定
4. **エラーメッセージは業務文言で**: 「TASK_NAME_DUPLICATE_IN_PARENT」ではなく「同じ親 WP の配下に同じ名称のタスクが既に存在します」と返す

### 関連 KDD / PR

- PR #420 feat/wbs-import-uplift commit f7bf8f2 (本修正)
- KDD §5.X+91 (関連): 階層重複判定の親スコープ化
- KDD §5.X+93 (関連): OCC で並行編集検出
- ADR-0017 (本 PR): 設計決定の記録

## 5.X+96 **ログイン画面に「ログイン」を含む文言のボタンを追加すると既存 E2E の `getByRole('button', { name: 'ログイン' })` (substring match) が strict mode 違反になる ─ ボタン文言から「ログイン」を除く + fixture を `{ exact: true }` 化する (2026-05-25 / PR #420 CI 失敗修正)**

### 発生事象

PR #420 でログイン画面に「ログイン履歴をクリア」リンクボタンを追加した結果、CI の Playwright E2E が 5 件失敗:

1. `e2e/specs/01-admin-and-member-setup.spec.ts:167` (MFA 再ログイン)
2. `e2e/specs/02-project-detail-tabs.spec.ts:186` (chromium / chromium-mobile)
3. `e2e/visual/auth-screens.spec.ts:20` (visual baseline、後述 §5.X+97 参照)

エラー (上位 2 種):
```
Error: locator.click: Error: strict mode violation:
getByRole('button', { name: 'ログイン' }) resolved to 2 elements:
    1) <button type="button">ログイン履歴をクリア</button>
    2) <button type="submit">ログイン</button>
```

### 根本原因

Playwright の `getByRole('button', { name: 'ログイン' })` は **デフォルトで substring match** (= name に「ログイン」を含む全要素にマッチ)。既存 E2E (18 ファイル / `e2e/fixtures/auth.ts:92`) はログイン送信ボタンが唯一の「ログイン」を含むボタンであることに依存していた。

PR #420 で「ログイン履歴をクリア」リンクボタンを追加 → name に「ログイン」を含む 2 つの button が共存 → strict mode violation。

### 解決策

**Fix 1 (主)**: i18n の `tenantHistoryClearLink` を「履歴をクリア」に変更し、「ログイン」を含む文言の重複を解消
- `src/i18n/messages/ja.json`: `"ログイン履歴をクリア"` → `"履歴をクリア"`
- `src/i18n/messages/en-US.json`: `"Clear sign-in history"` → `"Clear history"`
- これで substring match で submit ボタンのみ一致

**Fix 2 (防御)**: `e2e/fixtures/auth.ts` の loginAsGeneral helper に `{ exact: true }` を追加
- 将来「ログイン...」を含む新規ボタンが追加されても破綻しない
- 既存の 17 spec ファイルは fixture 経由なので Fix 1 だけで通る (= 個別修正不要)

### 教訓

1. **`getByRole({ name })` は substring match がデフォルト**: 「ログイン」のような汎用語を name に持つ要素は将来衝突しやすい。新ボタンを追加する際は既存 E2E の locator 戦略をチェックする
2. **i18n 文言設計は E2E 影響を考慮する**: ユーザに見せる文言として「ログイン履歴」は自然だが、E2E テスト的には「ログイン」を含む文言は脆弱性となる。short prefix と context 依存表現で衝突を避ける
3. **fixture には `{ exact: true }` を予防的に付ける**: テキストが完全一致前提のところは exact を明示すると、将来 i18n 変更や UI 追加で破綻しない
4. **対称的に: aria-label / datalist / option 等は `getByRole('button', ...)` にマッチしないので「ログインした組織」のような文言は安全**: 要素の role を理解して命名する

### 横展開チェック (新 UI 追加時の self-review)

新規 button / link を追加する際、以下を確認:
- 既存 E2E で `getByRole('button', { name: '<短い単語>' })` (substring) が使われているか grep
- 追加ボタン名がその単語を含むなら、文言変更 or fixture 側を `{ exact: true }` 化
- 特に頻出キーワード: 「ログイン」「保存」「削除」「キャンセル」「実行」「適用」「OK」「閉じる」

### 関連 KDD / PR

- PR #420 feat/wbs-import-uplift commit <次の修正 commit>
- KDD §5.X+97 (続き): Visual regression baseline 再生成パターン

## 5.X+97 **ログイン画面の UI を変更したら visual regression test の baseline 画像が outdated になる ─ `[gen-visual]` タグ付き commit で baseline 自動再生成 workflow を発火する (2026-05-25 / PR #420 CI 失敗修正)**

### 発生事象

PR #420 でログイン画面の UI を変更:
- 「組織 ID がわからない場合は管理者へ問合せ」ヒント追加
- 「共用 PC では履歴を残さないことを推奨」注意喚起追加
- 「履歴をクリア」リンクボタン追加
- datalist プルダウン用の組織 ID 入力欄調整

CI の visual regression test が 2 件失敗:
- `[chromium] e2e/visual/auth-screens.spec.ts:20:7 ログイン画面 初期表示` (13580 pixels diff, ratio 0.06)
- `[chromium-mobile]` 同上 (13580 pixels diff)

### 根本原因

`e2e/visual/auth-screens.spec.ts` が `toHaveScreenshot('login.png')` で過去の baseline 画像と比較している。UI 変更で実画面と baseline が乖離。

### 解決策

本プロジェクトには `.github/workflows/e2e-visual-baseline.yml` (baseline 自動再生成 workflow) が用意されている:

1. **発火条件**: push trigger + commit message に `[gen-visual]` タグを含む
2. **動作**: Linux CI 環境 (Ubuntu + Chromium) で baseline PNG を再生成し、同ブランチに「chore: regenerate visual baselines...」commit を自動 push
3. **誤発火防止**: tag が無い通常 commit では発火しない

**運用手順**:
```bash
git commit --allow-empty -m "chore: regenerate visual baselines for <reason> [gen-visual]"
git push
# → workflow が新 baseline を生成して同ブランチに自動 commit
# → 次回 E2E が新 baseline 比較で PASS
```

または UI 変更 commit のメッセージに `[gen-visual]` を含めても OK (本修正で採用)。

### 教訓

1. **UI 変更時は visual baseline 再生成を忘れない**: PR #420 のように UI を改修したら、CI の visual diff が出るのは当然。`[gen-visual]` 発火を含めると CI を待たずに baseline 更新できる
2. **Linux CI で生成した baseline を使う**: 開発者のローカル OS (Windows / Mac) で生成するとフォント / レンダリングの差で baseline が壊れる。**必ず CI 経由で再生成**
3. **baseline 更新 commit は別に分けないでよい**: 元 commit と baseline 更新 commit が同 PR に混在しても問題ない (= 仕様変更と baseline 更新が timeline 的に近いほうが追跡しやすい)
4. **ベースライン更新を main に直接送らない**: review 通過後の PR 内で更新 → PR merge で main 反映 (= 直接 main commit を避ける)

### 関連 KDD / PR

- PR #420 feat/wbs-import-uplift CI 失敗 → baseline 再生成
- `.github/workflows/e2e-visual-baseline.yml`
- 過去事例: ADR-0016 login UI でも同 workflow を使用 (commit `d96e256 [gen-visual]`)

## 5.X+98 **`e2e-visual-baseline.yml` workflow の baseline 自動 push が他者の同時 push で fast-forward 拒否される ─ artifact から PNG を取得して手動配置する fallback 経路を確保する (2026-05-25 / PR #420)**

### 発生事象

PR #420 で `[gen-visual]` タグ付き commit を push して baseline workflow を発火。workflow は:

1. ブランチを checkout (= push 時点の HEAD)
2. Linux CI で baseline PNG 再生成 (約 2 分 49 秒)
3. `git add e2e/visual/* && git commit && git push` を試行

しかし step 3 で「`! [rejected] feat/wbs-import-uplift -> feat/wbs-import-uplift (fetch first)`」エラー。

**原因**: workflow checkout から push 試行の間 (~3 分) に、別セッション (今回はユーザの別作業) が同ブランチへ直接 commit を push。workflow 側の local が古い HEAD のため fast-forward 失敗。

CI の E2E では baseline が更新されていないので visual diff 2 件失敗が継続。

### 解決策

**Fallback 経路**: workflow の "Upload generated PNGs as artifact" step は push 失敗後も実行され成功している (artifact name: `visual-baselines-<run-id>`)。これを手動取得して配置:

```bash
# 1. workflow の artifact をダウンロード
gh run download <run-id> -n visual-baselines-<run-id> -D /tmp/baseline-extract

# 2. プロジェクトの e2e/visual/ にコピー
cp -rf /tmp/baseline-extract/* e2e/visual/

# 3. 変更ファイルを確認 (実際に差分があった png のみ表示される)
git status --short

# 4. commit + push (今回は workflow を再発火させない)
git add e2e/visual/
git commit -m "chore: baseline png 手動配置 (artifact <run-id> 由来)"
git push
```

### 教訓

1. **workflow auto-push は他者の push で fail することがある**: 単独 PR 作業中でも、別セッション・別人・別 bot が同ブランチに push すれば衝突する
2. **artifact upload を fail-safe にする**: workflow は push fail でも artifact upload は続行する設計 (`if: always()` 相当) にしておくと、後から手動回収できる
3. **`[gen-visual]` 再実行で済むケースもある**: workflow 自体は冪等 (同じ内容を再生成するだけ)。再 push しても baseline は同じ結果になる。ただし 3 分掛かるので artifact から取った方が速い
4. **commit memo "コミット" のような曖昧 message は混乱の元**: 何を commit したか後で追跡できなくなる。意図的でなければ commit を整理 (squash / amend) すべき
5. **PR 進行中ブランチへの直接 push を控える**: 特に CI が走っている最中の直接 push は workflow との競合リスクが高い。コードレビュー前の WIP は別ブランチに分離するのが安全

### 関連 KDD / PR

- PR #420 feat/wbs-import-uplift (本事例): run 26202164194 で baseline 生成成功 + push 拒否 → artifact 経由で手動配置
- KDD §5.X+97 (前段): `[gen-visual]` workflow の基本動作
- `.github/workflows/e2e-visual-baseline.yml`

## 5.X+99 **Netlify Deploy Preview で Stripe Checkout 完了後の戻り先が本番 URL に飛ぶ ─ `NEXTAUTH_URL` を build wrapper で deploy context に同期 + `sanitizeReturnTo` で env URL も許可オリジンに追加 (2026-05-21 / PR #425 Stripe staging UAT)**

### 発生事象

Stripe Checkout のカード登録フローを Deploy Preview (`deploy-preview-NNN--tasukiba.netlify.app`) で実行すると、Stripe 側のカード登録自体は成功するが、完了後のブラウザリダイレクト先が **本番 URL** (`tasukiba.netlify.app/login`) に飛んでしまう。本番にはログインしていないため `/login` 画面に強制遷移し、staging 環境での UAT が完結できない。

同じ問題はログイン関連でも発生: Deploy Preview URL を叩いたユーザがログイン直後に本番 URL にリダイレクトされる。

### 根本原因 (3 段階)

**段階 A: NextAuth が本番 URL を canonical として使用**

NextAuth は `trustHost: true` 設定でも `NEXTAUTH_URL` env var が定義されていればそちらを優先する。Netlify Dashboard で `NEXTAUTH_URL` を全 context (Production / Deploy Preview / Branch Deploy) に共通の本番 URL 値で設定していたため、Deploy Preview 環境でも canonical URL が本番扱いになり、ログイン経路で本番 URL にリダイレクトされていた。

**段階 B: sanitizeReturnTo の origin チェックが本番 URL に固定**

Stripe Checkout の戻り先ハンドラ (`/api/tenants/me/billing/stripe/setup/complete/route.ts`) の `sanitizeReturnTo()` で、`req.url` の origin と returnTo の origin を比較してオープンリダイレクト対策していた。Netlify Functions では `req.url` の origin が canonical URL (= 本番) に固定されるケースがあり、Deploy Preview URL から来た returnTo が「異なる origin」として弾かれて本番 URL にフォールバックする (= 本番 `/settings/tenant` → 未ログインなので `/login` へ)。

**段階 C: Stripe `success_url` は client → server → Stripe の経路で origin が伝播し、UI の `window.location.origin` が起点になる**

段階 A / B を修正しても、staging DB の `paymentMethod` / `stripeSubscriptionId` が更新されず、ブラウザは本番 URL に着地する事象が継続。詳細追跡で判明したのは:

```
[UI] stripe-payment-method-section.tsx L92
  const returnUrl = `${window.location.origin}/settings/tenant`;
       ↓ fetch POST /api/tenants/me/billing/stripe/setup { returnUrl }
[Server] route.ts → createCheckoutSessionForCardSetup(tenantId, returnUrl)
[Server] stripe-billing.service.ts L144
  const baseOrigin = new URL(returnUrl).origin;
  const successUrl = `${baseOrigin}/api/tenants/me/billing/stripe/setup/complete?...&return_to=${returnUrl}`;
       ↓ Stripe Checkout Session 作成
[Stripe] カード登録成功後、success_url にブラウザを redirect
```

= UI が居る origin (= `window.location.origin`) が **唯一の真値** として全経路に伝播する。途中の env var (`URL` / `NEXTAUTH_URL`) は一切関与しない。

**従って origin が本番になるのは UI 側のいずれか**:
- (C-1) ユーザが本番 URL でログイン → 本番 `/settings/tenant` で「切替」を押した (= 単純に Deploy Preview URL でアクセスしていない)
- (C-2) NextAuth middleware / redirect が Deploy Preview URL → 本番 URL に書き換えている (= 段階 A 不完全)
- (C-3) ログイン後の callbackUrl 解決で本番 URL を返している (NextAuth の `authorize` / `signIn` callback)

段階 A の build wrapper は build 時の `URL` env var 値を `NEXTAUTH_URL` に注入するが、**Next.js は env var を build 時に bundle に baking するわけではない** ため runtime 値は正しいはず。一方 NextAuth 自体は session token 内に hostname を含めず、`headers().host` を信頼する `trustHost: true` 設計のため、再ログインせず古い session を使うと本番 hostname を持ったまま動作する可能性がある (要検証)。

### 解決策

**段階 A 対策: build wrapper で NEXTAUTH_URL を deploy context に同期**

> ⚠️ **2026-05-22 追記 (KDD §5.X+101 参照)**: 本対策は **実質効果なし**だったことが判明。
> Next.js は `NEXT_PUBLIC_*` 以外の server-side env var を build 時に bundle へ焼き込まないため、
> build script で `export NEXTAUTH_URL=...` しても **Netlify Function runtime には届かない**。
> 真の根本解決は **Netlify Dashboard で NEXTAUTH_URL を context override** (Production のみ固定、
> Deploy preview / Branch deploys では未設定にして `trustHost: true` でフォールバック)。
> 詳細は KDD §5.X+101 を参照。

`scripts/netlify-build.sh` を作成し、Netlify が build 時に自動設定する `URL` env var を `NEXTAUTH_URL` に注入してから build を実行。

```bash
#!/usr/bin/env bash
export NEXTAUTH_URL="${URL:-${NEXTAUTH_URL:-https://tasukiba.netlify.app}}"
exec pnpm build:netlify
```

`netlify.toml` の build command を `bash scripts/netlify-build.sh` に変更。

`URL` env var は Netlify が deploy context に応じて以下を自動設定:
- Production: `https://tasukiba.netlify.app`
- Deploy Preview: `https://deploy-preview-NNN--tasukiba.netlify.app`
- Branch Deploy: `https://<branch>--tasukiba.netlify.app`

**段階 B 対策: sanitizeReturnTo に env URL を許可オリジンとして追加**

```ts
function sanitizeReturnTo(returnTo: string | null, reqUrl: string): string {
  const reqOrigin = new URL(reqUrl).origin;
  // Netlify URL env var (deploy context に応じて自動切替) も許可
  const envOrigin = process.env.URL ? new URL(process.env.URL).origin : null;
  const allowedOrigins = new Set<string>([reqOrigin]);
  if (envOrigin) allowedOrigins.add(envOrigin);
  // フォールバック先も envOrigin を優先 (= req.url が本番固定でも正しい URL を返す)
  const primaryOrigin = envOrigin ?? reqOrigin;

  if (returnTo == null || returnTo.length === 0) return `${primaryOrigin}/settings/tenant`;
  try {
    const parsed = new URL(returnTo);
    if (!allowedOrigins.has(parsed.origin)) return `${primaryOrigin}/settings/tenant`;
    return parsed.toString();
  } catch {
    return `${primaryOrigin}/settings/tenant`;
  }
}
```

オープンリダイレクト対策 (= 任意の URL への redirect を禁止) は維持しつつ、Deploy Preview / Branch Deploy の正規 URL も許可される。

**段階 C 対策 (検証中 / 2026-05-21 時点)**

`window.location.origin` の値を切り分けるため UI / Server 双方にデバッグログを追加 (PR #425 検証用、確定後削除):

```ts
// UI: stripe-payment-method-section.tsx handleSetup 内
console.log('[stripe-ui] returnUrl=', returnUrl, 'origin=', window.location.origin);

// Server: route.ts POST /setup 入口 / GET /setup/complete 入口
console.log('[stripe-setup-complete] debug', {
  reqUrl: req.url, returnTo, safeReturnTo,
  env_NEXTAUTH_URL: process.env.NEXTAUTH_URL,
  env_URL: process.env.URL,
  env_DEPLOY_PRIME_URL: process.env.DEPLOY_PRIME_URL,
  env_CONTEXT: process.env.CONTEXT,
});
```

ログから origin が本番に書き換わる地点 (C-1 / C-2 / C-3) を特定 → 対応する fix を入れる。
ログだけで判明しない場合は、ログイン直後の `callbackUrl` 解決と middleware の host 判定を追加調査する。

### 教訓

1. **NextAuth の trustHost は十分条件ではない**: `NEXTAUTH_URL` が定義されていれば優先される。Multi-environment 運用では env var そのものを deploy context ごとに切替える必要がある
2. **Netlify env vars の context override は値の固定値しか持てない**: PR ごとに変わる URL を Dashboard で context override するのは運用負荷が高い。build wrapper で `URL` env var を `NEXTAUTH_URL` に注入する方が clean
3. **`URL` / `DEPLOY_PRIME_URL` / `DEPLOY_URL` を活用する**: Netlify は build 時にこれらの env vars を自動設定。`URL` は deploy context に応じて値が変化するので最も使い勝手が良い
4. **オープンリダイレクト対策の origin チェックは「許可リスト」設計に**: 単一 origin 比較だと multi-environment で誤って弾く。Set ベースの allowed origins で柔軟に対応
5. **`req.url` の origin は Netlify Functions で canonical に固定されることがある**: Next.js + Netlify Functions の組み合わせで、host header が本番 URL に書き換えられるケースあり。フォールバック先には `process.env.URL` を優先する
6. **Stripe UAT は Deploy Preview で実施するのが正解**: 本番 Stripe Test mode 環境を借りる必要がなく、本番 DB も汚染しない。ただし上記 NextAuth + sanitizeReturnTo の罠を踏むので事前対策必須
7. **Stripe `success_url` の origin は client → server → Stripe の経路で決まる (段階 C)**: server 側で env URL を fallback に使っても上書きされない。**真値は UI 起点の `window.location.origin` ただ一つ**。途中で本番 URL になっているなら UI が居る origin を疑う (= NextAuth redirect / middleware / 単純なアクセスミス)
8. **Deploy Preview で外部サービス連携をテストする時はブラウザの URL を必ず確認**: 「Deploy Preview にアクセスしたつもり」が「本番にリダイレクトされて気づかず操作」になっていないか、外部サービスへ遷移する直前にアドレスバーをスクリーンショットすると原因切り分けが早い

### 検証手順

```
1. Netlify Deploy Preview にアクセス: https://deploy-preview-NNN--tasukiba.netlify.app/login
   → アドレスバーが本番 URL に置換されないこと (= 段階 A 対策確認)

2. ログイン → アドレスバーが依然 Deploy Preview URL であることを確認 (= 段階 A 完全性確認)
   → 本番にリダイレクトされていたらここで段階 A 不完全

3. /settings/tenant の「クレジットカード払いに切替」ボタンを押す直前にアドレスバーを再確認
   → ここで Deploy Preview URL でないと段階 C が発火する

4. ボタンクリック → Stripe Checkout 画面に遷移

5. テストカード 4242 4242 4242 4242 を入力 → 保存

6. Stripe Checkout 完了後の戻り先
   → アドレスバーが Deploy Preview URL のまま (= 段階 B + 段階 C 対策確認)
   → /settings/tenant?stripe_setup=success が表示される

7. DB 状態を確認:
   npx tsx scripts/check-tenant-stripe-state.ts
   期待: paymentMethod='credit_card' / stripeSubscriptionId='sub_*' / cardVerificationStatus='valid'
```

### 関連 KDD / PR

- PR #425 fix/seed-vercel-to-netlify (本事例): Stripe staging UAT 中に検出 + 修正
- 関連修正ファイル:
  - `scripts/netlify-build.sh` (新規、build wrapper)
  - `netlify.toml` (build command 変更)
  - `src/app/api/tenants/me/billing/stripe/setup/complete/route.ts` (sanitizeReturnTo 修正)
- 関連 KDD §5.X+72 (前提): セッション解除パターン (NextAuth + Netlify の cookie 罠)

---

## 5.X+100 **★severity-1★ Stripe 払い設定切替 UI で client state 同期漏れ + 旧 server ガード残置が「credit_card 払いなのにカード未登録」放置 = 請求漏れリスク直結 (2026-05-22 / PR #425 Stripe UI 改修)**

### 発生事象

PR #425 で `paymentMethod` セレクト (請求書 ↔ クレジットカード) + 独立した「クレジットカード情報更新」ボタンの 2 ステップ式に UI を変更したところ、TC-1 (Beginner→Pro アップグレード) で以下の致命的な問題が連続発生:

1. **問題 1**: 「支払い方法」を invoice → credit_card に変更して「請求先情報を更新」を押したが、「クレジットカード情報更新」ボタンが **非活性のまま** で次に進めない (画面リロードすると活性化される)
2. **問題 2**: リロード後にボタンを押すと **409 `ALREADY_CREDIT_CARD`** で reject され、Stripe Checkout に遷移できない

両者放置すると **テナントの DB 上 `paymentMethod='credit_card'` だが Stripe Subscription が作成されない** 状態が継続 → 月次の自動引落が発生せず、運営側も「カード払いに切替済」と認識して請求書を送らない → **無料運用化 (請求漏れ)**。これは事業継続性に直結する severity-1 のリグレッション。

### 根本原因

**原因 1: Client Component の useState 値が `router.refresh()` だけでは更新されない**

`BillingContactSection.handleSubmit` 内で `router.refresh()` のみを呼んでいたが、これは Server Component の再レンダリングをトリガーするのみで、親 `TenantSettingsClient` が持つ `info` state (= `useState<TenantSelfInfo>`) は変わらない。
結果として `StripePaymentMethodSection` props.info.paymentMethod は旧値 (`'invoice'`) のままで活性条件を満たさず、ボタンが非活性。

**原因 2: 旧仕様の defense-in-depth ガードが新フローで誤発火**

POST `/api/tenants/me/billing/stripe/setup` には旧仕様時 (= 「切替ボタン押下 = 1 ステップで paymentMethod 変更 + Stripe Checkout 起動」) の二重 setup 防止ガードが残っていた:

```ts
if (tenant?.paymentMethod === 'credit_card') {
  return ... 409 ALREADY_CREDIT_CARD;
}
```

新仕様は **paymentMethod 変更と setup が別 step** なので、setup を呼ぶ時点で paymentMethod は既に credit_card になっている。このガードが新仕様の正常フローを誤って弾く。

### 解決策

**修正 1: 親の info state を再取得する callback を BillingContactSection に渡す**

```tsx
// tenant-settings-client.tsx
<BillingContactSection initialInfo={info} onUpdate={refreshInfo} />

function BillingContactSection({ initialInfo, onUpdate }: {...}) {
  async function handleSubmit(...) {
    ...
    showSuccess('請求先情報を更新しました');
    await onUpdate();   // ★ ここで親の info state を再取得
    router.refresh();
  }
}
```

`refreshInfo` は GET `/api/tenants/me` を叩いて info / selectedPlan / budgetCap を全部最新化する既存 helper を再利用。これで paymentMethod 変更が即座に `StripePaymentMethodSection` に伝播し、ボタンが活性化される。

**修正 2: ガード基準を `paymentMethod` → `stripeSubscriptionId` に変更**

```ts
// route.ts
const tenant = await prisma.tenant.findUnique({
  where: { id: user.tenantId },
  select: { stripeSubscriptionId: true },
});
if (tenant?.stripeSubscriptionId != null) {
  return ... 409 ALREADY_HAS_SUBSCRIPTION;
}
```

「Subscription 作成済の場合は Customer Portal で更新すべき」という新仕様の二重 setup 防止に意味的に正しい基準。UI 側は `stripeSubscriptionId` の有無で setup/portal を分岐するため、UI 経由の正常フローではこのガードは発火せず、UI バイパス (curl 直叩き等) のみを弾く。

### 教訓

1. **★最重要★ Client Component の useState 値は `router.refresh()` で更新されない** — Server Component が返す新しい props は描画されるが、子 Client Component が `useState(initialInfo)` で抱えている state は初期化時の値のまま。**親が持つ Client state を更新したい場合は明示的な refetch callback (例: `onUpdate: () => Promise<void>`) を子に渡し、子から呼び出させる必要がある**
2. **2 ステップ式 UI に変更したら server 側の defense-in-depth ガードを 1 ステップ前提のまま放置すると正常フローを弾く** — 「変更前は X、変更後は Y」と判定軸自体が変わるので、ガード条件式も同期更新する。横展開チェックで「同じ判定軸を使う他の経路 (= POST /portal、PATCH /billing 等) も巻き込んでいないか」を必ず確認
3. **★severity-1★「カード払いだがカード未登録」状態を許容する設計 / バグは即時請求漏れリスク** — `feedback_billing_invariant` (請求 invariant: ApiCallLog SUM = 画面 = 請求書 = Stripe) の前提として「credit_card 払いなら必ず active Subscription が存在する」インバリアントを死守すべき。画面遷移失敗・API ガード誤発火等で「カード未登録 credit_card 払い」が DB に出現する経路は全て塞ぐ
4. **defense-in-depth ガードのコメントには「廃止条件」も明記する** — `ALREADY_CREDIT_CARD` ガードのコメントは「二重 setup 防止」とだけ書かれており、旧仕様前提だと分からなかった。「現行 UI フローでは X の判定で代替、UI バイパスのみ対象」のように **判定軸の変更時に同時改修すべき意図** を残す

### 検証手順 (再発防止用)

```
事前: scripts/reset-default-tenant-to-beginner.ts を実行 (= invoice / stripeSubscriptionId=null)

1. /settings/tenant を開く → 「請求先情報」セクションの「支払い方法」を「クレジットカード」に変更
2. 「請求先情報を更新」ボタンクリック
   → 直後に「支払い方法」セクションの表示が「💳 クレジットカード (カード未登録)」に変わる ★リロード不要★
   → 「クレジットカード情報更新」ボタンが活性化される ★リロード不要★
3. 「クレジットカード情報更新」ボタンクリック
   → 確認ダイアログ「OK」
   → Stripe Checkout (checkout.stripe.com/...) に遷移する ★409 が出ない★
4. テストカード 4242 4242 4242 4242 で完了
5. DB 状態確認: paymentMethod='credit_card' + stripeSubscriptionId='sub_*' + cardVerificationStatus='valid'
```

各ステップで「リロード不要で次に進める」「途中で 409 が出ない」を確認。1 つでも崩れたら本 KDD §5.X+100 の再発と判断。

### 関連 KDD / PR / feedback

- PR #425 fix/seed-vercel-to-netlify (本事例): TC-1 UAT 中に検出
- 関連修正ファイル:
  - `src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx` (onUpdate 追加)
  - `src/app/api/tenants/me/billing/stripe/setup/route.ts` (409 ガード判定軸変更)
  - `src/app/api/tenants/me/billing/stripe/setup/route.test.ts` (ガードのテスト変更)
- 関連 feedback:
  - `feedback_billing_invariant` (★最重要★ 請求 invariant)
  - `feedback_netlify_nextauth_set_cookie` (Client state 更新の罠、本件と類似構造)
- 関連 KDD §5.X+99 (前提): Stripe Deploy Preview redirect 問題

---

## 5.X+101 **★severity-1★ Netlify Deploy Preview の本番 URL リダイレクト問題 — KDD §5.X+99 段階 A 対策の認識誤りと真の根本解決 (NEXTAUTH_URL の context 分離 + trustHost フォールバック) (2026-05-22 / PR #425 Stripe UAT)**

### 発生事象

KDD §5.X+99 で「段階 A 対策: build wrapper で `NEXTAUTH_URL` を deploy context に同期」を実装したつもりだったが、**Deploy Preview URL (`deploy-preview-425--tasukiba.netlify.app/`) にアクセスすると本番 URL (`tasukiba.netlify.app/`) に即座にリダイレクトされる事象が続発**。`/` 以外の保護領域 (例: `/settings/tenant`) でも middleware 経由で `/login` に redirect する瞬間に本番 origin に書き換わる。

これにより:
- Deploy Preview での UAT が完結できない
- 本番ログインしていないユーザは本番 `/login` 画面に着地 → 検証中断
- Stripe Checkout 完了後の戻り先も本番 URL に固定 (= KDD §5.X+99 と同根)

### 根本原因 (KDD §5.X+99 段階 A 対策の認識誤り)

**Next.js は server-side env var を build 時に bundle へ焼き込まない** (`NEXT_PUBLIC_*` プレフィックス付きのものを除く)。`process.env.NEXTAUTH_URL` は **Netlify Function runtime で都度評価される**。

KDD §5.X+99 で導入した `scripts/netlify-build.sh` の以下:

```bash
export NEXTAUTH_URL="${URL:-${NEXTAUTH_URL:-https://tasukiba.netlify.app}}"
exec pnpm build:netlify
```

の `export NEXTAUTH_URL=...` は **build プロセス内の子プロセス (`pnpm build:netlify`) にのみ伝播する**。Next.js の `next build` がこの env var を読んで bundle に焼き込めば runtime に伝わるが、`process.env.NEXTAUTH_URL` のような **`NEXT_PUBLIC_` 以外の env var は焼き込まれない** ため、build wrapper の export は **runtime には一切届かない**。

結果として:
- Netlify Function runtime での `process.env.NEXTAUTH_URL` は **Netlify Dashboard で設定された値** (= 全 scope 共通の本番 URL) になる
- NextAuth v5 は `trustHost: true` でも **`NEXTAUTH_URL` が定義されていればそちらを優先する** 仕様
- → NextAuth の base URL が本番固定 → middleware の `Response.redirect(new URL(LOGIN_PATH, nextUrl))` 等で `nextUrl` を信頼しても、NextAuth 内部で発火する redirect は本番 URL になる

これが「Netlify build wrapper を入れても効かない」真因。

### 解決策 (根本解決)

**Netlify Dashboard で `NEXTAUTH_URL` の context override を行う**:

| Deploy context | NEXTAUTH_URL の値 |
|---|---|
| Production | `https://tasukiba.netlify.app` (既存固定値) |
| Deploy preview | **未設定 (= Delete)** |
| Branch deploys | **未設定 (= Delete)** |

これで:
- Production runtime: NEXTAUTH_URL=本番 URL → NextAuth が本番 URL を base に使用 (既存挙動)
- Deploy preview runtime: NEXTAUTH_URL=undefined → NextAuth が `trustHost: true` で host header (= Deploy Preview URL) を base に使用
- Branch deploy runtime: 同上

**操作手順 (Netlify Dashboard)**:
1. Site configuration → Environment variables
2. `NEXTAUTH_URL` を選択 → Edit
3. 「Different value for each deploy context」を選択
4. Production 欄: 本番 URL を維持
5. **Deploy previews 欄: 値を空にして保存 (= context override で undefined)**
6. **Branch deploys 欄: 値を空にして保存**
7. 保存 → 該当 PR の Deploy Preview を再 build (Trigger deploy)

### 並行修正: build wrapper の NEXTAUTH_URL 注入を削除

`scripts/netlify-build.sh` の `export NEXTAUTH_URL=...` 行は **実質効果なし** のため削除。残しておくと後続改修者が「build wrapper で対処済」と誤認するリスクが高い (= 本事例の再発を招く)。

ただし wrapper script 自体は `netlify.toml` の build command として参照されており、空コミットでも build トリガーする目的でも使われているため、ファイル自体は維持し **NEXTAUTH_URL 行のみ削除 + コメントで「build wrapper では env var は runtime に届かない、Dashboard の context override を使え」と警告**。

### 教訓

1. **★最重要★ Next.js は `NEXT_PUBLIC_*` 以外の server-side env var を build 時に bundle へ焼き込まない** — Runtime で都度 `process.env.X` が評価される。よって「build script で env var を export する」は **`NEXT_PUBLIC_*` 以外には効果がない**。Runtime に値を伝えたければホスティング層 (Netlify Dashboard / Vercel Env / docker env) の context-specific 設定を使うのが正解
2. **NextAuth v5 の `trustHost: true` は `NEXTAUTH_URL` 未定義時のフォールバック** — `NEXTAUTH_URL` が定義されていれば常に優先される。Multi-environment 運用では本番のみ `NEXTAUTH_URL` を固定し、preview/branch では未定義にして `trustHost` 経由で host header から動的取得させる
3. **build wrapper 内の `export X=...` の伝播範囲は build プロセス内に限定** — Netlify Function (= 別 Lambda 実行環境) には届かない。「build 時に何かを env に注入したい」は ほぼ常に間違い。本当に必要なのは bundle に焼き込む (= `NEXT_PUBLIC_*` 化) か、Dashboard 設定で context 分離するか
4. **「対策実装した」と「実際に効いている」を切り分けて検証する** — KDD §5.X+99 では build wrapper を「段階 A 対策」として記録したが、効果検証 (= Deploy Preview で actually 本番 URL に飛ばないか) を実機確認しないまま「対応済」扱いになっていた。**fix を入れたら必ず原問題が再現しないかを実機で再現テスト**。コードレビュー / ローカル test PASS は十分条件ではない
5. **「効かないコードを残置」は積み重なって混乱を生む** — 効かないと分かったら即削除 + KDD で「過去に試したが効かなかった」を明記。残しておくと後続改修者が「対策済」と誤認して同じ問題を再発させる

### 検証手順 (Netlify Dashboard 設定後の再現確認)

```
1. Netlify Dashboard で NEXTAUTH_URL の Deploy preview / Branch deploys を空に設定
2. PR #425 の最新 Deploy Preview を Trigger deploy (or Clear cache and deploy)
3. ビルド完了後、ブラウザで以下を順にアクセス:
   a. https://deploy-preview-NNN--tasukiba.netlify.app/  → /projects (or /login) に redirect
      → アドレスバーが deploy-preview-NNN--... のままであることを確認 ★
   b. https://deploy-preview-NNN--tasukiba.netlify.app/login → ログイン
      → ログイン後も deploy-preview-NNN--... のままであることを確認 ★
   c. /settings/tenant → 「クレジットカード情報更新」ボタン → Stripe Checkout
      → カード登録完了後、deploy-preview-NNN--... に戻ることを確認 ★
4. DB 状態: paymentMethod='credit_card' + stripeSubscriptionId='sub_*'
```

各ステップで ★ が崩れた場合、本 KDD §5.X+101 の再発と判断。Netlify Dashboard 設定を再確認。

### 関連 KDD / PR / feedback

- PR #425 (本事例): TC-1 UAT 中、KDD §5.X+99 段階 A 対策不発を再検出 + 真の根本解決を実装
- 関連修正ファイル:
  - `scripts/netlify-build.sh` (NEXTAUTH_URL inject 行削除 + 警告コメント追加)
  - `docs/knowledge/KDD_PATTERNS.md` §5.X+99 段階 A 部分 (不発の旨を明記)
- 関連 KDD §5.X+99 (前提だが対策不発): Stripe Deploy Preview redirect 問題
- 関連 feedback `feedback_netlify_nextauth_set_cookie` (NextAuth + Netlify の罠系)
- Netlify 公式: [Environment variables - Deploy contexts](https://docs.netlify.com/configure-builds/environment-variables/#deploy-contexts)
- NextAuth v5 公式: [Trust Host (`trustHost`)](https://authjs.dev/reference/core#trusthost)

---

## 5.X+102 **★UX severity-1★ 一覧画面の検索ボタン不発 + ソート client-side 化問題の横断調査 — `/projects` 即時修正 + 残 13 画面の段階改修ロードマップ (2026-05-22 / PR #425)**

### 発生事象

`/projects` 画面で検索ボタンを押しても **絞り込みが反映されない**。URL は `?keyword=xxx` に変わるが一覧は変化しない。テスト中のユーザが PR レビュー時に検出。

横断調査の結果、**たすきば全 16 一覧画面のうち 13 画面が同じ構造的問題** を抱えていることが判明:

| 画面 | 検索 UI | 検索動作 | ソート UI | ソート動作 |
|---|---|---|---|---|
| /projects | ✓ あり | ❌ 効かない (← 本 PR で修正) | ✓ あり | client-side memory sort のみ |
| /knowledge, /memos, /all-memos, /customers, /my-tasks, /admin/users 等 | なし | client-side filter | ✓ あり | client-side memory sort のみ |
| /risks, /issues, /retrospectives + project 配下版 | (table 内 filter) | client-side filter | ✓ あり | client-side memory sort のみ |
| /admin/super/tenants | なし | 機能無し | なし | 機能無し |
| /projects/[id]/stakeholders 等 | なし | client-side filter | なし | 機能無し |

### 根本原因 (構造的)

3 つのパターンが共通して発生:

**パターン A: `page.tsx` が `searchParams` を受け取らない**
```tsx
// page.tsx (BAD)
export default async function ProjectsPage() {
  const result = await listProjects({ page: 1, limit: 20 }, ...); // ← 固定 params
  ...
}
```
↓
URL params 更新 → page 再実行されるが、固定 params で listProjects を呼ぶため where 条件が変わらず同じ結果。

**パターン B: Client Component が `initialProjects` を `useState` で保持していない**
→ props 変更時の挙動として OK (= props 直接使用ならリレンダで反映) だが、`useState(initialData)` で初期化していると **props 更新が state に反映されない** (= useState の initialValue は初回のみ評価)。

**パターン C: client-side `multiSort` / `useState` filter で済ませている**
→ 件数が少ない MVP 初期は問題なし。だが Beginner プラン上限の 100 件を超え、Expert/Pro でデータが増えると **クライアント側でメモリ持ち + ソート/フィルタ計算で UI が遅延** する。また「サーバ side pagination」と整合しない (= 1 ページだけ取って client で sort → 「2 ページ目に欲しいレコードがあった」事故)。

### 解決策

**今 PR (#425) で修正 (= severity-1 UX バグ部分のみ)**:

1. `/projects` の page.tsx に `searchParams` 受け取りを追加
2. `listProjects` に keyword / status / customerName / customerId を伝播
3. projects-client.tsx の `useState(initialKeyword)` で URL からの初期値復元 (リロード時 input 復元)
4. handleSearch の `router.refresh()` を撤去 (= `router.push` だけで page 再実行)

これで:
- 検索ボタン押下 → URL params 更新 → page.tsx 再実行 → 新 initialProjects → 表示更新 ✓
- リロード/共有 URL → input に検索条件が復元 ✓

**今 PR では対応しない (= 別 PR で段階改修)**:

ソートの server-side 化 + 他 13 画面の server-side filter 化は **3 段階 20-26h 規模** で大きく、Stripe UAT 中の PR #425 にバンドルすると検証範囲が爆発する。別 PR で対応する:

| 段階 | 対象 | 推定工数 | 優先度 |
|---|---|---|---|
| Phase 1 | `/projects` ソートの server-side 化 (orderBy URL param + service / API 対応) | 4-6h | 中 |
| Phase 2 | `/risks` `/issues` `/retrospectives` の server-side filter 化 (共通 table コンポーネント) | 6-8h | 中 |
| Phase 3 | `/memos` `/all-memos` `/knowledge` 等 7+ 画面の統一改修 + `useListSearchParams()` 共通 hook 化 | 10-12h | 低 |

### 教訓 (再発防止)

1. **★最重要★ Next.js App Router で URL params フィルタを実装する標準パターン**:
   ```tsx
   // page.tsx (Server Component)
   export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
     const sp = await searchParams;  // Next 15+ は Promise
     const result = await listX({ keyword: sp.keyword, ... });
     return <Client initial={result} initialKeyword={sp.keyword ?? ''} />;
   }
   ```
   ↓
   ```tsx
   // *-client.tsx (Client Component)
   async function handleSearch() {
     const params = new URLSearchParams();
     if (keyword) params.set('keyword', keyword);
     router.push(`?${params.toString()}`); // ← refresh() は不要、push が page を再実行
   }
   ```
   **`router.refresh()` だけでは page.tsx の searchParams は変わらない**。`router.push()` が必須。

2. **`useState(initialProps)` の罠**: Client Component で `useState(initialKeyword)` のように props を初期値にすると、props 更新時に state が変わらない。これは React 仕様。回避策は ① props を直接使う ② useEffect で props 変更時に setState する ③ key prop でコンポーネントを再マウントする
3. **client-side ソート/フィルタは「件数上限が確実に小さい」ケースのみ許容**: テナント越境はしないが、Expert/Pro プランでデータが 1000 件超に達すると UI 遅延 + メモリ消費が顕在化する。最低でも「Beginner 100 件上限を超える可能性のあるエンティティ」は server-side 化する
4. **検索 UI / ソート UI / 実装の不一致をスクリーンキャプチャ E2E で検出** — 「UI ボタンは存在するが効かない」はユーザ視点での最悪 UX。「クリック → 一覧変化を assertion」する E2E spec を追加すれば即検出可能。本件は手動 UAT で初めて検出された
5. **横断調査は Agent 並行実行 + 表形式報告で時間短縮**: 16 画面の検索/ソート状態を 1 つの Agent タスクで一覧化させ、改修対象/規模を即座に判定。共通根本原因が浮かび上がる利点もある (= 個別調査では「単発の不具合」に見えていたものが構造的問題と判明)

### 検証手順 (再発防止用)

```
1. /projects ページを開く
2. 検索 input に「Stripe」等の文字を入力 → 検索ボタンクリック
   → URL が ?keyword=Stripe になる ★
   → 一覧が「Stripe」を含むプロジェクトに絞り込まれる ★ (本 KDD §5.X+102 の主修正)
3. ブラウザ F5 でリロード
   → URL の keyword 維持 ★
   → input に「Stripe」が復元される ★
   → 一覧は絞り込み状態維持 ★
4. URL を別タブで共有してアクセス
   → 同じ絞り込み結果が表示される ★
```

各 ★ が崩れた場合、本 KDD §5.X+102 の再発と判断。

### 関連 KDD / PR / feedback

- PR #425 (本事例): `/projects` 即時修正
- 後続 PR 予定 (Phase 1-3): `/projects` ソート + `/risks` `/issues` `/retrospectives` + `/memos` `/knowledge` 等
- 関連修正ファイル (本 PR):
  - `src/app/(dashboard)/projects/page.tsx` (searchParams 受け取り)
  - `src/app/(dashboard)/projects/projects-client.tsx` (handleSearch から refresh() 撤去 + initialKeyword 受け取り)
- 関連 feedback:
  - `feedback_tenant_isolation` (★最重要★ テナント越境防止、本件と同じく一覧 service の必須前提)
  - `feedback_billing_data_realtime` (DB 容量・API 利用量等は cron キャッシュ依存を避ける、本件と同じく一覧の整合性方針)

---

## 5.X+103 **★severity-1 請求堅牢性★ Stripe Checkout コールバックを sameSite='strict' cookie が壊す + paymentMethod 切替の 1 ステップ強制遷移化 (2026-05-22 / PR #425)**

### 発生事象

PR #198 で session cookie の `sameSite` を `'lax'` → `'strict'` に強化していたが、Stripe Checkout を導入した PR #425 検証で以下の致命的問題が判明:

1. `/settings/tenant` → 「クレジットカード情報更新」→ Stripe Checkout でカード入力 → 「保存」
2. Stripe が `success_url` (= `/api/tenants/me/billing/stripe/setup/complete?...`) にブラウザリダイレクト
3. **sameSite='strict' により session cookie が外部 origin (checkout.stripe.com) からの戻りで送信されない**
4. `/api/.../complete` handler が未認証扱いになり `/login` に強制 redirect
5. ユーザは「カード登録成功 → ログイン画面」という不可解な遷移を体験
6. DB は `paymentMethod='credit_card' + stripeSubscriptionId=null` の **「カード未登録 credit_card」状態** に陥り、月次自動引落が走らず請求漏れ

さらにユーザ調査で:
7. `paymentMethod` 切替が「フォーム更新 → 別途カード登録ボタン」の **2 ステップ** で、ユーザが (4) のような途中失敗時に **DB に credit_card だけ書き込まれて放置** されるリスクが構造的に存在することも判明。事業継続性に関わる severity-1 問題。

### 根本原因

**原因 1: PR #198 当時の前提 (= 外部 origin からのコールバック無し) が崩れた**

PR #198 のコメント:
> 'lax' → 'strict' に強化 (CWE-1275 対策)。
> 本サービスは Credentials provider のみで OAuth/SSO のクロスサイトコールバックが無く...

Stripe Checkout の導入で「外部 origin からの top-level GET redirect」が定常的に発生するようになったが、その時 cookie 設定の見直しが漏れていた。

**原因 2: paymentMethod 変更と Stripe Checkout が独立した 2 ステップ**

旧設計:
```
Step A: フォームで paymentMethod=credit_card 選択 → 「請求先情報を更新」 → DB に書き込み
Step B: 「クレジットカード情報更新」ボタン → Stripe Checkout
```

ユーザが Step A だけ完了して Step B をスキップ (= タブを閉じる、Stripe で失敗、コールバック失敗) すると、DB は `paymentMethod='credit_card' + stripeSubscriptionId=null` の不整合状態に。

### 解決策

**解決 1: `sameSite='lax'` に戻す**

```ts
// auth.config.ts
sessionToken: {
  options: {
    sameSite: 'lax', // PR #425 で 'strict' → 'lax' に再緩和
    ...
  },
},
```

`'lax'` は top-level GET (= リンククリック / form 遷移以外) で cookie 送信を許可するため、Stripe Checkout からの戻りで session が維持される。GET 経由の CSRF は副作用が無いため脅威にならない。POST に対する CSRF 対策は CSRF token + CORS で別途防御。

**解決 2: paymentMethod 切替を 1 ステップ強制遷移化**

```tsx
// BillingContactSection.handleSubmit
const isInvoiceToCreditCardTransition =
  previousPaymentMethod !== 'credit_card' && form.paymentMethod === 'credit_card';

if (isInvoiceToCreditCardTransition) {
  // 1) paymentMethod を除外して住所等だけ DB 更新
  delete (bodyForPatch as Partial<typeof bodyForPatch>).paymentMethod;
  await fetch('/api/tenants/me/billing', { ..., body: JSON.stringify(bodyForPatch) });

  // 2) Stripe Checkout setup URL を取得して強制遷移
  const setupRes = await fetch('/api/tenants/me/billing/stripe/setup', { ... });
  window.location.href = setupRes.data.checkoutUrl;
  // → カード登録成功時のみ /api/.../complete が paymentMethod='credit_card' を書き込む
  // → 失敗/キャンセル時は paymentMethod は invoice のまま (= 状態が壊れない)
}
```

これと併せて server-side ガード:
```ts
// tenant-self.service.ts updateBillingContact
if (
  input.paymentMethod === 'credit_card' &&
  current?.paymentMethod !== 'credit_card' &&
  current?.stripeSubscriptionId == null
) {
  throw new CreditCardNotRegisteredError(); // 422 で API reject
}
```

UI バイパス (= curl 直叩き) でも DB に `credit_card + sub_id=null` が書けないことを保証。

**解決 3: UI 表示で「請求準備状態」を明示化**

```ts
// stripe-payment-method-section.tsx
const currentLabel =
  state === 'invoice_only'           ? '🏦 銀行振込'
  : state === 'credit_card_active'   ? '✅ クレジットカード払い (有効・自動引落)'
  : state === 'credit_card_unregistered' ? '⚠ クレジットカード払い (カード未登録 = 自動請求不可)'
  : '❌ クレジットカード払い (要対応 = 引落停止リスクあり)';
```

「有効」「未登録」「要対応」の状態バッジで、ユーザが画面遷移直後に請求準備状態を即判断できる。

### 教訓

1. **★最重要★ 外部 origin からのコールバックを伴う機能を追加したら cookie sameSite を必ず見直す** — 旧設計の前提条件 (=「外部コールバック無し」) が後から崩れることは頻繁。Stripe, OAuth, OIDC, パスキー等を導入する際は強い候補
2. **「DB に書き込んで途中で離脱できる」設計は請求 invariant を壊す** — paymentMethod のようなクリティカルな状態変更は「成功した時のみ DB に書き込む」設計に統一。途中放置で「半分だけ変更された」状態が DB に残ると後続全部が破綻する
3. **server-side ガードは UI バイパス前提で書く** — UI で導線を整えても、curl/Postman での直叩きで同じ不整合は作れる。重要な不変条件 (= invariant) は service 層で例外を throw して reject
4. **状態を「✓ / ⚠ / ❌」記号で表示する** — ユーザに「異常/正常」を一目で伝える最速の手段。文字だけの「(自動引落)」より「✅ 有効・自動引落」のほうが視認性 3 倍以上

### 検証手順 (再発防止用)

```
事前: scripts/reset-default-tenant-to-beginner.ts を実行 (paymentMethod='invoice', sub_id=null)

シナリオ A: 1 ステップ強制遷移成功パス
1. /settings/tenant の「請求先情報」セクションで「支払い方法」を「クレジットカード」に変更
2. 「請求先情報を更新」ボタン押下
   → 「請求先情報を保存しました。続けてカード登録画面に移動します」トースト ★
   → 自動で Stripe Checkout (checkout.stripe.com) に遷移 ★
3. 4242 4242 4242 4242 で「保存」
4. Stripe からの戻り URL: /settings/tenant?stripe_setup=success ★
   (= /login に飛ばない、deploy-preview-... のまま、本番 URL に書き換わらない)
5. 「支払い方法」セクションが「✅ クレジットカード払い (有効・自動引落)」表示 ★
6. DB 確認: paymentMethod='credit_card' + stripeSubscriptionId='sub_*' + cardVerificationStatus='valid' ★

シナリオ B: server-side ガード (UI バイパス)
1. curl で直接 PATCH /api/tenants/me/billing with body {"paymentMethod":"credit_card"}
   → 422 CREDIT_CARD_NOT_REGISTERED ★
   → DB の paymentMethod は invoice のまま ★

シナリオ C: Stripe Checkout キャンセル時の安全性
1. シナリオ A の手順 3 で Stripe Checkout の「← 戻る」を押下
2. /settings/tenant?stripe_setup=canceled に戻る
3. DB 確認: paymentMethod='invoice' のまま ★ (= 状態が壊れない)
```

各 ★ が崩れた場合、本 KDD §5.X+103 の再発と判断。

### 関連 KDD / PR / feedback

- PR #425 (本事例): TC-1 UAT 中に検出 + 即時修正
- 関連修正ファイル:
  - `src/lib/auth.config.ts` (sameSite='lax' に戻す)
  - `src/services/tenant-self.service.ts` (CreditCardNotRegisteredError + ガード追加)
  - `src/app/api/tenants/me/billing/route.ts` (422 エラーマッピング)
  - `src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx` (BillingContactSection 強制遷移)
  - `src/app/(dashboard)/settings/tenant/stripe-payment-method-section.tsx` (表示文言改善)
- 関連 feedback:
  - `feedback_billing_invariant` (★最重要★ 請求 invariant の根本原則)
  - `feedback_session_clearance_pattern` (cookie 周りの罠系)
- 関連 KDD §5.X+99 (前提): Stripe Deploy Preview redirect 問題
- 関連 KDD §5.X+101 (前提): NEXTAUTH_URL context 分離

---

## 5.X+104 **Stripe 自動請求の堅牢性 多層防御 — 現状の実装状況と段階改修ロードマップ (2026-05-22 / PR #425 横断調査)**

### 背景

ユーザフィードバック「カード情報登録/更新が制御されていないと請求業務が漏れ、事業継続性が損なわれる」を受けて、Stripe 自動請求の多層防御を横断調査した結果。

### 現状の防御層 (実装済み)

| 層 | 既存実装 |
|---|---|
| **UI** | paymentMethod 切替制御 + Stripe Checkout 強制遷移 (本 PR で完成) |
| **Service** | `verifyTenantCard()` (期限切れチェック含む) / `completeStripeSetup()` (Subscription 作成 + 二重課金防止) / `cancelTenantStripeSubscription()` |
| **DB** | `Tenant.stripeCustomerId / stripeSubscriptionId / cardVerificationStatus / autoSuspendScheduledAt` 等 20+ カラム |
| **Webhook** | **11 イベント対応** (invoice.payment_failed, customer.subscription.updated, payment_method.detached 等) |
| **Cron** | `stripe-reconcile` (月次 Stripe DB 照合) / `stripe-auto-suspend` (日次自動 suspend) / `stripe-usage-flush` (Usage 送信) |
| **可視化** | super_admin の請求画面 (`/admin/super/billing/[yearMonth]`) で BillingHistory 表示 |
| **通知** | `autoSuspend` 時の auditLog 記録 |

### 残存リスクシナリオと推奨改修

| 優先度 | リスク | 現防御 | 不足/推奨 |
|---|---|---|---|
| **高** | カード期限切れの「静かな見過ごし」 | `verifyTenantCard()` 実装済だが呼出が「カード登録時のみ」 | **月次 cron `stripe-verify-all-cards` 追加** (3-5h) — 期限切れ 30 日前 admin/user 通知 |
| **高** | プラン変更時のカード再検証無し | プラン変更ハンドラに `verifyTenantCard()` 明示呼出なし | プラン変更時 hook 追加 (1-2h) — 失敗時はプラン変更 reject |
| **中** | DB 整合性 drift (`paymentMethod='credit_card' AND sub_id IS NULL` 等) | `stripe-reconcile` は Stripe API 経由の照合のみ | DB 内整合性チェック追加 (4-6h) — 異常 SQL 検出 + admin 通知 |
| **中** | ユーザ向けカード期限切れ警告 UI | StripePaymentMethodSection で表示済 (本 PR で改善) | より早期の banner 表示 (2-3h) — 設定画面以外のヘッダー領域 |
| **中** | super_admin 向け「カード状態異常テナント」一覧 | super_admin 画面に専用 filter 無し | filter + ハイライト追加 (3-4h) |
| **低** | `charge.dispute` / `charge.refunded` Webhook 未対応 | invoice.* のみ対応 | edge case のため当面対応不要 |

**未対応の合計**: 13-20h 規模 (= 別 PR で段階改修)

### 段階改修ロードマップ

**今 PR (#425) で完成**: UI 強制遷移 + server-side ガード + cookie sameSite 修正 + 表示明示化 (=「カード未登録 credit_card」状態の構造的予防)

**Sprint N+1 (= 次の請求改修 PR)**:
- 月次 `stripe-verify-all-cards` cron (= 期限切れ早期検知)
- プラン変更時のカード事前検証 (= プラン UP 時の不整合予防)

**Sprint N+2**:
- DB 整合性チェック cron + admin 通知
- ユーザ向け早期警告 banner

### 教訓

1. **多層防御は「既存層がカバーしていない隙間」を埋める** — 本サービスは既に Webhook + cron + service で 7 割の防御が完成しており、PR #425 の修正 + 残り 2-3 件の追加で完全な堅牢性に到達する
2. **「fix も大事だが、何が既に守られているか」の認識共有も重要** — 場当たり対応ではなく、横断調査で全体像を把握してから改修対象を絞ると最小コストで最大効果
3. **段階改修ロードマップを KDD に残す** — 次の Sprint で何を優先するかが翌日継続時にも明確になる

### 関連 KDD / PR / feedback

- PR #425 (本事例): 横断調査 + 即時改修
- 後続 PR 予定 (Sprint N+1): `stripe-verify-all-cards` cron + プラン変更時カード検証
- 後続 PR 予定 (Sprint N+2): DB 整合性 cron + UI 警告 banner + admin filter
- 関連 feedback `feedback_billing_invariant` (★最重要★ 請求 invariant)
- 関連 feedback `feedback_cron_watchdog_pattern` (cron 監視は「failure 検知」と「期待スケジュールに対し N 時間記録なし」の 2 段構え) — 新規 cron 追加時の前提

---

## 5.X+105 **★severity-1 請求堅牢性★ Stripe Subscription cancel 直後の「DB sub_id 残置」が「銀行振込戻し → カード払い再切替」の二重 Subscription エラーを引き起こす — Webhook 待ちを止めて呼出側で即時クリアする (2026-05-22 / PR #425 TC-7 検証中)**

### 発生事象

TC-7 (credit_card → invoice 戻し) を「DB 直書き or UI 操作」のいずれかで実施したテナントが、すぐに「invoice → credit_card 再切替」を試みると、Stripe Checkout でカード入力後の `completeStripeSetup` Step 4 (Subscription 作成) で **「Stripe 処理エラー (時間をおいて再試行)」** で失敗する。

UI 上は「カード登録に失敗しました」と表示されるが、Stripe Dashboard 側ではカードは正常に登録されている (= 半端な状態が残る)。

### 根本原因

`cancelTenantStripeSubscription` の旧実装が **DB の `stripeSubscriptionId` 等を即時クリアせず Webhook (customer.subscription.deleted) 経由で同期する設計** だったため、

| 環境 | 結果 |
|---|---|
| **staging** (Webhook 未設定) | 永久に `stripeSubscriptionId='sub_xxx'` が DB に残る → 再 setup 時に「既存 Subscription 残置」と認識されない / Stripe API レベルで二重作成エラー |
| **本番** (Webhook あり) | Webhook 同期の数秒〜数分のラグ中に銀行振込戻し → 即カード払い再切替の race condition で同じエラー |

`completeStripeSetup` Step 4 で `createSubscriptionForTenant` が呼ばれた時、テナントは Stripe 側に既に active な `sub_xxx` を持っているため、新規 Subscription 作成 API が duplicate / invalid_request 系のエラーを返す。エラーは `processing_error` にラップされてユーザには「時間をおいて再試行」と表示されるが、根本は二重 Subscription 作成試行。

### 解決策

`cancelTenantStripeSubscription` を「Stripe API 呼出 + 成功時に DB の Stripe 関連フィールド即時クリア」に拡張:

```ts
async function clearTenantStripeSubscriptionFields(tenantId: string): Promise<void> {
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: 'canceled',
      stripeSubscriptionItemHaikuId: null,
      stripeSubscriptionItemSonnetId: null,
      stripeSubscriptionItemStorageId: null,
      stripeDefaultPaymentMethodId: null,
      cardVerificationStatus: null,
      cardLastVerifiedAt: null,
      autoSuspendScheduledAt: null,
    },
  });
}
```

`cancel()` 成功時 + 「既に canceled だった」(invalid_request 系) ケース 双方でクリアを呼び出すことで、Webhook 同期の有無 / 遅延に関わらず **常にクリーンな初期状態** に戻る。

`stripeCustomerId` だけはクリアしない (= 再 setup 時に再利用するため保持。Customer 削除は別 API)。

### 教訓

1. **★最重要★ Webhook を「DB 同期の主経路」にする設計は脆い** — Webhook は障害発生 / 設定漏れ / 遅延が常にある。重要な状態遷移 (Subscription cancel / カード変更等) は **呼出元 (アプリ層)** で即時 DB を更新する設計にし、Webhook は冗長 (= 整合性二重チェック) として位置付ける
2. **「銀行振込戻し → 即カード払い」は normal use case** — ユーザは試行錯誤するため秒単位の再操作は当たり前。「Webhook が来るまで待ってください」は UX として成立しない
3. **DB drift は静かに進行する** — 「Stripe Dashboard は canceled だが DB は active」のような状態は単発では問題にならないが、再 setup 等の関連操作と組み合わさると爆発する。即時クリアで drift を起こさないことが最優先
4. **エラーメッセージ「processing_error」では原因が見えない** — 「二重 Subscription 作成試行」が裏で起きていることはユーザにもサポートにも見えない。Stripe API のエラーレスポンス全文を auditLog に残す改善も Sprint N+1 候補

### 検証手順 (再発防止用)

```
事前: TC-1 完了済 (paymentMethod='credit_card', sub_id='sub_xxx', default_pm='pm_*')

シナリオ A: UI 操作 (TC-7)
1. /settings/tenant の「請求先情報」セクションで支払い方法を「銀行振込」に変更
2. 「請求先情報を更新」ボタン押下
3. DB 確認:
   npx tsx scripts/check-tenant-stripe-state.ts
   期待 (★本 KDD 修正後): paymentMethod='invoice' + stripeSubscriptionId=null + stripeDefaultPaymentMethodId=null
                        + cardVerificationStatus=null
   (旧実装は staging で sub_id が残る → 本 KDD 再発)
4. Stripe Dashboard で sub_xxx が Canceled になっているか確認

シナリオ B: 銀行振込戻し → 即カード払い再切替 (race condition 検証)
1. シナリオ A 完了後、すぐに「請求先情報」で支払い方法を「クレジットカード」に戻す
2. 「請求先情報を更新」ボタン → 強制 Stripe Checkout 遷移
3. 別カード (例: 5555 5555 5555 4444) で「保存」
4. 期待: 戻り先 /settings/tenant?stripe_setup=success + 新カード表示 ★
   (旧実装はここで Stripe 処理エラー → 本 KDD 再発)
```

### 関連 KDD / PR / feedback

- PR #425 (本事例): TC-7 検証中に検出 + 即時修正
- 関連修正ファイル:
  - `src/services/stripe-billing.service.ts`
    - `cancelTenantStripeSubscription` (cancel 成功時 / 既 canceled 時に DB クリア呼出)
    - `clearTenantStripeSubscriptionFields` (新規 内部ヘルパ)
- 関連 KDD §5.X+103 (前提): 「カード未登録 credit_card」状態の構造的予防
- 関連 KDD §5.X+104 (前提): 請求堅牢性多層防御
- 関連 feedback:
  - `feedback_billing_invariant` (★最重要★ 請求 invariant)
  - `feedback_drift_detection_design` (drift 検知設計は両軸の max + 画面表示 + audit + 修復経路の 4 点セット) — 本件は「即時 DB 同期で drift を起こさない」という別アプローチ

---

## 5.X+106 **★severity-1 請求堅牢性★ Stripe `idempotencyKey` を固定 tenantId のみで構成すると「カード再登録」フローが永久に壊れる — paymentMethodId を含めて試行ごとに区別する (2026-05-22 / PR #425 TC-7 再検証中)**

### 発生事象

KDD §5.X+105 の修正 (cancel 時の DB 即時クリア) を適用後も、`/settings/tenant` で「銀行振込 → クレジットカード」切替フローを **2 回目以降** 実行すると、Stripe Checkout でカード入力後の `completeStripeSetup` Step 4 (Subscription 作成) が **`processing_error`** で失敗。Stripe API のエラーメッセージは:

> Keys for idempotent requests can only be reused with the same parameters they were first used with.

### 根本原因

`createSubscriptionForTenant` の `idempotencyKey` が **テナント ID のみ** で構成されていた:

```ts
stripe.subscriptions.create(params, {
  idempotencyKey: `subscription:create:${input.tenantId}`,
});
```

Stripe の冪等性 (idempotency) 仕様:
- 同じ `idempotencyKey` + **同じ parameters** → 1 回目の結果を返す (= 副作用は 1 回)
- 同じ `idempotencyKey` + **異なる parameters** → **エラーで reject** (= 違反扱い)

カード再登録フローでは:
- 1 回目 (TC-1): `idempotencyKey = subscription:create:00000000-...` で `default_payment_method=pm_VISA_xxx`
- 2 回目 (cancel 後の再切替): 同じ `idempotencyKey` だが `default_payment_method=pm_新カード_yyy`
- → Stripe API が「異なる parameters での再利用」と判定して reject
- → アプリ層で `processing_error` にラップされてユーザに「Stripe 処理エラー (時間をおいて再試行)」表示

つまり **1 つのテナントは生涯 1 回しか Subscription を作れない実装** になっていた。テナント解約 → 再契約 / カード払い ↔ 銀行振込の往復 / 試行錯誤 等の **正常なユースケース** すべてで Stripe 処理エラーが発生。

### 解決策

`idempotencyKey` に `paymentMethodId` を含めて「同一試行 (= 同じカード) なら冪等 / 異なる試行 (= 異なるカード) なら新規作成」に変更:

```ts
stripe.subscriptions.create(params, {
  idempotencyKey: `subscription:create:${input.tenantId}:${input.paymentMethodId}`,
});
```

これにより:
- ネットワーク失敗時のリトライ (= 同じ tenantId + 同じ paymentMethodId) → 1 回目の結果を返す (= 二重課金なし)
- カード再登録 (= 同じ tenantId + 異なる paymentMethodId) → 新規 Subscription を作成

### 教訓

1. **★最重要★ Stripe `idempotencyKey` は「リトライしたい単位」で組み立てる** — `tenantId` だけだと「テナントの生涯 1 回」の制約になる。正しくは「retry したい行為」を表す key (= テナント + 試行を区別する変数)。Subscription 作成なら `tenantId + paymentMethodId`、決済なら `tenantId + invoiceId + amount` 等
2. **冪等性の目的は「ネットワーク失敗時の二重実行を防ぐ」こと** — 「同じ tenantId は永久に同じ subscription」ではない。冪等性キーの設計時に「retry したい単位」を明確化する
3. **エラーメッセージ「processing_error (時間をおいて再試行)」では原因が永久に分からない** — Stripe API のエラーレスポンス全文を `auditLog` / `console.error` に残す改善 (KDD §5.X+104 Sprint N+1 候補) は本件で再認識。今 PR の debug log 削除前にここも検討
4. **TC-1 だけでは検出できない罠** — 1 回目の setup は idempotencyKey の保護が新規作成なので成功する。2 回目以降の操作 (= TC-7 cancel 後の再切替) で初めて顕在化する。**「同じユーザ操作を 2 回繰り返すテストパターン」を E2E に組込むべき** (= 「冪等性 / state machine の往復」を網羅するテスト設計)

### 検証手順 (再発防止用)

```
事前: reset-default-tenant-to-beginner.ts で完全初期化

シナリオ A: 1 回目の setup (TC-1 標準フロー、本 KDD 修正なしでも成功)
1. /settings/tenant で支払い方法を「クレジットカード」に変更 → 「請求先情報を更新」
2. Stripe Checkout で Visa 4242 → 「保存」
3. 戻り URL: /settings/tenant?stripe_setup=success ★
4. DB: paymentMethod='credit_card' + stripeSubscriptionId='sub_*' (= Visa)

シナリオ B: 2 回目の setup (★本 KDD 修正の真価検証★)
5. シナリオ A 完了後、支払い方法を「銀行振込」に変更 → 「請求先情報を更新」
   → KDD §5.X+105 修正で DB の sub_id / pm_id がクリアされる
6. すぐに支払い方法を「クレジットカード」に再変更 → 「請求先情報を更新」
7. Stripe Checkout で 別カード (例 Mastercard 5555 5555 5555 4444) → 「保存」
8. 戻り URL: /settings/tenant?stripe_setup=success ★ (本 KDD 修正なしだと processing_error)
9. DB: 新 sub_id + Mastercard pm_id

シナリオ B が成功すれば本 KDD §5.X+106 の修正が機能。
```

### 関連 KDD / PR / feedback

- PR #425 (本事例): TC-7 再検証中に検出 + 即時修正
- 関連修正ファイル:
  - `src/services/stripe-billing.service.ts` (`createSubscriptionForTenant` の idempotencyKey)
- 関連 KDD:
  - §5.X+105 (前提): cancel 時の DB 即時クリア (本 KDD が直接の後続事案)
  - §5.X+103, §5.X+104 (Stripe 堅牢性 系列)
- 関連 feedback:
  - `feedback_billing_invariant` (★最重要★)
- 関連 Stripe 公式: [Idempotent requests - Idempotency keys](https://docs.stripe.com/api/idempotent_requests)

---

## 5.X+107 **★severity-1 請求堅牢性★ Stripe Customer に「複数 active Subscription」が並存して二重課金リスク — setup 直前に全 active を強制 cancel して DB drift を自動修復する (2026-05-22 / PR #425 TC-1 反復検証中)**

### 発生事象

PR #425 TC-1 を複数回繰返し検証中、Stripe Customer Portal を開いたユーザが **「現在のサブスクリプション」が 2 つ並んで表示されている** ことを発見:

- Subscription 1: 「Haiku per-call + Sonnet per-call」 — default Visa •••• 4242
- Subscription 2: 「Haiku per-call + Sonnet per-call」 — default Mastercard •••• 4444

→ **同 Customer に active な Subscription が 2 つ並存 = 月次で両方から引落される二重課金状態**。たすきば DB の `stripeSubscriptionId` は 1 つだけ知っているため、もう一方の請求は「アプリ層が知らない請求」として運営側に届く (= ユーザ視点では「いくら払わされたかわからない」UX 災害、運営視点では「コスト超過のクレーム不可避」)。

### 根本原因

setup 経路に「**setup 前に同 Customer の active Subscription を cancel する**」ガードが無かったため、以下のシナリオで二重作成が起きる:

1. TC-1 (1 回目): Subscription A 作成 (Mastercard) — Stripe + DB 整合
2. **DB drift 発生** (= 以下のいずれか):
   - 開発者が `script` で `paymentMethod='invoice'` を直書き
   - TC-7 (UI cancel) を経由しても Webhook 遅延中に再 setup
   - 何らかの障害で `cancelTenantStripeSubscription` が呼ばれず DB だけ書き換わった
3. 再 TC-1 (UI): DB の `stripeSubscriptionId=null` を見て「新規作成」フローに入る
4. `createSubscriptionForTenant` は Stripe API を叩いて新 Subscription B 作成 (Visa) — 既存 A は無関係に並存
5. → Stripe Customer に Subscription A + B が並存
6. 月次 cron / Stripe 自動引落で **両方から請求**

### 解決策

`completeStripeSetup` の Step 3.5 として「同 Customer の active Subscription を全 cancel」を追加:

```ts
// Step 3.5 (新規追加): 既存 active Subscription を全 cancel (DB drift 修復 + 二重防止)
await cancelAllActiveStripeSubscriptionsForCustomer(sessionCustomerId);

// Step 4 (既存): 新規 Subscription 作成
const subscriptionResult = await createSubscriptionForTenant({...});
```

実装:
```ts
async function cancelAllActiveStripeSubscriptionsForCustomer(customerId: string): Promise<void> {
  const stripe = getStripe();
  const listResult = await withStripeError(() =>
    stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 100 }),
  );
  if (!listResult.ok) return;
  for (const sub of listResult.value.data) {
    await withStripeError(() =>
      stripe.subscriptions.cancel(sub.id, { invoice_now: true, prorate: false }),
    );
    // 失敗時は console.warn のみで続行 (= 既 canceled / Webhook 経由で最終整合)
  }
}
```

これにより:
- DB に sub_id が無くても、Stripe 側に active があれば必ず先に cancel される
- DB drift が自動修復される (= 過去の残骸を毎回クリーンアップ)
- 二重 Subscription が並存する状態が **構造的に発生不可** になる

### 教訓

1. **★最重要★ 「アプリ層のクリーンアップ」と「Stripe 側の状態」は別物。両方を毎回見る** — DB に「subscription_id 持っていません」と書いてあっても Stripe 側に active があるかもしれない。setup のような「副作用大」な操作の前に Stripe 側を実体確認する習慣
2. **DB drift 修復ロジックは「能動的なクリーンアップ」が必要** — Webhook で「いずれ同期される」を期待してはいけない。Webhook は障害発生 / 設定漏れ / 遅延が常にある。重要な状態遷移の前後で能動的に Stripe API を叩いて整合性を保証する
3. **TC-1 を反復実行すると初めて顕在化する** — 単発の TC-1 では Subscription A だけが作成されるので問題は見えない。「同じ TC を何度も実行する」「DB を直接操作してから TC を実行する」等の **異常パターン** をテスト設計に組込むことで早期発見できる (= KDD §5.X+106 と同様の教訓)
4. **「現状の Customer Portal を開く」習慣** — Stripe Dashboard の Customer Portal で実体確認するクセを TC 中に毎回つける。アプリ画面と乖離していたら drift の証拠

### 検証手順 (再発防止用)

```
事前: TC-1 完了済 (paymentMethod='credit_card', sub_id='sub_A', Mastercard 登録)

シナリオ A: 直接 DB 操作で DB drift を発生させる (= 異常系再現)
1. scripts で paymentMethod='invoice' に直書き (= TC-7 UI を経由しない)
   → DB: paymentMethod='invoice', stripeSubscriptionId=null
   → Stripe: Subscription A は active のまま

2. UI で「クレジットカード」に再切替 → 「請求先情報を更新」 → Stripe Checkout → 別カード入力
3. 戻り URL: /settings/tenant?stripe_setup=success ★

4. Stripe Dashboard で Customer の Subscription を確認:
   → Subscription A (Mastercard) は Canceled ★ (= 本 KDD §5.X+107 修正による Step 3.5)
   → Subscription B (Visa) のみ Active ★
   (旧実装は A + B が並存 → 本 KDD 再発)

シナリオ B: Customer Portal でカード変更 (二重作成しないことの確認)
1. Customer Portal で別カード追加 → デフォルトに変更
2. アプリ側で何もしない (= setup 経路を通らない)
3. Stripe Subscription は 1 件のまま ★ (= Customer Portal の操作だけでは新規 Subscription は作られない)
```

### 関連 KDD / PR / feedback

- PR #425 (本事例): TC-1 反復検証中に Customer Portal で実体確認して検出
- 関連修正ファイル:
  - `src/services/stripe-billing.service.ts`
    - `completeStripeSetup` Step 3.5 として `cancelAllActiveStripeSubscriptionsForCustomer` 呼出
    - 新規 内部ヘルパ `cancelAllActiveStripeSubscriptionsForCustomer`
- 関連 KDD:
  - §5.X+105 (cancel 時 DB 即時クリア)
  - §5.X+106 (idempotencyKey)
  - 上記 2 件と組み合わせて TC-1 反復 / TC-7 race condition / DB drift すべてに対応
- 関連 feedback:
  - `feedback_billing_invariant` (★最重要★)
  - `feedback_drift_detection_design` (= 本件は「修復」軸の実装)

---

## 5.X+108 **★severity-1 一貫性★ Stripe `Customer.invoice_settings.default_payment_method` ≠ `Subscription.default_payment_method` — 「画面のカード = 請求カード」一貫性のため Subscription 側を優先取得する (2026-05-22 / PR #425 TC-3 検証中)**

### 発生事象

PR #425 TC-3 (3D Secure 認証) の検証中、新規 3DS Visa `4000 0027 6000 3184` でカード登録 → Stripe Checkout 完了 → アプリ DB は `stripeDefaultPaymentMethodId='pm_新Visa'` で正常更新。

ただしアプリ画面の「請求に使用されるカード」表示は **古い `Mastercard •••• 4444`** のまま。Stripe Customer Portal で確認すると:

- 「現在の Subscription」: **Visa •••• 3184** (= 実際の請求カード = TC-3 の新規 Visa)
- 「決済手段 / デフォルト」: **Mastercard •••• 4444** (= Customer Portal で過去に設定)

つまりアプリ画面が **Customer のデフォルト (Mastercard)** を表示している一方、**実際の月次請求は Subscription のデフォルト (Visa)** から発生する状態。**「画面に出ているカード ≠ 実際に請求されるカード」** という KDD §5.X+103 で死守すべき一貫性が破綻。

### 根本原因

Stripe の **2 つの異なる default_payment_method** の混同:

| フィールド | 意味 | 設定経路 |
|---|---|---|
| `Customer.invoice_settings.default_payment_method` | 新規 Subscription / 単発決済の **初期値** | Customer Portal の「デフォルトに設定」/ Customer 作成時 / 開発者が API で明示設定 |
| `Subscription.default_payment_method` | **その Subscription 固有の引落カード** (= 実際の請求カード) | Subscription 作成時の引数 / API で別途設定 |

**新規 Subscription を作っても Customer のデフォルトは自動更新されない**。テナント運用では:

1. TC-1: 初回 Stripe Checkout で `default_payment_method=Visa pm_A` で Subscription 作成 → Customer のデフォルトも (Subscription 作成時に自動的に) Visa に
2. ユーザが Customer Portal で **Mastercard をデフォルトに変更** → `Customer.invoice_settings.default_payment_method = Mastercard pm`
3. ただし既存 Subscription の引落は Visa のまま (= Stripe 仕様、Subscription レベルが優先)
4. ユーザが TC-7 で銀行振込戻し → Subscription cancel
5. 再度 TC-3 で新規 3DS Visa で setup → 新規 Subscription 作成 (`default_payment_method=新Visa pm`)
6. `Customer.invoice_settings.default_payment_method` は依然として Mastercard (= ステップ 2 のまま、新 Subscription 作成では更新されない)
7. **アプリ画面**: getStripeCardSummary が Customer.invoice_settings を見る → Mastercard 表示 (= 古い)
8. **実際の請求**: 新 Subscription.default_payment_method = 新 Visa → Visa から引落

ユーザは画面を信頼しているため「Mastercard に請求が来る」と思っているが、実際は「Visa に請求が来る」状態。**信用問題に直結する severity-1 不具合**。

### 解決策

`getStripeCardSummary` を **「Subscription があれば Subscription.default_payment_method 優先、なければ Customer.invoice_settings.default_payment_method」** の fallback 設計に変更:

```ts
async function getStripeCardSummary(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { stripeCustomerId: true, stripeSubscriptionId: true },
  });
  if (!tenant?.stripeCustomerId) return null;
  const stripe = getStripe();

  // 優先: Subscription.default_payment_method (= 実際の請求カード)
  if (tenant.stripeSubscriptionId) {
    const subResult = await withStripeError(() =>
      stripe.subscriptions.retrieve(tenant.stripeSubscriptionId!, {
        expand: ['default_payment_method'],
      }),
    );
    if (subResult.ok) {
      const pm = subResult.value.default_payment_method;
      if (pm && typeof pm !== 'string' && pm.type === 'card' && pm.card) {
        return { brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year };
      }
    }
  }

  // フォールバック: Customer.invoice_settings.default_payment_method
  //   - Subscription 未作成テナント (= setup 前)
  //   - Subscription はあるが default_payment_method 未設定 (Stripe 仕様で Customer レベルが請求カード)
  const customerResult = await withStripeError(() =>
    stripe.customers.retrieve(tenant.stripeCustomerId!, { expand: ['invoice_settings.default_payment_method'] }),
  );
  if (!customerResult.ok || customerResult.value.deleted) return null;
  const pm = customerResult.value.invoice_settings?.default_payment_method;
  if (!pm || typeof pm === 'string' || pm.type !== 'card' || !pm.card) return null;
  return { brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year };
}
```

これで「アプリ画面のカード = 実際に毎月引落されるカード」の一貫性が完全に担保される。

### 教訓

1. **★最重要★ Stripe `Customer.default_payment_method` と `Subscription.default_payment_method` は別物** — 同じ API ドキュメントに並んでいるため混同しやすいが、Customer 側は「新規作成時の初期値」、Subscription 側は「実際の引落カード」。**請求カードを画面に出すなら必ず Subscription 側**。Customer 側は「ユーザが Customer Portal でいじれるデフォルト」と理解する
2. **「Customer Portal でデフォルトを変更してもアプリ Subscription の引落カードは変わらない」** — これは Stripe 仕様。Customer Portal の「デフォルト」UI は新規 Subscription 作成時にしか効かない。既存 Subscription のカード変更は Subscription 単位で別途更新が必要 (= Stripe API `stripe.subscriptions.update({default_payment_method})`)
3. **「画面と実体のズレ」は signing 経由でしか検出できない** — Customer Portal でカード変更 + 既存 Subscription 残置のシナリオは、TC-1 単発では出ない。「Customer Portal で操作してから再度アプリ画面を開く」テストパターンを E2E に組込むべき
4. **3DS カード setup 検証は「複数カードが Customer に attach された状態」を必ず作る** — 1 枚目だけだと Customer デフォルト = Subscription デフォルトで一致する偶然があり、本件のような乖離が顕在化しない

### 検証手順 (再発防止用)

```
事前: TC-1 完了済 (Mastercard を Customer Portal でデフォルトに設定済) + 銀行振込戻し済

1. 「請求先情報」セクションで支払い方法を「クレジットカード」 → 「請求先情報を更新」
2. Stripe Checkout で別カード (= 3DS Visa 4000 0027 6000 3184) 入力 → 「保存」 → 3DS 認証 COMPLETE
3. 戻り URL: /settings/tenant?stripe_setup=success ★
4. アプリ画面「請求に使用されるカード」表示確認:
   → Visa •••• 3184 表示 ★ (= 新規 Subscription の引落カード、本 KDD §5.X+108 修正後)
   (旧実装は Mastercard •••• 4444 表示 → 本 KDD 再発)
5. Customer Portal で確認:
   → 「現在の Subscription」: Visa •••• 3184 ★ (= アプリ画面と一致)
   → 「決済手段 / デフォルト」: Mastercard •••• 4444 (= Customer Portal レベルのデフォルト、これはアプリ画面と無関係で OK)
```

### 関連 KDD / PR / feedback

- PR #425 (本事例): TC-3 検証中、Customer Portal で実体確認して検出
- 関連修正ファイル:
  - `src/services/stripe-billing.service.ts` (`getStripeCardSummary` を Subscription 優先に変更)
- 関連 KDD:
  - §5.X+103 (「画面のカード = 請求カード」一貫性原則)
  - §5.X+107 (二重 Subscription 防止)
- 関連 feedback `feedback_billing_invariant` (★最重要★)
- 関連 Stripe 公式: [Subscription default_payment_method](https://docs.stripe.com/api/subscriptions/object#subscription_object-default_payment_method)
- 関連 Stripe 公式: [Customer invoice_settings](https://docs.stripe.com/api/customers/object#customer_object-invoice_settings)

### 追加修正 (2026-05-22 / 同日中の追加発見): Subscription 作成時に Customer.invoice_settings.default_payment_method も同期する

§5.X+108 の修正でアプリ画面と Subscription の引落カードは一致するようになったが、ユーザ
Customer Portal を開くと **「決済手段 / デフォルト」が Subscription の引落カードと違うカード**
(= 過去に Customer Portal で手動設定したまま) のため、ユーザ視点では「DB と Stripe が同期して
いない」 = 混乱を招く UX。

技術的には Stripe 仕様通り (Subscription レベルと Customer レベルは独立した別概念) だが、
ユーザの自然な期待 「Subscription のカード = Customer Portal のデフォルトカード」を満たすため、
`completeStripeSetup` の Step 6 として Customer の `invoice_settings.default_payment_method`
を Subscription の `default_payment_method` と一致させる API 呼出を追加:

```ts
// completeStripeSetup の Step 5 (DB 更新) 後
await stripe.customers.update(sessionCustomerId, {
  invoice_settings: {
    default_payment_method: paymentMethodId,
  },
});
```

これにより以下 3 点が **完全一致**:
1. アプリ画面 (= `getStripeCardSummary` の戻り値 = Subscription.default_payment_method)
2. Stripe Customer Portal の「決済手段 / デフォルト」
3. 実際の月次引落カード (= Subscription.default_payment_method)

Customer Portal でユーザが手動でデフォルト変更した場合はその選択を尊重 (= 上書きしない)。
次回 setup (= 新規 Subscription 作成) 時にまた新カードに同期される。

失敗時の挙動: 同期失敗は `console.warn` のみで続行 (= Subscription は既に作成成功している、
Customer デフォルトは「ズレるだけ」で課金事故にはならない)。

### 追加教訓

5. **「Stripe 仕様通りで正しい挙動」と「ユーザ視点での自然な期待」は別物** — 技術的に正しくても
   ユーザが混乱するなら UX 改善で寄せる。本件は「Subscription = Customer デフォルト」を強制的に
   同期する選択を取った
6. **「3 点完全一致」を invariant に追加** — アプリ画面 = Customer Portal = 実引落カードの 3 点
   が常に一致するよう、Subscription 作成時に Customer デフォルトも同期する。これにより
   「画面と Customer Portal で別の表示」というユーザの不安を構造的に排除

---

## 5.X+109 **★severity-1 一貫性★ Stripe Customer Portal でデフォルト変更しても既存 Subscription の引落カードは変わらない仕様への根本対策 — カード変更動線を Portal から Stripe Checkout 直 update に統一 (2026-05-22 / PR #425 TC-3 反復検証中)**

### 発生事象

KDD §5.X+108 で「Subscription 作成時に Customer.invoice_settings.default_payment_method を同期」した後も、**ユーザが Customer Portal で別カードをデフォルトに変更** すると以下のズレ事故が発生:

- ✅ Customer.invoice_settings.default_payment_method = ユーザが Portal で選んだカード (= Mastercard)
- ❌ **Subscription.default_payment_method = 旧カードのまま (= Visa)**
- → アプリ画面は Subscription を優先表示 (= KDD §5.X+108) のため Visa 表示
- → ユーザ視点: 「Portal でデフォルトを Mastercard にしたのに、画面が Visa を表示」「次の引落も Visa から発生」

ユーザは **「Portal でデフォルト変更 = 実引落カード変更」と認識** しているが、Stripe 仕様では「Customer デフォルト = 新規 Subscription の初期値」「Subscription デフォルト = その Subscription の引落カード」と独立しており、Portal の操作では既存 Subscription は更新されない。

### 根本原因

Stripe 仕様の不一致:
- Customer Portal の UI: 「デフォルトに設定」ボタンで Customer.invoice_settings.default_payment_method のみ更新
- 既存 Subscription の引落カード変更: API `stripe.subscriptions.update({ default_payment_method })` を別途呼ぶ必要あり
- これは Portal UI には存在しない (= 開発者が API で実装する必要あり)

本サービスでは旧設計で「クレジットカード情報更新」ボタン → Customer Portal を新タブで開く動線にしていた。ユーザは Portal でカード追加 + デフォルト設定するが、Subscription への反映が起こらず混乱事故が発生。

### 解決策

**「クレジットカード情報更新」ボタンの動線を Customer Portal から Stripe Checkout (新カード入力) に統一** + completeStripeSetup に「カード変更モード」分岐追加:

```ts
// completeStripeSetup の Step 2.5 (新規追加): カード変更モード分岐
if (tenant.paymentMethod === 'credit_card' && tenant.stripeSubscriptionId != null) {
  // Step A: PaymentMethod を Customer に attach (冪等)
  await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
  // Step B: 既存 Subscription の default_payment_method を新カードに update
  await stripe.subscriptions.update(subId, { default_payment_method: paymentMethodId });
  // Step C: Customer.invoice_settings.default_payment_method も同期 (3 点完全一致のため)
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
  // Step D: DB 更新
  await prisma.tenant.update({ where: { id: tenantId }, data: { stripeDefaultPaymentMethodId, cardLastVerifiedAt, cardVerificationStatus: 'valid' } });
  // Subscription 維持 (= 当月以降の請求すべて新カードに、二重請求なし)
  return { ok: true, value: { subscriptionId, customerId, paymentMethodId } };
}
// それ以外 (= Subscription 未作成) は従来通り新規 Subscription 作成
```

UI 側変更:
- 「クレジットカード情報更新」ボタンは常に Stripe Checkout (setup mode) を起動
- Customer Portal リンクは撤去 (= MVP では不要、請求履歴は別途 `/settings/tenant/billing` で表示)
- 「請求履歴を見る」リンクを Customer Portal リンクの代わりに配置

POST /setup の旧 ALREADY_HAS_SUBSCRIPTION 409 ガード (= KDD §5.X+100) は撤去 (= カード変更モード経路を許容するため)。

### 教訓

1. **★最重要★ 「Customer Portal でカード管理」を前提とした設計は Stripe 仕様の罠を踏みやすい** — Portal の「デフォルト変更」「カード追加」操作は Customer レベルのみで、既存 Subscription の引落カードは別途 API で更新する必要がある。アプリ側で全て制御する設計の方が UX 一貫性を保てる
2. **「ユーザの直感」を最優先する設計判断** — 技術的に正しい (= 画面 = Subscription = 実引落) 状態でも、ユーザの認識「Portal で変更したら引落も変わる」とズレるなら、UX 問題として修正する必要がある。Portal 経由のカード変更ではなく、アプリ画面のボタン経由でのみカード変更を許す設計に統一する
3. **「カード変更モード」と「新規 setup モード」を 1 つの handler に統合する** — completeStripeSetup の Step 2.5 として「Subscription 既存ならカード変更、未作成なら新規作成」に分岐することで、UI 側は単一ボタン (= 「クレジットカード情報更新」) で両方の動線を吸収できる
4. **PR #100 で導入した「ALREADY_HAS_SUBSCRIPTION 409 ガード」のような防御策は将来の設計変更時に撤去要否を必ず再評価する** — 当時は Customer Portal でカード管理する前提で必要だったが、設計変更でカード変更動線が変わったら不要になる。KDD §5.X+100 / §5.X+109 のクロスリンクで撤去履歴を追える

### 検証手順 (再発防止用)

```
事前: TC-1 完了済 (Visa 4242 で初回登録、Subscription active)

シナリオ A: カード変更モード (新動線)
1. /settings/tenant の「クレジットカード情報更新」ボタンを押下
2. 確認ダイアログ「クレジットカード情報を変更しますか?」→ OK
3. Stripe Checkout に遷移 (= 新カード入力画面)
4. 別カード (例 Mastercard 5555 5555 5555 4444) で「保存」
5. 戻り URL: /settings/tenant?stripe_setup=success ★
6. アプリ画面「請求に使用されるカード」: Mastercard •••• 4444 ★
7. Customer Portal 「決済手段 / デフォルト」: Mastercard •••• 4444 ★ (= 3 点完全一致)
8. DB 確認: stripeSubscriptionId は同じ ID 維持 (= 再作成されていない) ★
9. DB 確認: stripeDefaultPaymentMethodId は新 Mastercard pm_* ★

シナリオ B: 「請求履歴を見る」リンク
10. 「クレジットカード情報更新」ボタン横の「📋 請求履歴を見る」リンクをクリック
11. /settings/tenant/billing に遷移 ★ (= 直近 6 ヶ月の請求履歴一覧)
```

### 関連 KDD / PR / feedback

- PR #425 (本事例): TC-3 反復検証中、Customer Portal でカード変更しても画面 / 引落が変わらない混乱を検出
- 関連修正ファイル:
  - `src/services/stripe-billing.service.ts` (completeStripeSetup に Step 2.5 カード変更モード分岐追加)
  - `src/app/api/tenants/me/billing/stripe/setup/route.ts` (ALREADY_HAS_SUBSCRIPTION 409 ガード撤去)
  - `src/app/(dashboard)/settings/tenant/stripe-payment-method-section.tsx` (Portal 経路撤去、Checkout 統一、請求履歴リンク追加)
- 関連 KDD:
  - §5.X+100 (旧 ALREADY_HAS_SUBSCRIPTION ガード導入、本 KDD で撤去)
  - §5.X+108 (Customer / Subscription default 同期、本 KDD はその完全版)
- 関連 feedback `feedback_billing_invariant` (★最重要★)

---

## 5.X+110 **★severity-2 品質ゲート★ bash pipe で exit code を誤判定 → CI が fail するのに「ローカルでは PASS」と錯覚する罠 + 新規 API route で `e2e:coverage-check` 漏れ (2026-05-22 / PR #425 CI fail 検出)**

### 発生事象

PR #425 のマージ前最終 quality gates 確認で、ローカル `pnpm e2e:coverage-check | tail -10` の結果を「✅ PASS」と判定して push したが、GitHub Actions の **Lint / Test / Build** ジョブが exit code 1 で失敗:

```
❌ docs/test/E2E_COVERAGE.md に未記載の機能があります:
   - /api/tenants/me/billing/stripe/setup-with-existing-card
ELIFECYCLE  Command failed with exit code 1.
```

新規追加した API route (`setup-with-existing-card`) を `docs/test/E2E_COVERAGE.md` に追記し忘れていた。CI の `pnpm e2e:coverage-check` で正しく検出されたが、**ローカル確認は通っていると誤認識** していた。

### 根本原因

Bash の **pipe 末尾コマンドの exit code が全体の exit code として返される** 仕様:

```bash
pnpm e2e:coverage-check | tail -10
# exit code は tail のもの (= 通常 0)、pnpm 本体の exit code は失われる
```

`pnpm e2e:coverage-check` が exit 1 (= 失敗) でも、`tail` は通常 exit 0 を返すため、シェルレベルでは「成功」と判定される。本セッション中の quality gate 確認 (= 全 commit の lint / tsc / test / build) はすべてこの pipe で実行していたため、tsc / test ファイルの型 drift / e2e カバレッジ漏れが見落とされた状態で commit が積まれた。

実は本 PR 開始前にも複数の既存テスト型エラー (= `ApiUsageReconcileResult` / `TenantMonthlyResetResult` の drift) が存在しており、本 PR では検出できなかったため別 PR に持ち越しとなる。

### 解決策

#### 即時対応 (= 本 PR で対応済)
- `docs/test/E2E_COVERAGE.md` に `/api/tenants/me/billing/stripe/setup-with-existing-card` の skip エントリ追加
- 「`pnpm e2e:coverage-check; echo "EXIT: $?"`」で exit code を明示出力する確認方法に切替

#### 再発防止 (= 今後の運用)

**Quality gate コマンドを実行する時は、必ず以下のいずれかで exit code を保証**:

| 方法 | 例 | 用途 |
|---|---|---|
| **A (推奨)**: コマンド単体実行 + `echo $?` で exit code 明示 | `pnpm lint; echo "EXIT: $?"` | 単発確認 |
| B: `set -o pipefail` で pipe 全体の最大 exit を採用 | `set -o pipefail; pnpm lint \| tail -5` | スクリプト内 |
| C: 出力を一旦ファイルに保存して exit を確認 | `pnpm lint > /tmp/lint.out 2>&1; echo "EXIT: $?"; tail -20 /tmp/lint.out` | 長い出力時 |
| D: バックグラウンド実行 (= タスク完了通知に exit code 含まれる) | Claude Code Bash tool の `run_in_background` | バックグラウンド |

特に Claude Code の Bash tool は **バックグラウンドコマンドの実際の exit code をタスク完了通知に含めて返す** (= `Background command "xxx" completed (exit code 1)`)。pipe で見た目を整形する前に、まず exit code を取得することが重要。

### 教訓

1. **★最重要★ `pnpm xxx | tail -5` パターンは exit code 誤認識の温床** — `tail` / `head` / `grep` 等の filter コマンドは pnpm 本体の失敗を隠す。Quality gate 確認では必ず exit code を別途取得する
2. **CI で初めて検出される問題は「ローカル品質ゲートの誤認識」が原因のことが多い** — ローカルで PASS と判定したのに CI で fail する場合、まず「ローカル判定が正しかったか」を疑う (= pipe / バックグラウンド実行 / キャッシュ等)
3. **新規 page.tsx / route.ts 追加時は必ず `docs/test/E2E_COVERAGE.md` も更新** — `pnpm e2e:coverage-check` の CI gate に弾かれる前に手元で対応 (= feedback_e2e_coverage_gate)
4. **`netlify-ignore.sh` の docs-only skip 判定を活用する** — docs/test/E2E_COVERAGE.md の追加修正だけ push する場合、Netlify Deploy Preview の rebuild は skip され credit 消費なし

### 検証手順 (再発防止用)

```
新規 page.tsx / route.ts 追加 → commit 前に必ず:
1. pnpm e2e:coverage-check; echo "EXIT: $?"
2. EXIT が 0 でない場合、出力に従い docs/test/E2E_COVERAGE.md を更新
3. 再度 pnpm e2e:coverage-check; echo "EXIT: $?" で EXIT 0 確認
4. commit & push

CI fail を疑似再現するには:
1. 適当な API route を新規作成して docs に追記せずに commit
2. push 後の GitHub Actions ログで「Lint / Test / Build」が exit 1 で fail することを確認
```

### 関連 KDD / PR / feedback

- PR #425 (本事例): マージ前最終 quality gates で発覚
- 関連修正ファイル:
  - `docs/test/E2E_COVERAGE.md` (`/api/tenants/me/billing/stripe/setup-with-existing-card` skip エントリ追加)
- 関連 KDD §5.X+102 (検索/ソート横断問題、同じく「CI gate で初めて検出」事案)
- 関連 feedback `feedback_e2e_coverage_gate` (新規 route.ts / page.tsx を追加したら pnpm e2e:coverage-check を必ずローカル実行)
- 関連 doc `docs/developer-guide/LOCAL_TEST_GUIDE.md` (= 本 PR で新規作成、quality gate 実行時の注意事項として本 KDD 内容を追記検討)

---

## 5.X+111 **★severity-2 品質ゲート★ 「実装側の契約変更 (idempotencyKey スキーマ拡張)」と「invariants test の exemption 漏れ (新規 service ファイル追加)」の 2 件同時 CI fail (2026-05-22 / PR #425 2 回目 CI fail)**

### 発生事象

§5.X+110 の対応 (`docs/test/E2E_COVERAGE.md` 追記) を push した後、**Lint / Test / Build** ジョブが再度 fail。`pnpm test --coverage` で 2 件の test failure:

1. `src/services/stripe-billing.service.test.ts > createSubscriptionForTenant > Subscription Items: haiku + sonnet + storage Plus が含まれる`
   ```
   AssertionError: expected 'subscription:create:00000000-0000-000…' to be 'subscription:create:00000000-0000-000…'
   Expected: "subscription:create:00000000-0000-0000-0000-000000000abc"
   Received: "subscription:create:00000000-0000-0000-0000-000000000abc:pm_xxx"
   ```
2. `src/services/__tests__/tenant-isolation-invariants.test.ts > ★テナント分離 リグレッション防止 — Service 層★ > .../src/services/netlify-metrics.service.ts に tenantId / viewerTenantId フィルタが含まれている`
   ```
   AssertionError: expected false to be true
   ```

ローカル `pnpm test -- --run | tail -5` の pipe で再び exit code が tail 0 に隠された (= §5.X+110 で記録したばかりの罠を **同セッション内で再踏み**)。

### 根本原因

#### 失敗 1: 実装側の契約変更が test mock に未反映

PR #425 KDD §5.X+106 で **idempotencyKey に `paymentMethodId` を追加** (= カード再登録時の Stripe reject 回避) する変更を `stripe-billing.service.ts` に入れたが、対応する test の `expect(opts.idempotencyKey).toBe(...)` を旧形式 `subscription:create:${TENANT_ID}` のまま放置していた。

```typescript
// src/services/stripe-billing.service.ts:860 (PR #425 で変更)
idempotencyKey: `subscription:create:${input.tenantId}:${input.paymentMethodId}`

// src/services/stripe-billing.service.test.ts:444 (旧契約のまま)
expect(opts.idempotencyKey).toBe(`subscription:create:${TENANT_ID}`);  // ❌
```

「実装と一緒に test も更新する」原則を満たしておらず、レビュー時にも気付かれなかった。

#### 失敗 2: invariants test の exemption 漏れ

PR #425 で新規追加した `src/services/netlify-metrics.service.ts` は **Netlify 外部 API client** (= テナント DB アクセスなし、外部 SaaS のグローバル metrics 取得) のため tenantId / viewerTenantId フィルタが構造的に存在しないが、`tenant-isolation-invariants.test.ts` が `src/services/` 配下を全件スキャンして「`tenantId:` 等の文字列が含まれること」を要求する仕様のため、新規ファイルが追加された瞬間に fail。

`CROSS_TENANT_ALLOWED_FILES` の許可リストへの追加が必要だった。

### 解決策

#### 即時対応 (= 本 commit で対応済)

1. **test mock 更新**: `expect(opts.idempotencyKey).toBe(\`subscription:create:${TENANT_ID}:pm_xxx\`)` に変更。`pm_xxx` を input にしているので mock 側も追従。
2. **invariants exemption 追加**: `CROSS_TENANT_ALLOWED_FILES` Set に `'netlify-metrics.service.ts'` を追加 + 「Netlify 外部 API client (= テナント DB アクセスなし、super_admin Diagnostics 用)」コメント。
3. **§5.X+110 の運用ルールを再徹底**: 本セッション内で pipe 罠を再踏みしたため、quality gate 確認は **必ず `; echo "EXIT: $?"` 付き** で実行する。

#### 再発防止 (= 今後の運用)

| 観点 | チェックポイント |
|---|---|
| **A. 実装契約変更 (= 関数シグネチャ / 戻り値形式 / 副作用)** | 変更直後に対象 test ファイルを必ず `pnpm test --run <test-file>; echo "EXIT: $?"` で実行する。「実装と一緒に test も更新する」を **同一 commit 内で完結** |
| **B. 新規 service ファイル追加** | `src/services/` 配下に新規 .ts を追加したら、`tenant-isolation-invariants.test.ts` の `CROSS_TENANT_ALLOWED_FILES` に追加するか、`viewerTenantId` フィルタを実装する。**追加先の判断基準**: テナント DB アクセスがあるか? あれば実装する側、なければ exemption に追加 |
| **C. CI gate 確認** | `pnpm test --run; echo "EXIT: $?"` で **pipe を使わずに exit code 直接取得**。`tail` / `head` / `grep` 等を経由しない |

### 教訓

1. **★最重要★ 同セッション内で pipe 罠を再踏みした** — §5.X+110 で記録したばかりの罠を **直後の確認で再度踏んだ**。記録するだけでなく **次の Bash tool 実行時に意識的に避ける** こと。教訓のメタ教訓: 「KDD に書いただけで対策完了」ではない、**次の実行で意識せよ**
2. **新規 service ファイル追加時は invariants test の許可リスト適合性を必ず確認** — `CROSS_TENANT_ALLOWED_FILES` の追加可否を判断 (= テナント DB アクセスの有無で機械的に判定可能)
3. **「契約変更 (idempotencyKey スキーマ拡張)」と「test 更新」を分離してはいけない** — 契約変更 commit に必ず該当 test 更新を含める。レビューで指摘されなくても自分でチェック
4. **CI fail のログは表面 (PR コメントの coverage action ENOENT) ではなく upstream の `pnpm test --coverage` ステップを最初に見る** — `vitest-coverage-report-action` の ENOENT は upstream test 失敗の **symptom (= coverage-summary.json が生成されない)** であり真の原因ではない

### 検証手順 (再発防止用)

```
新規 service.ts 追加 / 既存 service.ts シグネチャ変更時:
1. pnpm test --run src/services/__tests__/tenant-isolation-invariants.test.ts; echo "EXIT: $?"
2. pnpm test --run <変更した service の test ファイル>; echo "EXIT: $?"
3. pnpm test --run; echo "EXIT: $?"  ← 全体回帰
4. 全部 EXIT 0 を確認してから commit

★全 quality gate 確認は必ず pipe を使わずに `; echo "EXIT: $?"` 付きで実行 (§5.X+110 の罠回避)
```

### 関連 KDD / PR / feedback

- PR #425 (本事例): §5.X+110 push 後の 2 回目 CI fail
- 関連修正ファイル:
  - `src/services/stripe-billing.service.test.ts` (L444 idempotencyKey expectation 更新)
  - `src/services/__tests__/tenant-isolation-invariants.test.ts` (`CROSS_TENANT_ALLOWED_FILES` に `netlify-metrics.service.ts` 追加)
- 関連 KDD §5.X+106 (idempotencyKey に paymentMethodId を含める設計判断)
- 関連 KDD §5.X+110 (bash pipe exit code 罠 — 本件で **同セッション内で再踏み**)
- 関連 feedback `feedback_tenant_isolation` (invariants test の役割 = severity-1 個人情報漏洩リスク予防)
