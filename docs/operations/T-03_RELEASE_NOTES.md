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

**A**: PR #5-c 以降は新規データに対して自動生成される。既存データに対しては別途 backfill が必要 (本リリース時点では backfill スクリプト未実装、必要に応じて後続 PR で対応)。

ただし embedding が NULL でも **2 軸縮退モード (タグ + pg_trgm)** で動作するため、致命的ではない。

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
