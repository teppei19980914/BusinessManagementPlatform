# 提案エンジン v2 改修効果の検証記録

PR-X5 / PR-X6 で実施した提案エンジン改修の効果を **before / after で定量記録** する。

ユーザの「**0 件にしない**」要件と、シードデータ拡充 + 件数保証ロジックによる構造的改善を、
スクショと数値で可視化することで、サービスとしての信頼性を担保する。

## 1. 検証目的

- シードデータ拡充 (PR-X5) と段階表示 UI + 件数保証 (PR-X6) の **複合効果** を可視化する
- 「請求書発行システム構築」のような実プロジェクトで提案 0 件 → 多数件への改善を実測する
- API 応答時間 / クエリ実行回数 / Voyage コスト等の **運用パフォーマンス指標** を継続観測する

## 2. 検証対象プロジェクト

| プロジェクト名 | テナント | 初回確認日 | 改修前の提案件数 |
|---|---|---|---|
| 請求書発行システム構築 | default | 2026-05-07 | **0 件** (ナレッジ候補 / 過去課題 / 過去振り返り すべて 0) |
| (新規追加分のサンプル) | default | TBD | TBD |

## 3. 改修前 (Before) — 2026-05-07 時点

### 3-1. スクショ

(改修前の提案 0 件画面のスクショを以下に貼付。本ドキュメントには相対パスでリンク)

- `docs/operations/screenshots/before-suggestions-empty.png` (TBD)

### 3-2. 数値

| 指標 | 値 |
|---|---|
| 提案件数 (ナレッジ候補) | **0 件** |
| 提案件数 (過去課題) | **0 件** |
| 提案件数 (過去振り返り) | **0 件** |
| 全件 SEED_KNOWLEDGE | 30 件 (旧シード、enum 値が誤り [`lesson_learned` / `pattern`]) |
| 全件 embedding 付き | 0 件 (= 縮退モード運用) |
| pg_trgm 最大スコア (請求書発行 vs 全シード) | 0.0318 (閾値 0.05 未達) |

### 3-3. 失敗の構造的原因 (改修前)

1. シードナレッジのタグが英語スネーク (`finance` / `invoicing`) で、ユーザの日本語タグと交差ゼロ
2. embedding が NULL のため意味類似度 (重み 50%) がゼロ化
3. pg_trgm のスコア (0.0318) × 重み 0.2 = 0.00636 が `SUGGESTION_SCORE_THRESHOLD = 0.05` を下回る
4. → すべての候補が足切りされ提案 0 件

詳細は [V1_FINAL_TASKS.md PR-X5/X6](../roadmap/V1_FINAL_TASKS.md) を参照。

## 4. 改修後 (After) — PR-X5 + PR-X6 完了時

(本セクションは PR-X5 + PR-X6 マージ後、本番投入完了後に追記する)

### 4-1. スクショ

- `docs/operations/screenshots/after-suggestions-tiered.png` (TBD)

### 4-2. 数値

| 指標 | 改修前 | 改修後 | 変化 |
|---|---|---|---|
| 提案件数 (strong tier、score >= 0.3) | 0 | TBD | +TBD |
| 提案件数 (medium tier、score 0.1-0.3) | 0 | TBD | +TBD |
| 提案件数 (weak tier、score < 0.1) | 0 | TBD | +TBD |
| 関連性「妥当」比率 (上位 5 件、人間判断) | N/A | TBD% | — |
| API 応答時間 P50 | TBD | TBD ms | — |
| API 応答時間 P95 | TBD | TBD ms | — |
| 全件 SEED_KNOWLEDGE | 30 件 | 50 件 | +20 件 |
| 全件 SAMPLE_PROJECTS | 0 件 | 10 件 | +10 件 (隠蔽済) |
| 全件 SAMPLE_ISSUES | 0 件 | 40 件 | +40 件 (隠蔽済) |
| 全件 SAMPLE_RETROSPECTIVES | 0 件 | 15 件 | +15 件 (隠蔽済) |
| 全件 embedding 付き | 0 件 | TBD 件 | — |

### 4-3. 個別プロジェクトでの hit 状況サンプル

| プロジェクト名 | 業務ドメイン | strong | medium | weak | 合計提案件数 |
|---|---|---|---|---|---|
| 請求書発行システム構築 | 経理 / 業務改善 | TBD | TBD | TBD | TBD |
| (新規 PoC プロジェクト) | TBD | TBD | TBD | TBD | TBD |

## 5. 検証手順

### 5-1. PR-X5 マージ + 投入

1. PR-X5 マージ → Vercel 本番デプロイ完了を確認
2. 本番に対して `pnpm db:seed:suggestion` を実行 (`.env.local` に本番接続情報を一時設定)
3. 投入結果を確認: SEED_KNOWLEDGE 50 件 / SAMPLE_PROJECTS 10 件 / SAMPLE_ISSUES 40 件 / SAMPLE_RETROSPECTIVES 15 件 が default-tenant に存在すること
4. ブラウザで「請求書発行システム構築」の提案画面を開き、PR-X5 単独での件数を一旦記録 (PR-X6 はまだ未デプロイなので閾値 0.05 で動作中)

### 5-2. backfill 実施

5. 本番に対して `pnpm seed:generate-embeddings --backfill-existing` を実行 → 既存データ + 新シードに embedding が付与される
6. ブラウザで再度提案画面を確認 → 件数とスコアの変化を記録

### 5-3. PR-X6 マージ + 投入

7. PR-X6 マージ → Vercel 本番デプロイ完了
8. ブラウザで提案画面を確認 → 段階表示 (strong / medium / weak) の動作 + 件数保証ロジックの動作を確認
9. 各 tier の件数とスコアを本ドキュメントの「改修後」セクションに記録
10. 数値・スクショを git commit して PR で共有

## 6. 検証結果と次のアクション

(検証完了後に追記する。ここに以下を記載予定)

- 全体評価 (KPI 達成 / 未達 / 想定外発見)
- 残課題 (V1 後の Phase 2 / 3 に送る項目)
- ユーザヒアリング結果 (β テスター 5 名想定、提案精度の主観評価)

## 7. 関連ドキュメント

| ドキュメント | 内容 |
|---|---|
| [V1_FINAL_TASKS.md](../roadmap/V1_FINAL_TASKS.md) | PR-X5 / PR-X6 の計画 |
| [SEED_DATA_MAINTENANCE.md](../developer-guide/SEED_DATA_MAINTENANCE.md) | シードデータの維持・更新ガイド + 拾われやすい文章の書き方 |
| [SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md) | 提案エンジン技術設計 |
