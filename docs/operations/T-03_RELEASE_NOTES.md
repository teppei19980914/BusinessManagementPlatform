# T-03 提案エンジン v2 リリースノート (2026-06-01)

本ドキュメントは、T-03 提案エンジン v2 のリリース内容、運用上の留意点、緊急停止手順を集約する。**運用者必読**。

関連: [SUGGESTION_ENGINE_PLAN.md](../roadmap/SUGGESTION_ENGINE_PLAN.md) / [SUGGESTION_FEATURE.md](../specification/SUGGESTION_FEATURE.md) / [SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md)

---

## リリース範囲 (T-03 / 6/1 リリース時点)

| 機能 | 状態 |
|---|---|
| **マルチテナント基盤** (PR #2-a 〜 PR #2-d) | ✅ |
| **Phase 1: LLM による自動タグ抽出** (Anthropic Haiku/Sonnet、Project 作成時) | ✅ |
| **Phase 2: pgvector + Voyage embedding による意味検索** | ✅ |
| **3 軸スコアリング** (タグ 0.3 + pg_trgm 0.2 + embedding 0.5) | ✅ |
| **5 層悪用防止** (シークレット保護 / 認証強化 / rate limit / プロンプトインジェクション対策 / workspace 上限) | ✅ |
| **初期シードデータ** (default-tenant に 30 件のナレッジ、PR #6) | ✅ |
| **テナント別シーディング機構** `seedTenant(tenantId)` (PR #6) | ✅ |
| **日次使用量集計 + 異常検知 + 予算アラート** (PR #7) | ✅ |
| **admin 用使用量サマリ JSON** `GET /api/admin/usage-summary` (PR #7) | ✅ |
| **緊急停止フラグ** `SUGGESTION_ENGINE_DISABLED` (PR #8) | ✅ |
| Phase 3: LLM Re-ranking + 説明文付与 | ❌ **未実装 (リリース後 v1.x)** |
| super_admin ダッシュボード UI | ❌ **未実装 (PR-X2、リリース後)** |

---

## ユーザ向け新機能の挙動

### 1. プロジェクト作成時の自動タグ抽出

新規プロジェクト作成画面で `purpose` / `background` / `scope` を入力すると、Anthropic API が自動でタグを抽出する:

- **Beginner / Expert プラン** : Claude **Haiku** で抽出
- **Pro プラン** : Claude **Sonnet** で抽出 (タグ精度がやや向上)

抽出されたタグは `businessDomainTags` / `techStackTags` / `processTags` として Project 行に保存される。ユーザは保存後に手動編集可。

### 2. プロジェクト作成直後の提案モーダル

Project 作成成功時に自動で `/projects/[id]?suggestions=1` に遷移し、`SuggestionsPanel` をモーダル表示。**過去の同種ナレッジ・課題・振り返り**が候補として並ぶ。

### 3. 「参考」タブで常時アクセス可

プロジェクト詳細画面の「参考」タブから、いつでも提案候補を再表示可能。

### 4. リスク/課題起票時の inline 軽量サジェスト

リスク/課題起票ダイアログで text 入力中 (10 文字以上) に、500ms debounce で「類似する過去課題」を最大 5 件提示。LLM は呼ばず pg_trgm のみで動作 (連続入力でのコスト爆発を回避)。

---

## 運用上の留意点

### 起動前チェックリスト

| # | 項目 | 確認方法 |
|---|---|---|
| 1 | Vercel 環境変数 `ANTHROPIC_API_KEY` 設定済 | Vercel Dashboard → Settings → Environment Variables |
| 2 | Vercel 環境変数 `VOYAGE_API_KEY` 設定済 | 同上 |
| 3 | Vercel 環境変数 `DIRECT_URL` (Session Pooler、port 5432) 設定済 | 同上 (PR #234 で対応済の場合スキップ) |
| 4 | Supabase で `vector` 拡張が有効 | Dashboard → Database → Extensions |
| 5 | Anthropic Console で workspace 月次ハード上限 ($100 推奨) 設定 | https://console.anthropic.com/ |
| 6 | Voyage Budget Alert ($5-10) 設定 | https://dashboard.voyageai.com/budget-limits |
| 7 | default-tenant に初期シードナレッジ投入完了 | `pnpm db:seed:suggestion` を本番環境で実行、Supabase で `SELECT COUNT(*) FROM knowledges WHERE tenant_id='00000000-0000-0000-0000-000000000001' AND visibility='public';` で **30** を確認 |

### 月次運用タスク

| 頻度 | 項目 | 確認/操作 |
|---|---|---|
| 毎日 | Vercel Logs で `daily-usage-aggregation` cron の正常完了確認 | エラーログがないこと |
| 毎日 | admin にメールアラートが届いていないか確認 | 異常検知 / 予算アラート発火時のみ届く |
| 月初 | Anthropic Console / Voyage Dashboard で先月の使用量確認 | 想定外の費用発生がないこと |
| 月初 | テナント別の使用量を `GET /api/admin/usage-summary` で確認 | 各テナントへの請求書発行の根拠データ |
| 任意 | `SELECT * FROM api_call_logs ORDER BY created_at DESC LIMIT 100;` で最新の API 呼び出しを確認 | 異常な feature_unit や cost_jpy がないこと |

### コスト想定 (6/1 リリース直後)

[SUGGESTION_FEATURE.md §6.1](../specification/SUGGESTION_FEATURE.md) より:

| サービス | 月次推定 |
|---|---|
| Anthropic Haiku (タグ抽出 ×100 回) | 約 ¥80 |
| Voyage (embedding 生成 ×1,000 回) | ¥0 (無料枠 200M の 0.75%) |
| Supabase Free | ¥0 (DB 数十 MB) |
| Vercel Hobby | ¥0 |
| **合計** | **月 ¥80 程度** |

---

## 緊急停止手順 (障害発生時)

### Scenario A: LLM API 障害で大量エラーが発生している

**症状**: Vercel Logs に `voyage_api_error` / `anthropic_api_error` が大量に出ている、ユーザのプロジェクト作成が遅い。

**対応** (5 分以内):

1. Vercel Dashboard → Settings → Environment Variables
2. **`SUGGESTION_ENGINE_DISABLED`** = **`true`** を追加 (Production)
3. Vercel Dashboard → Deployments → 最新を **Redeploy** (環境変数反映)
4. デプロイ完了後 (~2 分)、提案機能が空配列を返すようになり LLM 呼び出しもゼロに

**復旧時**: `SUGGESTION_ENGINE_DISABLED` を **削除** (or `false`) → Redeploy。

### Scenario B: 月次予算超過で課金を即停止したい

同上の手順で `SUGGESTION_ENGINE_DISABLED=true` を設定。タグ抽出・embedding 生成 (= LLM 呼び出し) すべてが停止し、課金もゼロに。

### Scenario C: 特定テナントのみ抑制したい

`SUGGESTION_ENGINE_DISABLED` は全テナント一括停止のみ。テナント別の制御は **テナント側で `monthlyBudgetCapJpy` を 0 等に設定** することで `withMeteredLLM` ミドルウェアが拒否する仕組みで実現:

```sql
UPDATE tenants SET monthly_budget_cap_jpy = 0 WHERE id = '<tenant-uuid>';
```

これで該当テナントの LLM 呼び出しが `reason: 'budget_exceeded'` で拒否される (他テナントは通常通り)。

### Scenario D: schema drift で本番ログイン不能 (PR #234 の事故再発時)

[DB_MIGRATION_PROCEDURE.md §3.6](./DB_MIGRATION_PROCEDURE.md) のリカバリ手順を参照。`pnpm db:recover --upto <last-applied-migration>` で復旧可能。

---

## トラブルシューティング Q&A

### Q1. 提案が表示されない (空) のはなぜか?

**A**: 以下を順に確認:

1. **`SUGGESTION_ENGINE_DISABLED=true`** が設定されていないか (Vercel 環境変数を確認)
2. default-tenant に **シードナレッジが投入済**か (`SELECT COUNT(*) FROM knowledges WHERE tenant_id='00000000...001' AND visibility='public';`)
3. プロジェクトの `purpose`/`background`/`scope` が **空**でないか (空だと類似度計算できず候補ゼロ)
4. プロジェクトの **タグ + embedding** が両方 NULL でないか (両方 NULL なら 3 軸とも 0 でスコア閾値未到達)

### Q2. embedding が NULL のままで効かない

**A**: PR #5-c 以降は新規データに対して自動生成される。既存データに対しては **PR #368 の月初バッチ** (`runMonthlyEmbeddingBackfill`) で自動補完される (テナント TZ 月初に Vercel Cron 実行)。手動再実行が必要な場合は `/api/cron/tenant-monthly-reset` を CRON_SECRET 付きで叩く。

ただし embedding が NULL でも **重み再配分縮退モード (タグ：テキスト = 5：5、合計重み 1.0)** で動作するため、致命的ではない（詳細は [docs/business/TENANT_AND_BILLING.md §34.14.4](../business/TENANT_AND_BILLING.md) 参照）。

### Q3. テナントを増やすには?

**A**: 6/1 リリース時点では admin が **DB を直接操作**してテナント追加 (UI なし)。手順:

```sql
INSERT INTO tenants (id, slug, name, plan)
  VALUES (gen_random_uuid(), 'tenant-x', 'Tenant X', 'beginner')
  RETURNING id;
-- 返ってきた id をメモ
```

その後、テナントへのシード適用:

```bash
pnpm db:seed:suggestion --tenant <返ってきた id>
```

将来 (PR-X2) で UI 化予定。

### Q4. テナント別の使用量を確認したい

**A**: 現状は admin が API を直叩き:

```
GET /api/admin/usage-summary?date=2026-06-01
```

レスポンスに `tenants[]` 配列があり、tenant 別の `callCount` / `costJpy` / `embeddingTokens` / `llmInputTokens` / `llmOutputTokens` が並ぶ。

将来 (PR-X2) で super_admin ダッシュボード UI で可視化予定。

### Q5. Anthropic コンソール上のクレジット残高が減らないのはなぜか? (#23 / 2026-05-09)

**A**: 仕様通り。本サービスの内部請求 (`Tenant.currentMonthApiCostJpy`) と Anthropic の実 API 課金は **完全に独立した 2 系統**:

| 系統 | 計測対象 | 単価 | 反映タイミング | 反映先 |
|---|---|---|---|---|
| **内部請求 (本サービス)** | `withMeteredLLM` 越しの呼び出し回数 | プラン別固定単価 (Beginner ¥0 / **Expert ¥5/call** / **Pro ¥15/call**、2026-05-15 改定後) | 呼び出し成功直後にアトミック increment | `Tenant.currentMonthApiCostJpy` + `ApiCallLog` |
| **Anthropic 課金** | API key で発生した実トークン消費 | Anthropic 公式単価 (input/output トークン課金) | Anthropic 側で集計 | Anthropic Console |

つまり「Anthropic クレジットが減らない」と感じる場合は **Anthropic API key が正しく設定されているか / call が実際に発火しているか** を確認する。観測ポイント:

1. **API key 設定**: Vercel 環境変数 `ANTHROPIC_API_KEY` が正しいか / 該当 key の Console を見ているか
2. **呼び出し発火**: `ApiCallLog` テーブルに該当 `featureUnit` (`project-upsert` / `suggestion-explanation` 等) のレコードが入っているか — 入っていれば呼び出しは成功しトークン消費もしているはず (2026-05-15: `auto-tag-extract` + `project-embedding` は `project-upsert` に統合された)
3. **集計タイミング**: Anthropic Console は数十秒〜数分の遅延があるため、即時反映を期待しない
4. **無料クレジット**: 新規アカウントの無料クレジット枠から先に消費されるため、有償残高表示が動かないように見えることがある

> **将来の改善**: 内部請求単価と Anthropic 実コストの乖離を縮めるため、`ApiCallLog.llmInputTokens` / `llmOutputTokens` から実コスト概算を出して `Tenant.currentMonthApiCostJpy` に動的反映する案がある。MVP 後に検討 (リリース後 2 ヶ月予定)。

### Q6. Anthropic API はどのタイミングで呼ばれるか? (#17 / 2026-05-09)

**A**: 本サービスから Anthropic Claude を叩くトリガは **2 経路のみ** (両方とも `withMeteredLLM` 越し):

| 経路 | トリガ | featureUnit | モデル分岐 | キャッシュ |
|---|---|---|---|---|
| **(a) プロジェクト作成・更新** | プロジェクトの **新規作成 / 編集** で `purpose` / `background` / `scope` が変わったとき (内部で Anthropic auto-tag + Voyage embedding を **1 ApiCallLog に集約**、2026-05-15 統合) | `project-upsert` | Beginner/Expert: Haiku / Pro: Sonnet | なし (毎回呼ぶ。失敗しても fail-safe で続行) |
| **(b) 「なぜ?」説明文** | 提案画面で「なぜ?」ボタンを **クリックしたとき** (Lazy 生成、Pro プラン限定) | `suggestion-explanation` | Pro: Sonnet (Beginner/Expert は `plan_forbidden` で拒否) | DB 永続キャッシュ。`(projectId, candidateKind, candidateId)` で 2 回目以降は再課金しない |

それ以外 (一覧表示 / WBS 作成 / Knowledge 作成 / 提案候補リスト取得 など) では **Anthropic は呼ばない**。リスト系の類似度計算は **Voyage AI embedding (別サービス)** + pg_trgm のローカル計算でまかなっている。

なお Voyage AI (embedding) は `project-upsert` (a) と各資産 (Knowledge/RiskIssue/Retrospective/Memo) の作成・更新で呼ばれる。資産側 featureUnit は `knowledge-embedding` / `risk-issue-embedding` / `retrospective-embedding` / `memo-embedding`。「公開範囲: 自分のみ」(Knowledge/RiskIssue/Retrospective: `visibility='draft'` / Memo: `visibility='private'`) では Voyage を呼ばない。

呼び出し有無の確認は `ApiCallLog` テーブルの `feature_unit` 列で行う:

```sql
-- 直近 24h で発火した LLM/Embedding 呼び出し (現行 featureUnit 一覧)
SELECT feature_unit, COUNT(*), SUM(llm_input_tokens), SUM(llm_output_tokens), SUM(embedding_tokens)
  FROM api_call_logs
 WHERE created_at > NOW() - INTERVAL '24 hours'
   AND feature_unit IN (
     'project-upsert',
     'knowledge-embedding',
     'risk-issue-embedding',
     'retrospective-embedding',
     'memo-embedding',
     'suggestion-explanation',
     'external-import-embedding'
   )
 GROUP BY feature_unit;
```

> **2026-05-09 (#22) 改修**: 「なぜ?」説明文機能は **Pro プラン限定**になった。Beginner / Expert ではボタン非表示 + サーバ側で `plan_forbidden` を返す (defense-in-depth)。Anthropic 呼び出し量は Pro プラン契約者のなぜ?クリック数次第。
>
> **2026-05-15 (#384) 改修**:
> - `auto-tag-extract` + `project-embedding` の独立 2 ラップを `project-upsert` (1 ラップに集約) に統合 (1 業務操作 = 1 ApiCallLog ルール)。旧 featureUnit は backfill 経路の互換のため metered.ts では受理を残すが、新規発行はされない。
> - Memo (メモ) に embedding 生成を追加。提案エンジン候補化 + 「なぜ?」説明文 (Pro 限定) も Memo 対応。featureUnit は `memo-embedding`。「自分のみ」は Memo では `visibility='private'` (他資産の 'draft' に相当)。

### Q7. テナント解約後に user データはどれくらい保持されるか? (#18 / 2026-05-09)

**A**: テナント解約 → 90 日経過後の物理削除 cron (`purgeOldDeletedTenants`) は **業務データ (Project / Knowledge / RiskIssue / Retrospective / Memo / 添付など) のみ削除し、users 行は永続保持** する仕様 (#18 / 2026-05-09 で方針変更)。

理由: **Beginner プラン乱用防止**。「Beginner で 90 日試用 → 解約 → 別 email で再契約 → また 90 日試用」という抜け道を防ぐため、過去の解約済テナントに紐付く user.email を `BEGINNER_REQUIRES_UPGRADE` 判定 (`tenant-onboarding.service.ts`) で参照する。

- ADR-0016 Phase 10 (2026-05-20): 旧 `BEGINNER_NOT_AVAILABLE_FOR_RETURNING` から rename し、判定条件を「削除/有効問わず」に強化して import API 経由の半永久 abuse を封鎖。
- **ADR-0016 Revised (2026-05-22 / PR #426)**: 判定キーを `initialAdminEmail` 単独に絞り、検出を「層 1 (自前テナント保有 = `OWNED_TENANT_EXISTS` で公開フォーム完全不可) / 層 2 (招待 or Default 所属のみ = `BEGINNER_REQUIRES_UPGRADE` で Expert/Pro 誘導) / 層 3 (完全新規 = 全プラン可)」の 3 層に分離。`billingContactEmail` を判定対象から外して共有 billing email の false positive を抑止。詳細は [ADR-0016 Revised section](../adr/0016-multi-tenant-user-membership.md#revised-2026-05-22)。

| 項目 | 解約直後 | 90 日後 (cron 実行後) |
|---|---|---|
| `tenant.deletedAt` | now でセット | そのまま (削除されない) |
| `user.deletedAt` / `isActive` | now / false | そのまま (削除されない、login は不可) |
| `user.email` / `name` | 保持 | 保持 (abuse 検知用) |
| 業務データ (Project 等) | 論理削除 (deletedAt セット) | **物理削除 (DB 容量解放)** |
| ログ系 (audit / auth_event / role_change / api_call / monthly_usage / email_send) | 保持 | 保持 (法的要件 / 監査) |

GDPR 等で個別ユーザの削除請求があった場合は **super_admin が手動対応** する運用。cron の自動削除には含めない。

---

## リリース後の改善ロードマップ

| 優先度 | 項目 | 想定時期 |
|---|---|---|
| 🔴 高 | 請求書自動生成 + Stripe 連携 | リリース後 1 ヶ月 |
| 🟡 中 | テナント管理 UI (プラン変更を admin DB 更新から UI 化) | リリース後 2 ヶ月 |
| 🟡 中 | super_admin ダッシュボード UI (PR-X2) | リリース後 2 ヶ月 |
| 🟢 中 | Phase 3 LLM Re-ranking (Pro プラン差別化) | リリース後 3 ヶ月 |
| 🟢 低 | embedding backfill スクリプト (既存データへの遡及生成) | 必要時 |
| 🟢 低 | Beginner プランのアップセル誘導 UI | リリース後 4 ヶ月 |

優先順位は [ROLE_REFACTORING_PLAN.md §7](../roadmap/ROLE_REFACTORING_PLAN.md) と [SUGGESTION_FEATURE.md](../specification/SUGGESTION_FEATURE.md) に基づく。

---

## 追加変更履歴

### 2026-05-14: Embedding 生成コスト最適化 (PR #357 + #358)

**運用者向け要約**: ユーザ負担削減のため Voyage AI 呼出回数を削減。既存データへの影響なし、新規操作のみに適用。

| 変更 | 内容 | 影響 |
|---|---|---|
| 案A (PR #357) | 外部データ import (CSV/XLSX) の embedding 生成を **N 件 → 1 ApiCallLog** に集約 | テナント `currentMonthApiCallCount` の増分が import 単位で +1 となり、ユーザ視点の請求回数と実態が一致 |
| 案D (PR #357) | Knowledge / RiskIssue / Retrospective の `visibility='draft'` (公開範囲: 自分のみ) では embedding 生成しない | 課金対象が「実際に提案エンジンに乗るデータ」に限定。draft → public 遷移時に初回生成 |
| フォローアップ (PR #358) | 外部 import 経路と suggestion engine の RiskIssue クエリで visibility 整合性漏れを修正 | 「下書きで取込 → 課金された」「draft な resolved RiskIssue が提案候補に出る」事故を構造的に防止 |
| 拡張 (PR #384 / 2026-05-15) | Memo に embedding 生成を追加。`visibility='public'` のみ対象、`visibility='private'` (= 「自分のみ」、他資産の 'draft' に相当) はスキップ。提案エンジン候補化 + 「なぜ?」説明文 (Pro 限定) 対応 | Memo が他資産と同じ仕様で提案エンジンに参加。`featureUnit='memo-embedding'` |
| 拡張 (PR #384 / 2026-05-15) | プロジェクト作成・更新を **`auto-tag-extract` + `project-embedding` 独立 2 ラップ → `project-upsert` 1 ラップに集約** | プロジェクト新規 1 件で ApiCallLog 1 件 / counter +1 (旧仕様は 2 件)。Beginner 月 100 回上限が実質 100 件 (旧 50 件) に正常化 |
| 最適化 (2026-05-15) | **RiskIssue は `state='resolved'` のみ embedding 生成** に限定。state='open' / 'in_progress' / 'monitoring' では Voyage を呼ばない | 起票直後 (= 解消前) の Voyage 課金がゼロに。解消化遷移時に初回 embedding 生成、解消中の text 変更で再生成、再オープン時は既存保持。月 ¥120〜360 削減 (中規模テナント想定) |
| 最適化 (2026-05-15) | **Project 作成・更新で purpose / background / scope が全て空文字なら早期 return** | `withMeteredLLM` 自体呼ばれず、Anthropic も Voyage も発火しない。テンプレート保存等の限定ケースで完全 ¥0 化 |
| **価格改定 (2026-05-15)** | **per-API-call 単価を半額化: Expert ¥10 → ¥5 / Pro ¥30 → ¥15** | ユーザ採用ハードル削減。半額後でも粗利 73-75% を維持、ワーストでも 50%+ 確保。詳細は [ADR-0002 §プラン構成 (2026-05-15 改定版)](../adr/0002-tenant-billing-per-api-call.md) 参照 |

**ユーザ影響**: 既に生成済の embedding は保持。新規操作のみ動作変更。**価格改定は即時適用**: migration が走るとデフォルト値を使っている全テナントの単価が ¥5/¥15 に更新される。既に発生した ApiCallLog の `costJpy` は変更されず (= 過去請求への影響なし)、migration 実行以降の新規 call から新単価が適用される。

**監視ポイント**:
- 本リリース後 1〜2 週間は `api_call_logs` テーブルの `feature_unit='external-import-embedding'` の件数が **減少傾向** となるはず (= 1 import 単位で 1 件)
- `Tenant.currentMonthApiCallCount` の前月比が顕著に下がる可能性 (= 期待動作)
- super_admin ダッシュボードの「今月の合計課金」も同様に減少傾向
- (2026-05-15 追加) `feature_unit='risk-issue-embedding'` のレコード件数も顕著に減少 (state='open' での発生がなくなるため)

詳細は [KDD_PATTERNS.md §5.X+50 §5.X+51 §5.X+60 §5.X+61 §5.X+62 §5.X+63](../knowledge/KDD_PATTERNS.md) を参照 (§5.X+62 = RiskIssue state='resolved' limitation、§5.X+63 = Project 全空 text 早期 return)。
