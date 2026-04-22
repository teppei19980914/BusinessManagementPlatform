# 開発者ガイド (DEVELOPER_GUIDE.md)

> 本書はプログラムの**改修 / 機能追加 / 機能削除**を実施する人向けの実務手順書です。
> 「どこを触れば何が起きるか」を具体的なファイル単位で示し、AI に頼らず一人で
> 作業できることを目的とします。
>
> 関連:
> - [README.md](../README.md) — プロジェクト概要・初回セットアップ
> - [docs/OPERATION.md](./OPERATION.md) — デプロイ・運用・障害対応
> - [docs/DESIGN.md](./DESIGN.md) — 詳細設計 (情報源)
> - [docs/SPECIFICATION.md](./SPECIFICATION.md) — 機能仕様

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

詳細は [docs/OPERATION.md](./OPERATION.md) §3 (DB マイグレーション手順) を参照。

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

[.github/workflows/security.yml](../.github/workflows/security.yml) の最後に
`attack-matrix` job があり、GitHub Actions の **Job Summary** に以下のような
攻撃種別マトリクスを日本語で自動出力する:

| 状況 | 攻撃種別 (Attack) | 主な検証手段 |
|:---:|---|---|
| ✅ | 機密情報漏洩 (Secrets Exposure, CWE-798) | gitleaks |
| ✅ | SQL インジェクション (SQL Injection, CWE-89) | Semgrep / CodeQL + Prisma ORM |
| ✅ | 認可バイパス / IDOR (Authorization Bypass, CWE-639) | CodeQL + checkProjectPermission |
| ... | ... | ... |

- テンプレートは [.github/attack-matrix-summary.md](../.github/attack-matrix-summary.md)
- ワークフロー側で `sed` による `@@FOO@@` プレースホルダ置換で実スキャン結果を埋め込む
- **行を追加/編集したいとき**: `.github/attack-matrix-summary.md` を直接編集する。
  `to_mark` / `or_mark` で使えるステータストークン (`@@GITLEAKS@@` / `@@AUDIT@@` /
  `@@SAST@@` / `@@CODEQL@@`) は security.yml の `sed` で定義済み。新しい検証手段を
  増やす場合は security.yml にも変数を追加する。

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

### 9.5 新機能追加時の E2E カバレッジ横展開 (必須)

**新しい `page.tsx` や `route.ts` を追加したら、必ず `docs/E2E_COVERAGE.md` を更新**してください。
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

### 9.6 視覚回帰のベースライン運用 (PR #90 合意)

視覚回帰テスト (`e2e/visual/*.spec.ts`) の baseline PNG は `e2e/**__screenshots__/` に
commit されています。**PR 中に baseline 更新を許容**する方針です (前提: リビジョンが
git 履歴に残るため監査可能):

1. PR で UI を変更した結果、視覚回帰が fail する
2. ローカルで `pnpm test:e2e:update-snapshots` を実行
3. 更新された PNG を git commit
4. レビュアは PR diff で新旧 baseline の画像差分を確認
5. 意図したなら承認、意図しないなら指摘

baseline を上げずに fail したままマージすると main が red になり続けるので、
**PR マージ前に必ず緑化**してください。

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
