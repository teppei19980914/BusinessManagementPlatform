# レスポンシブ対応 監査レポート (PR #128)

> 要望項目 7「モバイル端末 (スマホ / タブレット) の画面に合わせたレスポンシブ対応」の
> 実装計画書。全 UI ファイルを監査し、非レスポンシブ箇所を特定 + 段階的 PR 分割方針を定める。

## 前提

### 設計原則

- **PC の UX は落とさない** (ユーザ明言、メイン作業環境)
- **スマホの UX を最大限向上** (PC UX を損なわない範囲で)
- **タブレットは最低優先** (現状の responsive でおおむね許容)

### 対象 Breakpoint

| Tailwind | 幅 | 想定端末 | 本件での優先度 |
|---|---|---|---|
| default (〜639px) | 〜639px | 縦向きスマホ | 🔴 最優先 |
| `sm:` (640px+) | 640〜767px | 横向きスマホ | 🟡 中 |
| `md:` (768px+) | 768〜1023px | タブレット | 🟢 低 |
| `lg:` (1024px+) | 1024px+ | PC | ✅ 現状維持 |

## サマリ (監査結果)

| 観点 | 検出数 | 評価 |
|---|---|---|
| (A) 固定幅 (>380px) | 1 箇所 | 🟡 軽微 (date-field-with-actions カレンダー) |
| (B) テーブル多列 | 8 ファイル | 🔴 **要対応** — PR #128a |
| (C) ダイアログ | 0 箇所 | ✅ 既に responsive 対応済 (`max-w-[min(90vw,Xrem)]`) |
| (D) グリッド | 0 箇所 | ✅ `grid-cols-2` + breakpoint で対応済 |
| (E) Flex 折返 | 0 箇所 | ✅ `flex-wrap` / `flex-col sm:flex-row` で対応済 |
| (F) タップ領域 | 0 箇所 | ✅ 44×44px 基準を満たす |
| (G) テキストサイズ | 64 箇所 (`text-xs`) | 🟢 低 (補助テキスト用途で読み取り専用) |

**総検査ファイル数**: 85 (src/ 配下の `.tsx` / `.ts`、generated / node_modules 除く)

## 要対応箇所 (優先度 H: PR #128a 以降で対応)

### (A) 固定幅: 1 箇所

| 優先度 | ファイル:行 | 該当 | 推奨対応 |
|---|---|---|---|
| M | `src/components/ui/date-field-with-actions.tsx:71` | `w-[260px]` (カレンダーポップオーバー) | `max-w-[min(90vw,260px)]` へ |

→ **PR #128 (本 PR) で即修正**。320px デバイスでの画面外はみ出しを防止。

### (B) テーブル多列 (8 ファイル、10〜15 列)

モバイルでは横スクロール必須となり、UX が著しく低下する。カード化が必要。

| ファイル | 列数 | 画面 | 使用頻度 | 優先度 |
|---|---|---|---|---|
| `src/app/(dashboard)/projects/projects-client.tsx` | ≥5 | `/projects` | 🔴 最高 (エントリ) | 🔴 P1 |
| `src/app/(dashboard)/projects/[projectId]/tasks/tasks-client.tsx` | ≥6 | `/projects/[id]/tasks` | 🔴 高 | 🔴 P1 |
| `src/app/(dashboard)/risks/all-risks-table.tsx` | 12〜15 | `/risks` / `/issues` | 🟡 中 | 🟡 P2 |
| `src/app/(dashboard)/retrospectives/all-retrospectives-table.tsx` | 11〜12 | `/retrospectives` | 🟡 中 | 🟡 P2 |
| `src/app/(dashboard)/knowledge/knowledge-client.tsx` | 9 | `/knowledge` | 🟡 中 | 🟡 P2 |
| `src/app/(dashboard)/all-memos/all-memos-client.tsx` | 5 | `/all-memos` | 🟢 低 | 🟢 P3 |
| `src/app/(dashboard)/admin/users/users-client.tsx` | 5+ | `/admin/users` | 🟢 低 (admin のみ) | 🟢 P3 |
| `src/app/(dashboard)/admin/audit-logs/page.tsx` | 5 | `/admin/audit-logs` | 🟢 低 (admin のみ) | 🟢 P3 |

### その他 (低優先)

- `text-xs` 64 箇所: 補助テキスト用途が大半、モバイルでの読みにくさは限定的。PR #128d fine-tune 時に必要に応じて `sm:text-xs` or `text-[0.8rem]` 等へ調整

## 段階的 PR 分割計画

### PR #128 (本 PR): **監査 + 基盤 + 自動化**

- この監査レポート自体
- `ResponsiveTable` 基盤コンポーネント (テーブル + カード自動切替)
- `date-field-with-actions.tsx:71` の即時修正
- Playwright モバイルビューポート E2E 設定 (`playwright.config.ts` の projects 追加)
- `DEVELOPER_GUIDE.md §5.9` レスポンシブ実装パターン追加
- `TESTING_STRATEGY.md` にモバイル E2E テスト方針

### PR #128a: **P1 テーブルのカード化**

- `/projects` (projects-client.tsx)
- `/projects/[id]/tasks` (tasks-client.tsx — WBS は階層構造もあるため最重要)

対応方針:
- `<ResponsiveTable>` 導入 (md: 以上でテーブル、未満でカード)
- 各行のカード表示でも表形式と同等の情報アクセスを確保
- E2E: モバイルビューポートで主要 CRUD 操作が成立することを検証

### PR #128b: **P2 横断 一覧画面のカード化**

- `/risks` / `/issues` (all-risks-table.tsx)
- `/retrospectives` (all-retrospectives-table.tsx)
- `/knowledge` (knowledge-client.tsx)

