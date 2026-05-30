# Beginner プラン仕様 (90 日完全無料試用)

> **本書は Beginner プランの「単一の真実源」**。容量上限、ガード挙動、DELETE フロー、アップグレード誘導、90 日試用との関係を集約する。
>
> 関連:
> - [ADR-0019](../adr/0019-billable-feature-units-and-free-tier-expansion.md) — 課金対象 featureUnit を限定し Beginner 50 件月次上限を導入
> - [ADR-0022](../adr/0022-embedding-usage-based-billing.md) — Embedding 機能を従量課金化 (Beginner は ¥0 維持)
> - [ADR-0025](../adr/0025-beginner-write-guard.md) — Beginner DB/Storage 無料枠超過時 write ブロック (本書の容量挙動の根拠)
> - [docs/business/TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md) — プラン全体の料金体系
> - [docs/public/about.md](../public/about.md) — ユーザ向け公開ドキュメント

---

## 1. プラン位置付け

| 観点 | 内容 |
|---|---|
| **目的** | 新規ユーザの 90 日完全無料試用 |
| **訴求** | 「カード登録不要・課金一切なし」で本サービスの提案エンジン / ナレッジ蓄積を体験 |
| **想定利用者** | 1 〜 5 名のプロジェクト管理試用、PoC、個人利用 |
| **完了後の動線** | 90 日後 (または容量超過時) に Expert / Pro プランへアップグレード誘導 |
| **デフォルト** | サインアップ時の全テナントは Beginner プラン |

---

## 2. 料金 (一切無料)

| 課金種別 | Beginner プラン | 根拠 ADR |
|---|---|---|
| LLM 呼出 (project-upsert / suggestion-explanation / auto-tag-extract) | **無料**、月 50 件上限 | ADR-0019 |
| Embedding (knowledge / chat-semantic-search / 等 7 種) | **無料**、**月 100 件試用上限** (ADR-0030)、Fair Use Limit 月 10,000 件は safety net で残置 | ADR-0022 / ADR-0030 |
| DB 容量 (50MB 無料枠) | **無料**、超過時 write ブロック (overage 課金なし) | ADR-0020 §11 / ADR-0025 |
| File Storage 容量 (100MB 無料枠) | **無料**、超過時 write ブロック (overage 課金なし) | ADR-0021 / ADR-0025 |
| 「なぜ?」AI 説明 (suggestion-explanation) | 利用不可 (Pro プラン限定機能) | ADR-0019 |

**根本原則**: Beginner プランでは、ユーザが明示的にアップグレードしない限り **一切の課金が発生しない**。これは LP / 公開ドキュメントの「90 日完全無料」訴求との整合性を構造的に保証するためである。

### Embedding 月 100 件試用上限 (ADR-0030 / 2026-05-30)

- 定数: `BEGINNER_EMBEDDING_MONTHLY_LIMIT = 100` (src/config/embedding-pricing.ts)
- 対象: EMBEDDING_BILLABLE_FEATURE_UNITS 全 7 種 (knowledge / risk-issue / retrospective / memo-embedding + chat-semantic-search + external-import-embedding + attachment-embedding)
- カウント: ApiCallLog SUM (= Tenant.currentMonthEmbeddingCallCount 真値) ベース、CSV 100 件取込でも 1 件として集約 (ADR-0022 §2.1 集約設計)
- 到達時挙動: `withMeteredLLM` が `reason='embedding_beginner_limit_exceeded'` 縮退モード返却。新規 embedding 生成のみ停止、既存 embedding を使ったチャット意味検索・提案エンジンは継続利用可能、失敗分は月初 backfill cron で次月補填 (ADR-0026 非同期化 + ADR-0022 backfill との整合)
- 復活経路: 月初リセット (テナント TZ で 1 日 00:00) または Expert/Pro へのアップグレード (¥5/回、ADR-0029)
- Fair Use Limit (10,000 件) との関係: 100 件 < 10,000 件で Beginner cap が先に発火するため Fair Use Limit は通常運用では到達しない。コードバグへの safety net として残置

---

## 3. 容量上限と超過時の挙動 (ADR-0025)

### 3.1 上限

| 種別 | 無料枠 | 上限値 | 計測カラム |
|---|---|---|---|
| DB 容量 | 50MB (50,000,000 bytes) | `BEGINNER_DB_FREE_TIER_BYTES` | `tenant.storageBytesUsed` |
| File Storage 容量 | 100MB (100,000,000 bytes) | `BEGINNER_STORAGE_FREE_TIER_BYTES` | `tenant.storageFileBytesUsed` |

### 3.2 計測タイミング

cron で日次集計したキャッシュ値を使用 (最大 24h ズレ許容)。DELETE 後はキャッシュが古くなる UX 問題があるため、§3.5 の自動再集計で緩和する。

