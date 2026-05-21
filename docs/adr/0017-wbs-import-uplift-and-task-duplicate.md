# ADR-0017: WBS sync-import の親スコープ重複判定 + OCC + DB UNIQUE + タスク一括複製 + ログイン UX (PR #420)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Deciders**: PM (teppei) + Claude Code

---

## Context (背景)

PR #420 で以下 4 つの独立した変更を 1 PR にバンドルすることを決定した。スコープが大きいが、互いに関連する設計判断があるため 1 つの ADR に集約する。

### 動機 1: WBS sync-import の致命的バグ報告

ユーザから「**別 WP 配下の同名 ACT を含む CSV がインポートできない**」事象が報告された。具体例:

```
WPA / [AACT, BACT, CACT, DACT]
WPB / [AACT, BACT, CACT, DACT]  ← AACT-DACT は同名だが別 WP 配下
```

旧実装の重複判定キーが `${level}::${name}` (親無視) だったため、業務上正当な「設計レビュー」「結合テスト」等の繰り返しタスクが誤ブロッカー判定されていた。コードコメント自身が「本来は level+parent+name で判定すべき」と認める実装簡略化。

### 動機 2: WBS UX の総合的改修要望

WBS は日々の運営で最も操作する核心機能であり、UX が低下するとユーザ離脱・サービス評価低下に直結する。報告事象を機に以下を一括対応することにした:

- エラー文言のガイダンス化 / フィルタ / D&D / レスポンシブ
- CSV テンプレート DL / 即時 dry-run / 削除確認ダイアログ
- 並行編集検出 (OCC)
- DB 制約による defense-in-depth

### 動機 3: ログイン画面の組織 ID 入力負担

ADR-0016 で multi-tenant 化した結果、ログイン時に組織 ID (tenantSlug) 手入力が必須化されたが、ユーザから「毎回手入力するのは重い」「忘れがち」の声があった。

### 動機 4: 画面上で複数タスクを作成する導線

WBS インポートに頼らずに、画面操作だけで「既存タスクを階層保持で複数複製」する導線が欲しいという要望。

### 制約

- **PgBouncer transaction mode**: `prisma.$transaction` 不可。advisory lock も不可。並行制御は application-level に閉じる必要がある
- **Prisma の `@@unique` は WHERE 句を表現できない**: 部分 UNIQUE インデックスは raw SQL migration 必須
- **既存 UI / API への破壊的変更不可**: ADR-0016 の流れと整合する必要がある

---

## Decision (採用した決定)

### 1. WBS sync-import の重複判定スコープを「同一親配下」に統一 (A1/A2)

- CSV パーサに `parentRowIndex` を追加 (level スタックから動的決定)
- 重複判定キーを `${parentRowIndex ?? '__root__'}::${name}` に変更
- DB 既存タスクとの「誤コピー検知」も `(parentTaskId, name)` スコープに限定

### 2. CSV ヘッダーの厳格検証 (A3)

- 列名・列順・列数 (≥4) を `parseSyncImportCsv` で事前検証
- 不一致は `globalErrors` に追加してブロッカー化 (旧実装の silent skip を廃止)

### 3. OCC (Optimistic Concurrency Control) で並行編集検出 (C2)

- `computeSyncDiff` が project 配下 task の最大 `updatedAt` を `snapshotAt` として返す
- client は `x-import-snapshot-at` HTTP header に snapshotAt を添えて本実行
- server で再取得した snapshotAt と比較、不一致なら `IMPORT_CONCURRENT_EDIT` (HTTP 409) で中断
- 旧 UI (header 未送信) は best-effort で OCC スキップ

### 4. DB レベル部分 UNIQUE インデックス (C3)

- `(project_id, COALESCE(parent_task_id, '00000000-0000-0000-0000-000000000000'::uuid), name) WHERE deleted_at IS NULL`
- raw SQL migration として追加 (`20260525_tasks_unique_parent_name`)
- migration の `DO $$` ブロックで既存重複を事前検出、duplicate あれば `RAISE EXCEPTION` で停止
- 本番事前確認スクリプト: `scripts/check-task-name-duplicates.ts`

### 5. WBS タスク一括複製 (新機能)

- bulk action bar に「複製」ボタン (PM/TL+) を追加
- `POST /api/projects/[projectId]/tasks/bulk-duplicate` endpoint 新設
- 階層保持・名称衝突の自動リネーム "(コピー)" suffix・計画情報コピー・実績情報リセット
- 上限 100 件、`audit_logs.action='BULK_DUPLICATE'`

### 6. 既存 createTask / updateTask の name uniqueness 事前ガード

- DB UNIQUE 制約 (C3) の defense-in-depth として、`assertTaskNameUniqueInParent` ヘルパで `prisma.task.count` 検知
- 衝突時は `TASK_NAME_DUPLICATE_IN_PARENT` (HTTP 400) + ユーザフレンドリーメッセージ
- 全 INSERT/UPDATE 経路 (create / update / sync-import / bulk-duplicate) で網羅

### 7. ログイン UX 改修 (組織 ID localStorage 履歴)

- 直近 5 件の `(slug, name, lastUsedAt)` を localStorage に LRU 保存
- `<datalist>` プルダウン候補表示、最直近を input 初期値に
- 90 日 expire / shape 検証 / 履歴クリアリンク / 共用 PC 注意喚起
- 「組織 ID 不明時は管理者へ問合せ」アナウンス常時表示
- 認証付 `GET /api/auth/current-tenant-info` で post-auth に slug+name 取得 (pre-auth 列挙防止)

### UX 設計の優先方針

「WBS の作成・更新は日々の運営で最も操作する核心機能」という認識のもと、報告事象の修正だけでなく **総合的な UX uplift** を 1 PR にバンドル。