### PR #128c: **P3 admin / 低優先 画面**

- `/all-memos`, `/admin/users`, `/admin/audit-logs`, `/admin/role-changes`, `/customers`

### PR #128d: **細部調整 (fine-tune)**

- text-xs の適切化 (必要な箇所のみ)
- タップ領域微調整
- フォーム入力体験 (autocomplete / inputmode)
- 横向きスマホ (sm:) の詳細調整

## Gantt の扱い (方針確認済)

`/projects/[id]/gantt`: **現状維持**。Gantt は本質的に横スクロール UI であり、編集機能も無い (read-only) ため、モバイルでは参照のみ可で許容する (ユーザ指示)。

## E2E 回帰防止戦略

### Playwright 設定 (PR #128 で追加)

`playwright.config.ts` に **モバイルビューポート project** を追加:

```ts
projects: [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  // chromium-mobile は Chromium エンジンで iPhone 13 をエミュレート。
  // devices['iPhone 13'] は defaultBrowserType='webkit' を内包するため必ず override する
  // (E2E_LESSONS_LEARNED §4.35: CI の playwright install chromium 限定と整合を取る)。
  { name: 'chromium-mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },  // 390x844
  // tablet は優先度低のため初期は省略
],
```

### テスト戦略

| テスト種別 | モバイル対応 |
|---|---|
| **機能 E2E** (specs/) | PR #128a 以降で主要フローのみモバイル実行 (CRUD 操作 / ナビ / ダイアログ開閉) |
| **視覚回帰** (visual/) | PR #128a 以降で `*-mobile.png` baseline を追加 |
| **単体テスト** | 影響なし (UI ロジックは Viewport 非依存) |

### デグレ防止の観点

- PC 視覚回帰 baseline (既存) は変更しない → PC UX の退行を検知可能
- モバイル視覚回帰 baseline を新設 → モバイル UX の退行を検知可能
- 機能 E2E (既存) はモバイルビューポートでも成立させる → 両環境で機能デグレ検知

## 実装原則 (各 PR 共通)

### テーブルのカード化方針

md 未満でカード表示、md 以上で従来テーブル:

```tsx
<ResponsiveTable
  items={rows}
  columns={[
    { key: 'title', label: '件名', primary: true },      // カードのタイトル
    { key: 'assignee', label: '担当者' },
    { key: 'status', label: 'ステータス', badge: true },
    // ...
  ]}
  onRowClick={handleClick}
/>
```

内部で:
- `md:` 以上: 従来 `<Table>` をレンダリング (PC UX 変更なし)
- `md:` 未満: 各 row を `<Card>` にレンダリング

### 共通パターン

- 広い viewport で flat / 狭い viewport で圧縮は `hidden md:flex` / `md:hidden` で切替
- テキストは `text-sm md:text-base` のような適切な breakpoint 付与
- マージン / パディングは `p-3 md:p-4` のような段階化
- スマホ対応が必須な要素は `max-w-[min(90vw,Xrem)]` のパターン

## 判断に迷う箇所 (今後の運用ルール)

1. **「横スクロールで十分」の境界**: 列数が 4 以下なら横スクロール可、5 以上でカード化検討
2. **Admin 画面のスマホ対応**: 使用頻度が低いため、最低限「動作すれば OK」レベルで可 (P3 優先)
3. **Gantt / チャート系**: モバイルは参照のみ、編集は PC 前提

## 関連

- `docs/developer/SPECIFICATION.md §20.4` (ナビ 3 分類 hybrid は PR #127 で完了)
- `docs/developer/DEVELOPER_GUIDE.md §5.9` (レスポンシブ実装パターン、PR #128 で追加)
- `docs/developer/TESTING_STRATEGY.md` (モバイル E2E 方針、PR #128 で追加)

## 更新履歴

| 日付 | 内容 |
|---|---|
| 2026-04-24 | 初版作成 (PR #128)。85 ファイル監査、8 テーブル特定、段階 PR 分割計画 (#128a-d) |
| 2026-04-24 | PR #128a 完了: `/projects` 並列カードビュー |
| 2026-04-24 | PR #128a-2 完了: WBS `/projects/[id]/tasks` 階層字下げカード (PC UX 完全保全) |
| 2026-04-24 | PR #128b 完了: P2 横断 4 画面 (`/risks` / `/issues` / `/retrospectives` / `/knowledge`) |
| 2026-04-24 | PR #128c 完了: P3 admin 5 画面 (`/all-memos` / `/admin/users` / `/admin/audit-logs` / `/admin/role-changes` / `/customers`)。`/admin/users` は `getLockBadgeProps` 外出しの純粋リファクタ同梱 |
| 2026-04-24 | PR #128d 完了: fine-tune。MFA TOTP 入力 (`settings/settings-client.tsx`) に `inputMode="numeric"` / `pattern` / digit filter 統一、リカバリーコード 2 箇所 (`login/mfa/mfa-form.tsx`, `reset-password/page.tsx`) に `autoCapitalize="characters"` / `autoCorrect="off"` / `spellCheck={false}` 追加。その他 fine-tune 項目 (text-xs 64 箇所 / text-xl レスポンシブ化 / padding) は監査時点で影響低と判定済のためスコープ外。必要になれば将来個別 PR で対応。 |

---

## 全対応完了 (2026-04-24)

**モバイル対応状況**: 全主要画面 (P1 / P2 / P3) のカード化完了、入力属性の最適化完了。

今後の TODO:
- モバイル視覚回帰 baseline 生成 (`[gen-visual]` で CI 生成)
- E2E mobile project (PR #128 で追加) での回帰テスト実地確認
- 将来発見された非レスポンシブ箇所は本書に追記 + 個別 PR で対応
