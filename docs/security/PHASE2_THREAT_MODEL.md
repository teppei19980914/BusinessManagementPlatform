# Phase 2 機能の脅威モデル (STRIDE)

- 起票日: 2026-05-08
- 対象機能: P-D テナントデータ一括インポート (PR #270) / Phase 1 外部システムからの初回データ移行 (PR #273) / Storage add-on プラン (PR #274)
- 関連: [V1_FINAL_TASKS.md](../roadmap/V1_FINAL_TASKS.md) / [SUGGESTION_ENGINE_THREAT_MODEL.md](./SUGGESTION_ENGINE_THREAT_MODEL.md) (先行モデル)

---

## はじめに

本ドキュメントは V1 リリース後 Phase 2 で追加された **untrusted データの取込系機能 + 容量課金系機能** に対する STRIDE 脅威モデル分析の結果を記録する。これらの機能は以下の理由で従来機能より脅威面が広い:

1. **P-D / Phase 1 import**: ユーザがアップロードする ZIP / CSV を server 側で解凍 + パース + DB INSERT する経路で、ZIP bomb / CSV injection / 大量レコード投入による DoS リスクがある
2. **Storage add-on**: ユーザの容量消費が課金額に直結するため、容量計算ロジックの操作 (Tampering) や Grace period の悪用 (Elevation of Privilege) リスクがある
3. **embedding 生成 (Phase 1)**: 1 ファイルアップロードで N 回の Voyage 呼出が発生するため、コスト爆発攻撃の可能性がある (本 PR で対策済の事前見積機構を再確認)

本分析は STRIDE フレームワーク (Spoofing / Tampering / Repudiation / Information Disclosure / Denial of Service / Elevation of Privilege) に従って体系化し、各脅威について影響度・発生確率・既存対策・追加対策の有無を明記する。

---

## 攻撃面の全体像

Phase 2 で追加された攻撃面は 3 つの新規境界に分解される。

**第 1 境界: Untrusted ZIP/CSV ファイルアップロード経路**
- 入口: `POST /api/tenants/me/import` (P-D ZIP), `POST /api/tenants/me/external-import/preview` + `apply` (Phase 1 CSV)
- 出口: Postgres INSERT (15 業務エンティティ全テーブル)
- リスク: ZIP bomb / CSV injection / FK 改ざん / 大量レコード投入 DoS / 既存ユーザ偽装 / polymorphic entityId による cross-tenant 干渉

**第 2 境界: Storage 課金経路**
- 入口: `PATCH /api/tenants/me/storage-addon` (プラン変更), 日次 cron (`updateAllStorageBytesUsed`)
- 出口: `Tenant.storageAddonPlan` / `tenant_monthly_usage_history.storageAddonJpy`
- リスク: 容量計算の数値操作 (= 課金回避) / Grace period 開始日時の改ざん / プラン変更 API の不正実行

**第 3 境界: Voyage embedding 大量生成経路 (Phase 1 apply 段階)**
- 入口: `POST /api/tenants/me/external-import/apply` (確定後の Voyage 呼出)
- 出口: Voyage AI API (1 ファイル × 5,000 行 × ¥10-30/call)
- リスク: ファイル巨大化 / Beginner 上限回避 / 予算上限回避によるコスト爆発

---

## STRIDE 分析

### S: Spoofing (なりすまし)

#### S-1. 別管理者の preview を盗用して apply 実行 (Phase 1)

- **攻撃者**: 同テナント内の別管理者 / 認証済のテナント外攻撃者
- **シナリオ**: preview API が返す `previewId` を取得して別ユーザが apply API を呼び出し、本来本人しか実行できない取込操作を肩代わり
- **影響度**: 中 (= テナント内の権限濫用、外部漏洩には繋がらない)
- **発生確率**: 低 (= 同テナントの別管理者は元々 admin role を持っているので意味が薄い)
- **既存対策**:
  - `external-data-import.service.ts:applyImport` で `preview.createdByUserId !== input.userId` を判定し `PREVIEW_NOT_OWNED` で 410 を返す
  - `preview.tenantId !== input.tenantId` チェックも併用 (= テナント外からの previewId 盗用を `PREVIEW_NOT_FOUND` 404 で偽装)
- **追加対策**: 不要 (二重防御済)

#### S-2. P-D ZIP の users.json で systemRole=admin 偽装

- **攻撃者**: テナント管理者 (= P-D の使用権限を持つ正規ユーザ) が他テナントから盗んだ ZIP を取込時に systemRole を改ざん
- **シナリオ**: ZIP 内 `users.json` の `systemRole` フィールドを `admin` に書き換えて取込み、本来 general user として作成すべきユーザを admin で作成
- **影響度**: 高 (= 本人しか admin になれない原則を破る)
- **発生確率**: 中 (= ZIP 直接編集は容易)
- **既存対策**: `data-import.service.ts:runImport` の users 取込ロジックを再確認 → 現状は `systemRole: typeof u.systemRole === 'string' ? u.systemRole : 'general'` で **改ざんを許容している**
- **追加対策が必要**: ⚠ **下記「追加対策推奨」セクション S-2 参照**

---

### T: Tampering (改ざん)

#### T-1. ZIP 内の tenantId / FK 改ざん (P-D)

- **攻撃者**: テナント管理者
- **シナリオ**: ZIP 内 JSON の `tenantId` を別テナント ID に書き換えて、別テナントへ業務データを混入
- **影響度**: 高 (テナント境界違反)
- **発生確率**: 中
- **既存対策**: `data-import.service.ts` で **tenantId は ZIP 内の値を一切信用せず、認証ユーザの `user.tenantId` で常に上書き**。FK は UUID マップで再採番、自テナント内に存在しない FK 参照は dangling として skip
- **追加対策**: 不要 (設計が安全)

#### T-2. CSV 内 type=admin 改ざんで既存メンバーの role を昇格

- **攻撃者**: テナント管理者
- **シナリオ**: 外部 import で users.csv を取り込めると role 昇格できるが、Phase 1 は **users を import 対象外** (= 招待フローのみ) のため、この経路は塞がれている
- **影響度**: 高
- **発生確率**: ゼロ (= 攻撃面なし)
- **既存対策**: `external-data-import.service.ts` の対象エンティティを Knowledge / RiskIssue のみに限定
- **追加対策**: 不要

#### T-3. Storage 使用量計算の SQL 改ざん経路

- **攻撃者**: SQL injection が成立した場合 (= 本来は無いはず)
- **シナリオ**: `calculateTenantStorageBytes` の `$queryRaw` テンプレート内に SQL injection を許す経路があれば集計結果を 0 に偽装して上限超過を回避
- **影響度**: 高 (課金回避)
- **発生確率**: 低 (= Prisma の `$queryRaw` タグ付きテンプレート使用)
- **既存対策**: `calculateTenantStorageBytes` は `${tenantId}::uuid` のテンプレートリテラル interpolation のみで、Prisma が prepared statement にパラメータ化する。SQL injection 経路なし
- **追加対策**: 不要 (型安全な実装)

#### T-4. JWT claim `tenantStorageGracePeriodStartedAt` の改ざん

- **攻撃者**: 攻撃者がローカルで JWT を改ざんして再送
- **シナリオ**: claim の Grace 開始日時を未来日に書き換えて 7 日経過判定を回避
- **影響度**: 高 (= write 停止を回避)
- **発生確率**: 低 (= JWT は HMAC で署名されており改ざんは検知される)
- **既存対策**: NextAuth が JWT に署名 (`AUTH_SECRET`)、改ざんされた JWT は復号失敗で 401
- **追加対策**: 不要

---

### R: Repudiation (否認)

#### R-1. インポート操作の監査ログ欠落

- **攻撃者**: 悪意ある管理者が「自分は import していない」と主張
- **シナリオ**: 大量データ投入後、操作証跡を否認
- **影響度**: 中 (= 内部統制要件)
- **発生確率**: 低
- **既存対策**:
  - P-D: `/api/tenants/me/import/route.ts` で `recordAuditLog({ action: 'CREATE', entityType: 'tenant_data_import' })` を必ず記録
  - Phase 1: `/api/tenants/me/external-import/apply/route.ts` で同様に `entityType: 'tenant_external_import'` で記録
- **追加対策**: 不要

#### R-2. Storage プラン変更の監査ログ欠落

- **攻撃者**: 管理者が「Plus にアップグレードしていない」と主張 (課金否認)
- **シナリオ**: 月末に Plus → Standard に戻し、当月 Plus 課金を否認
- **影響度**: 中
- **発生確率**: 低
- **既存対策**: `Tenant.storageAddonPlan` の値変更は Prisma の updatedAt で痕跡が残るが、明示的な監査ログは未取得
- **追加対策が必要**: ⚠ **下記「追加対策推奨」セクション R-2 参照**

---

### I: Information Disclosure (情報漏洩)

#### I-1. 別テナントの previewId を盗聴して内容閲覧 (Phase 1)

- **攻撃者**: テナント外の認証済ユーザ
- **シナリオ**: 別テナントの previewId を推測して GET 系 API で内容を閲覧 (が、現状 GET API は無い)
- **影響度**: 高
- **発生確率**: 低 (= UUID v4 で推測困難)
- **既存対策**:
  - apply API で `tenantId` 一致を検証
  - GET API は提供していない (= preview 結果は client が直接保持、サーバ側からは fetch 不可)
- **追加対策**: 不要

#### I-2. 別テナントの Storage 使用量・課金額の閲覧

- **攻撃者**: テナント外ユーザ
- **シナリオ**: `/api/tenants/me/storage-addon` GET で別テナントの情報取得を試みる
- **影響度**: 中 (= 競合情報)
- **発生確率**: 低
- **既存対策**: API は `user.tenantId` のみを使用、URL パスにテナント ID を含めないので越境不可
- **追加対策**: 不要

#### I-3. ZIP / CSV エラーレポートに本文の機密情報が漏れる

- **攻撃者**: テナント外ユーザ (preview API へのアクセス権限を獲得した場合)
- **シナリオ**: バリデーションエラーで失敗した行の `content` フィールドの値がエラーメッセージに含まれていれば、原本の機密情報が leak
- **影響度**: 中
- **発生確率**: 低
- **既存対策**: `previewImport` のエラー出力 (`PreviewError`) は **行番号 + フィールド名 + 理由** のみで、原本の値は含めない (= 例: `title is empty` であって `title is empty: 受信値=実値` ではない)
- **追加対策**: 不要 (= 設計が安全)

---

### D: Denial of Service (サービス停止)

#### D-1. ZIP bomb 攻撃 (P-D)

- **攻撃者**: テナント管理者
- **シナリオ**: 高圧縮率の ZIP (例: 10MB → 解凍 10GB) をアップロードしてサーバメモリ / DB 容量を枯渇
- **影響度**: 高
- **発生確率**: 低 (= テナント管理者になれる時点で課金顧客、悪意ある管理者は稀)
- **既存対策**:
  - `/api/tenants/me/import` で **50MB** ZIP サイズ上限
  - JSZip は memory-bounded ストリーミング解凍で破滅的 OOM は起きにくい
- **追加対策推奨**: ⚠ **下記 D-1 参照** (= 解凍後サイズの絶対上限を追加)

#### D-2. 巨大 CSV / Excel アップロード (Phase 1)

- **攻撃者**: テナント管理者
- **シナリオ**: 50MB の CSV (= 数百万行) を用意してパース + DB INSERT で DoS
- **影響度**: 中
- **発生確率**: 低
- **既存対策**:
  - `previewImport` で **50MB** ファイルサイズ上限
  - **5,000 行** 上限 (TOO_MANY_ROWS) で大量レコード INSERT を防止
- **追加対策**: 不要 (= 上限が二重に効く)

#### D-3. 二重インポートで DB 圧迫 (P-D)

- **攻撃者**: テナント管理者
- **シナリオ**: 同じ ZIP を並列に複数回 POST して N 倍のレコードを同時投入
- **影響度**: 中
- **発生確率**: 低
- **既存対策**: `Tenant.importInProgressAt` の **in-flight ロック** (30 分超は自動失効) で同時実行を排除
- **追加対策**: 不要

#### D-4. Voyage 大量呼出によるコスト爆発 (Phase 1 apply)

- **攻撃者**: テナント管理者
- **シナリオ**: 5,000 行の CSV を Pro プラン (¥30/call) で apply → ¥150,000 のコスト発生 + Voyage rate limit 到達
- **影響度**: 高 (= 攻撃者は自分のテナントの予算上限を引き上げる必要があるが、可能)
- **発生確率**: 低
- **既存対策**:
  - Beginner プランは月 100 回上限で **強制拒否** (BEGINNER_CALL_LIMIT_EXCEEDED)
  - Expert/Pro は月次予算上限超過で拒否 (BUDGET_CAP_EXCEEDED)
  - 5,000 行上限で 1 回あたり ¥150K に絞られる
- **追加対策**: 不要 (経済的セーフティネット完備)

#### D-5. Storage 容量集計 cron の実行時間長期化

- **攻撃者**: 大量データを溜めて cron の実行時間を引き延ばす
- **シナリオ**: 全テナントの `pg_column_size` 集計が cron 実行制限 (Vercel 60 秒) を超過 → cron 失敗で容量更新が止まる
- **影響度**: 低 (= 容量更新が止まるだけで、システムは動く)
- **発生確率**: 低
- **既存対策**: テナント単位で try/catch、1 件失敗が他に伝播しない
- **追加対策**: 監視のため、cron で `recordError` の閾値超過を super_admin に通知する仕組みを将来検討

---

### E: Elevation of Privilege (権限昇格)

#### E-1. 一般ユーザが import API を直接叩く

- **攻撃者**: テナント内の general role ユーザ
- **シナリオ**: API を直接 POST して admin 限定操作を実行
- **影響度**: 高
- **発生確率**: 低
- **既存対策**: `requireAdmin(user)` で 403 を返す (P-D / Phase 1 / Storage add-on の全 API で適用)
- **追加対策**: 不要

#### E-2. Beginner 期限切れ後の Storage 課金回避

- **攻撃者**: Beginner 期限切れテナント
- **シナリオ**: Beginner 90 日経過で write 停止後、Storage プランを Plus にアップグレードして容量増を狙う (が、middleware で write 停止されている)
- **影響度**: 低 (= write が止まっているのでアップグレード API も呼べない)
- **発生確率**: ゼロ
- **既存対策**: middleware が PATCH メソッドを `BEGINNER_EXPIRED_READ_ONLY` で 403
- **追加対策**: 不要

#### E-3. Storage Grace 7 日後の write 停止回避

- **攻撃者**: Storage 上限超過テナント
- **シナリオ**: cron が `storageGracePeriodStartedAt` を NOW() にセットした後、ユーザが何もせず 7 日経過 → middleware で write 停止。これを回避するため JWT を再発行しないまま使い続けて claim の値が古いまま (= 開始日時が記録されていない)
- **影響度**: 高
- **発生確率**: 中 (= ユーザが意図的にログアウトしないなら起こり得る)
- **既存対策**:
  - cron で Grace 開始セット → 通知メール送信 (`storageOverLimitNoticeSentAt`) で開始事実をユーザに伝える
  - 既存セッションは古い claim を保持するが、JWT の expiry は 30 日 (NextAuth default) なので 30 日以内には再発行
  - **しかし**: 30 日以内 + Grace 7 日経過のタイミングでは write が一時的に通る可能性あり
- **追加対策推奨**: ⚠ **下記 E-3 参照** (= サーバ側で Tenant 直引きの fallback)

---

## 追加対策推奨 (本 PR は分析のみ、実装は別 PR)

### S-2: P-D ZIP の users.systemRole の sanitize

**現状**: `data-import.service.ts:runImport` の users 取込で `systemRole` を ZIP の値そのまま使用。

**推奨**: `systemRole` を **常に `'general'` で固定** (= ZIP の値を無視) し、import 後に admin 必要なユーザは別途招待フロー経由で昇格させる運用に変更。

**実装規模**: 1 行修正 (`systemRole: 'general'` 固定)

### R-2: Storage プラン変更の監査ログ追加

**現状**: `updateStorageAddonPlan` で `Tenant.storageAddonPlan` を直接 update、監査ログ未取得。

**推奨**: `recordAuditLog({ action: 'UPDATE', entityType: 'tenant_storage_plan', beforeValue, afterValue })` を追加。

**実装規模**: tenant-storage.service.ts の `updateStorageAddonPlan` 末尾で 1 関数呼出追加。

### D-1: ZIP 解凍後の絶対サイズ上限

**現状**: 50MB ZIP 上限のみ、解凍後サイズは未制限 (実質 JSZip がメモリ確保するので OOM リスクは低いが)。

**推奨**: `zip.generateAsync({ type: 'uint8array' })` 経由で解凍し、合計サイズ > 200MB なら拒否する step を追加。

**実装規模**: data-import.service.ts の解凍部分で 5 行程度。

### E-3: middleware の Storage Grace 7 日判定に server-side fallback

**現状**: middleware は JWT claim だけで判定、claim 更新は次回ログイン時。

**推奨**: write methods 時に **追加で軽量 SELECT** を発行し、Tenant.storageGracePeriodStartedAt の最新値を取得して判定。Edge runtime 制約は残るが Prisma Edge ドライバを使えば可能。

**実装規模**: 中 (= Edge runtime + Prisma Accelerate 統合が必要)、優先度低 (= 攻撃成立窓が 30 日 + 7 日と長くないため)

---

## まとめ

Phase 2 の 3 機能 (P-D / Phase 1 / Storage add-on) は基本的に **既存の認可境界 + 経済的セーフティネット (Beginner 上限 / 予算上限) + ファイルサイズ上限 + 行数上限 + in-flight ロック + UUID 再採番 + tenantId 強制上書き** の組合せで主要な脅威に対応済。

ただし以下 4 件は追加対策を推奨する:

| ID | 内容 | 優先度 |
|---|---|---|
| S-2 | P-D import で users.systemRole を `'general'` に固定 | 高 |
| R-2 | Storage プラン変更の監査ログ追加 | 中 |
| D-1 | ZIP 解凍後の絶対サイズ上限 (200MB) | 中 |
| E-3 | middleware の Storage Grace 判定に server-side fallback | 低 |

S-2 / R-2 / D-1 は別 PR で対応推奨 (= 各 1〜数行の小規模修正)。E-3 は実装複雑度に対して攻撃成立窓が狭いため、当面は claim ベースで運用継続。

## 関連

- [SUGGESTION_ENGINE_THREAT_MODEL.md](./SUGGESTION_ENGINE_THREAT_MODEL.md): 提案エンジンの STRIDE 分析 (先行)
- [SECURITY-TASKS.md](./SECURITY-TASKS.md): security-check.ts の自動スキャン結果 (静的解析)
- [V1_FINAL_TASKS.md](../roadmap/V1_FINAL_TASKS.md): P-D / Phase 1 / Storage add-on の機能仕様