---

## Consequences (影響)

### Positive

- ✅ 報告された致命的バグの解消 (別 WP 配下の同名 ACT が正常インポート可能に)
- ✅ DB UNIQUE 制約による defense-in-depth (将来の bypass 経路に対する根本防御)
- ✅ OCC により dry-run と apply の間の並行編集を検出 (= 意図しない差分上書きを防止)
- ✅ ログイン UX 改善: 2 回目以降のログインで組織 ID 自動入力 (シークレットウィンドウ以外)
- ✅ タスク一括複製により、テンプレ的なタスク群の量産が画面操作で完結
- ✅ WBS dialog の D&D / フィルタ / 削除確認等 UX 改善

### Negative / Trade-off

- ⚠️ PR スコープが大きく、レビューに 3 回 + 修正 5 件 (見逃しを補修するマルチパスレビュー)
- ⚠️ DB UNIQUE 制約追加に伴い、既存 create/update 経路にも app 層 defense を後付け実装 (もし制約だけ追加していたら 500 エラーで UX 破壊)
- ⚠️ localStorage 履歴は per-browser / per-profile のため、デバイス・ブラウザ跨ぎでは初回手入力が必要
- ⚠️ OCC は best-effort (旧 UI からの本実行は header 未送信で OCC スキップ)

### Risk / 留意事項

- **本番 DB の既存重複検査必須**: migration の `DO $$` ブロックで停止するため、deploy 前に `pnpm tsx scripts/check-task-name-duplicates.ts` で 0 件確認
- **localStorage XSS 経路の防御**: tenant-history.ts の読込時検証 (slug pattern / name 長 / lastUsedAt 範囲) で改竄データを破棄
- **PgBouncer 制約に依存した設計**: 将来 PgBouncer から離れた場合、$transaction + advisory lock の真の並行制御に移行可能

---

## Alternatives Considered (検討した代替案)

### Alt-1: 名称衝突を強制エラーで弾く (自動リネームなし)

- 概要: 一括複製で同名衝突があれば「リネームしてから再実行してください」のエラーを返す
- メリット: 実装シンプル、ユーザに明示的に意思決定させる
- 不採用理由: 複製対象が多い (例: 30 件選択) と毎回エラー → 手動リネーム → 再実行 のループになり UX 悪い

### Alt-2: Pre-auth で email から所属 tenant 一覧を返す API を新設

- 概要: ログイン時 email 入力後に該当 tenant 候補を プルダウン表示
- メリット: 1 回目から組織 ID 入力ゼロ
- 不採用理由: **email enumeration リスク** (誰でも「この email がどの組織にいるか」を探れる)。ADR-0016 が "Option B" (組織 ID 明示入力) を選んだ経緯と矛盾するため、localStorage 履歴 + post-auth 取得の安全パスを採用

### Alt-3: `prisma.$transaction` で並行制御 + 全 INSERT/UPDATE をトランザクション化

- 概要: 強い並行制御を採用
- メリット: 並行編集を完全に防止
- 不採用理由: PgBouncer transaction mode で **`$transaction` 自体が使えない**。代替として「snapshot 取得 → client 持ち回し → 再比較」の OCC を採用

### Alt-4: クロスデバイス組織 ID 同期 (DB 保存)

- 概要: User profile に「最後にログインした tenant」を保存し、ブラウザ跨ぎでも自動入力
- メリット: クロスデバイスで初回手入力ゼロ
- 不採用理由: ADR-0016 multi-tenant 設計と本質的に衝突 (= ユーザは複数 tenant を使い分け可)。将来ニーズが高まれば「post-auth picker」(email+password → 認証 → tenant 選択) として ADR を別途切る

### Alt-5: DB UNIQUE 制約を後続 PR に分離

- 概要: 本 PR は app 層 (sync-import + duplicate) のみとし、UNIQUE 制約は別 PR
- メリット: PR サイズが小さい
- 不採用理由: app 層 defense と DB 制約は密結合 (片方だけでは bypass 経路で zombie 重複が増える可能性)。一括導入で defense-in-depth を確実にする

---

## Related (関連情報)

### 詳細設計
- [docs/specification/SCREENS.md §11.4 WBS タスク管理画面](../specification/SCREENS.md) — 仕様・エラー分類・UI 操作
- [docs/design/API_DESIGN.md](../design/API_DESIGN.md) — endpoint 一覧 + エラー code
- [docs/design/DATA_MODEL.md §5.5 tasks](../design/DATA_MODEL.md) — 部分 UNIQUE インデックス定義

### 関連 KDD
- KDD §5.X+91: 階層エンティティの重複判定 (parent + name スコープ)
- KDD §5.X+92: PgBouncer 制約環境の bulk INSERT 後集計再計算パターン
- KDD §5.X+93: OCC (Optimistic Concurrency Control) パターン
- KDD §5.X+94: localStorage 履歴の読込時検証
- KDD §5.X+95: DB UNIQUE 制約追加時の app 層全経路 defense

### 関連 ADR
- [ADR-0016](./0016-multi-tenant-user-membership.md): multi-tenant + 組織 ID 入力導線の前提
- [ADR-0011](./0011-soft-delete-and-audit-log.md): 監査ログの BULK_DUPLICATE 追加

### 過去の PR
- #420 feat/wbs-import-uplift (本 ADR の対象 PR, 9 commits)

### 本番事前確認
- `scripts/check-task-name-duplicates.ts` — migration 前に重複検出
- 確認クエリ (psql):
  ```sql
  SELECT COUNT(*) FROM (
    SELECT project_id, parent_task_id, name FROM tasks
    WHERE deleted_at IS NULL
    GROUP BY 1, 2, 3 HAVING COUNT(*) > 1
  ) d;
  ```
  期待値 = 0