### 3.3 操作別の挙動

| 操作 | 容量未超過 | 容量超過 (50MB / 100MB 超) |
|---|---|---|
| **INSERT (新規作成)** | 許可 | **拒否** (HTTP 403 + UX エラー) |
| **UPDATE (既存更新)** | 許可 | **拒否** (HTTP 403 + UX エラー) |
| **DELETE (削除)** | 許可 | **許可** (容量を減らす方向のため許可) |
| **READ (閲覧)** | 許可 | 許可 |
| **CSV インポート** | プレビュー OK | プレビューでブロック表示、apply で 403 (ADR-0020 §11) |
| **アタッチメント アップロード** | 許可 | **拒否** (HTTP 403 + UX エラー) |
| **アタッチメント 削除** | 許可 | **許可** |

### 3.4 ガード対象エンティティ

DB 容量と File Storage 容量の両方を消費する全エンティティ:
- **DB**: Project, Knowledge, RiskIssue, Retrospective, Memo, Task, Customer, Stakeholder, Comment, Mention, Notification, Attachment (DB row 部分)
- **File Storage**: Attachment (Supabase Storage バイト数部分)

実装は [src/services/storage-guard.service.ts](../../src/services/storage-guard.service.ts) の 4 関数 (`precheckStorageLimit` / `assertStorageLimitInTx` / `precheckFileStorageLimit` / `assertFileStorageLimitInTx`) に Beginner 判定を統合。各 write route ごとにエラーマッパー (`mapBeginnerWriteGuardErrorToResponse` または `code === 'BEGINNER_*_QUOTA_EXCEEDED'` 分岐) で UX 文言を統一して返す。

**現在の Beginner エラー UX 文言が正しく返る経路**:
- 単発 POST/PUT/PATCH 32 route (`requireStorageQuotaForWrite` 経由) — [src/lib/api-helpers.ts](../../src/lib/api-helpers.ts) で集約対応
- sync-import 5 route (knowledge / risks / retrospectives / memos / tasks)
- attachment finalize / upload
- ZIP import (`/api/tenants/me/import`)

### 3.5 DELETE 後の自動再集計 (debounce 30s)

cron キャッシュ値ベース判定の弱点 (ユーザが DELETE で容量を減らしても次の cron まで write ブロックが解除されない) を解消するため:

1. Beginner プランのテナントで対象エンティティの DELETE が成功
2. → `recalculateTenantStorageUsageWithDebounce()` を post-commit hook で自動呼び出し
3. → `tenant.storageBytesUsed` / `storageFileBytesUsed` が即時更新される
4. → ユーザは次の write 操作から再び書き込み可能

**debounce 30s**: 連続 DELETE 時の負荷防止のため、直近 30 秒以内に再集計済なら skip。手動 `[再集計]` ボタン (容量セクション UI) で強制実行可能。

**fail-safe**: 再集計失敗は DELETE のビジネストランザクションをロールバックさせない。失敗時は `recordError` で warn ログを残し可観測性を確保 (= 監視ダッシュボードから検知可能)。

**現在の自動再集計対象 DELETE 経路** (主要 6 service):
- knowledge.service.ts (`deleteKnowledge`)
- project.service.ts (`deleteProject` + `deleteProjectCascade`)
- risk.service.ts (`deleteRisk`)
- retrospective.service.ts (`deleteRetrospective`)
- memo.service.ts (`deleteMemo`)
- attachment.service.ts (`deleteAttachment`)

**対象外 DELETE 経路**: customer / stakeholder / comment / mention / notification / task / estimate の DELETE は自動再集計対象外 (= 容量寄与が小さいため省略)。これらの削除後に容量解放を即時反映したい場合は、テナント設定画面の `[DB 容量 / API 利用量を再集計]` ボタンを手動で押すことで強制再集計可能。

---

## 4. 超過時のユーザ体験 (UX)

### 4.1 エラーメッセージ (3 経路統一)

| 経路 | 文言 |
|---|---|
| トースト | 「Beginner プランの無料枠 (DB 50MB / Storage 100MB) を超えました。不要なデータを削除する、または Expert プランへアップグレードしてください」 |
| API エラー (HTTP 403) | 同上 + `code: BEGINNER_DB_QUOTA_EXCEEDED` (or `STORAGE_`) + `upgradeUrl: /settings/tenant` |
| フォームエラー | 同上 + `[アップグレード →]` ボタン (右側) |

### 4.2 容量セクション UI (テナント設定画面)

Beginner プランのユーザは `/settings/tenant?tab=usage` で:

- **DB 容量ゲージ**: 50MB を満タンとした視覚化、80% (40MB) 超で黄色警告バナー
- **File Storage 容量ゲージ**: 100MB を満タンとした視覚化、80% (80MB) 超で黄色警告バナー
- **超過時バナー**: 「新規作成/更新ブロック中: 不要データを削除すると自動的に再集計されます。反映されない場合は [再集計] ボタンをご利用ください」
- **[再集計] ボタン**: バナー近傍に配置 (既存 RecalculateButton コンポーネントを再利用)

Expert / Pro プランのユーザには従来通りの 50GB ゲージ + 従量課金見積もりを表示 (変更なし)。

### 4.3 アップグレード動線

- エラー文言の `[アップグレード →]` ボタン → `/settings/tenant?tab=overview` (プラン変更フォーム)
- プラン変更で Expert (¥10/call) または Pro (¥15/call) を選択 → 即時反映
- アップグレード後は 50GB ハードキャップまで write 可能、超過分は ¥50/GB tier (DB) / ¥10/GB tier (File Storage) で従量課金

---

## 5. 90 日試用期間との関係

| 経過日数 | 状態 | 挙動 |
|---|---|---|
| 0 〜 60 日 | `beginnerExpiryState: 'active'` | 通常運用、容量超過時のみ write ブロック |
| 61 〜 74 日 | `beginnerExpiryState: 'warning_60'` | 黄色バナー「Beginner プランは残り N 日です」 |
| 75 〜 89 日 | `beginnerExpiryState: 'warning_75'` | オレンジバナー「あと N 日で Beginner プランが終了します」 |
| 90 日以降 | `beginnerExpiryState: 'expired'` | **全 write 操作拒否** (容量未満でも write 不可)、READ のみ可、Expert/Pro へアップグレードで復活 |

90 日期限と容量超過は独立したガードで、いずれかが先に到達した時点で write ブロックがかかる。期限到達後は容量に関係なく write 不可となる。

---

## 6. 課金システムとの関係

Beginner プランのテナントは、以下の課金経路すべてで **¥0** が保証される:

### 6.1 ApiCallLog 記録

| featureUnit | Beginner での記録 |
|---|---|
| project-upsert / suggestion-explanation / auto-tag-extract (LLM) | `costJpy=0` で記録、月 50 件上限カウントに使用 |
| knowledge-embedding / chat-semantic-search / 等 (Embedding 7 種) | `costJpy=0` で記録、Fair Use Limit カウントに使用 |
| db-capacity-overage (ADR-0020) | **記録されない** (ADR-0025 で月初 cron が Beginner を skip) |
| storage-file-overage (ADR-0021) | **記録されない** (同上) |
| project-embedding-backfill 等 (Embedding backfill) | `costJpy=0` で記録 (ADR-0022) |

### 6.2 Stripe queue

Beginner プランのテナントに対する Stripe Usage Record は **一切投入されない**。これにより:
- Stripe 請求書に Beginner テナントの行が現れない
- Stripe Customer 自体が作成されない (= カード登録不要訴求の保証)

### 6.3 請求 CSV

`/api/admin/super/usage/export` の出力 CSV では、Beginner テナントの行は以下のすべてで ¥0 が表示される:
- API 課金額 (ApiCallLog SUM)
- DB 容量超過額
- File Storage 超過額
- 合計請求額

---

## 7. 制約・既知の制限

- **席数上限**: 5 席まで (`beginnerMaxSeats=5`)
- **「なぜ?」AI 説明機能**: 利用不可 (Pro 限定)
- **Beginner → Expert/Pro のダウングレード**: 禁止 (ADR-0013、`BEGINNER_DOWNGRADE_FORBIDDEN`)
- **データエクスポート**: 容量超過状態でも実行可能 (READ 操作のため)
- **テナント解約**: 容量超過状態でも実行可能 (削除のため)

---

## 8. 設計判断の理由

### なぜ Beginner で overage 課金しないのか?

ADR-0019 / ADR-0022 で「Beginner = 90 日完全無料」を訴求している以上、ユーザが明示的にアップグレードしない状態で課金が発生することは「不当請求」と感じられる。これは Embedding backfill (ADR-0022) で確立した「ユーザ非起動の処理での課金は信頼関係に直接影響する」原則を、容量超過にも拡張したもの。

### なぜ DELETE は許可するのか?

容量を減らす方向の操作を妨げる必要がない。むしろ「DELETE で容量を減らせば write 再開できる」道筋を残すことで、ユーザに「強制アップグレードか離脱の二択」を強いない設計とする。

### なぜキャッシュ値ベースなのか?

リアルタイム計測 (`pg_total_relation_size()` 等) はホットパスで重い query。Beginner = 個人試用想定で 24h ズレ許容可能。DELETE 後の自動再集計で UX ギャップは埋まる。

詳細は [ADR-0025](../adr/0025-beginner-write-guard.md) を参照。
