# ADR-0008: 縮退モード (graceful degradation) — ハードカット 429 を採用しない

- **Status**: Accepted
- **Date**: 2026-05 (TENANT_AND_BILLING 確定版で正式採用)
- **Deciders**: teppei

---

## Context

[ADR-0002](./0002-tenant-billing-per-api-call.md) で per-API-call の従量課金を採用した結果、Beginner プラン (月 100 回まで無料) で上限到達した際の挙動を決める必要があった。
本サービスの中核機能 (提案エンジン / LLM 自動タグ抽出 / Voyage embedding) は外部 API への金銭コストが直結するため、上限超過時の制御が必須。

検討時の制約:

- **上限超過時に金銭損失を防ぐ**: Beginner プランで上限を超えた場合、無制限に LLM/Voyage API を叩かれると損益直撃
- **「サービスが急に壊れる」体験を避けたい**: 上限到達した瞬間にあらゆる操作が 429 で拒否されると、ユーザは「強制アップグレード」を迫られる感覚になり継続意欲を失う
- **データ整合性は維持したい**: 業務データ (プロジェクト / ナレッジ / タスク等) の作成・更新は止めず、ユーザの作業を継続させる
- **月初リセットへの自然な接続**: 翌月 1 日に上限がリセットされた際、欠損データなく自動で正常状態へ復帰したい

## Decision

**「裏方の AI 処理のみ停止し、フロント業務処理は継続」** する fail-safe 設計 (縮退モード) を採用する。

### 動作仕様

| 機能カテゴリ | 上限到達後の挙動 |
|---|---|
| プロジェクト / ナレッジ / リスク・課題 / 振り返り / メモの **作成・更新・削除** | **継続** (LLM 呼出をスキップして DB のみ書込) |
| 自動タグ抽出 (Anthropic Claude API) | **停止** (該当エンティティの `tags` は NULL 保存) |
| embedding 生成 (Voyage API) | **停止** (該当エンティティの `embedding` は NULL 保存) |
| 提案エンジンの **実行** (検索クエリ自体は新規 embedding 1 件発生) | **停止** (UI に「縮退モード中」表示、過去の embedding 済データは検索結果に含まれない) |
| 月初バッチ (翌月 1 日 cron) | **NULL embedding を一括補完** (新規月の利用枠を消費) |

### 上限到達の判定タイミング

- 各 LLM/Voyage API 呼出の **直前** に `withMeteredLLM` ラッパーで判定
- 既に進行中の業務操作 (例: プロジェクト更新中) は **業務 DB 書込は完了させる** (AI 処理だけスキップ)

### UI の可視化

- ダッシュボード上部に「縮退モード中: 〇〇 (月初リセット予定: YYYY-MM-DD)」バナー表示
- 各提案エンジン UI で「縮退モード中のため過去 N 件の embedding 未生成データは含まれません」と注釈

## Consequences

### Positive
- **収益化の段階性が保てる**: ユーザは無料枠内で価値を体験できる + 上限到達後もサービスが「壊れない」ため、自然に有料プラン検討へ移行できる
- **月初リセットでの完全自動復帰**: 月初バッチで NULL embedding を補完するため、上限超過月のデータも翌月以降の提案候補に乗る (顧客データの永久損失なし)
- **作業継続性が保たれる**: 業務 DB 書込は止めないため、「明日続きを書こう」がそのまま実現
- **過剰課金事故の予防**: 上限を超えた瞬間に API 呼出を物理的に止めるため、上限超過の API 課金は発生しない

### Negative / Trade-off
- **実装複雑性の増大**: `withMeteredLLM` ラッパー / Degraded mode service / 月初バッチの 3 つの仕組みが連携する必要がある
- **「縮退モード中」の UX 設計負荷**: ユーザが「なぜ提案が出ないのか」を理解できる UI 説明が必要 (ダッシュボードバナー + 個別画面注釈)
- **デバッグ難度の上昇**: 「提案エンジンに古いデータが出ない」の原因が「縮退モード中」「visibility=draft」「embedding NULL」のいずれか切り分けが必要
- **月初バッチへの依存**: バッチ失敗 = 翌月のデータが提案候補に乗らない、という連鎖故障経路ができる ([INCIDENT_RESPONSE.md §6.8](../operations/INCIDENT_RESPONSE.md) で対処手順)

### Risk / 留意事項
- **NULL embedding の補完漏れ**: 月初バッチが失敗した場合、復旧手順 ([INCIDENT_RESPONSE.md §6.8](../operations/INCIDENT_RESPONSE.md)) で手動補完
- **テナント単位のモニタリング**: 縮退モード状態の継続日数をダッシュボードに表示、長期化テナントは admin にアラート
- **将来の Expert/Pro での扱い**: 現状は Beginner のみ縮退モード対象。Expert/Pro は無制限 + `monthlyBudgetCapJpy` 設定でアプリ層停止 (テナント管理者の自主制御)

## Alternatives Considered

### Alt-1: ハードカット (HTTP 429 で全機能停止)
- 概要: 上限到達時、提案エンジン関連 API ルートを 429 Too Many Requests で拒否
- メリット: 課金境界が明確、実装が単純
- 不採用理由: 「サービスが急に壊れる」体験を作る。継続利用したいユーザにアップグレード必須を強要する形になり収益化の段階性が損なわれる。**初期ユーザの離脱率を最も上げる選択肢**

### Alt-2: 上限なし (Beginner も従量課金、無料枠ゼロ)
- 概要: 全プランで使った分だけ課金
- メリット: 課金モデルが極めて単純
- 不採用理由: 初期ユーザの心理的ハードルが高すぎる (「いくら請求されるか分からない」)。本サービスの「使った分だけ」の信頼関係の根幹が崩れる

### Alt-3: 上限到達時に admin に手動承認させる
- 概要: Beginner 上限到達時、admin に通知して個別判断で続行を許可
- メリット: ユーザ単位のきめ細かい制御
- 不採用理由: 1 人運用では admin 介入が即応できない。深夜・休日に上限到達したら翌営業日まで全停止に近い

### Alt-4: 古い embedding を捨てて新規を優先 (FIFO)
- 概要: 上限到達後の embedding 生成は古いものを削除して新規を生成
- メリット: 直近データが優先される
- 不採用理由: 提案エンジンは「過去資産の網羅」が価値の核心 (memory: project_suggestion_engine_priority)。過去データを意図的に削除する設計は方針と矛盾

## Related

- 詳細設計: [docs/business/TENANT_AND_BILLING.md §34.14.4](../business/TENANT_AND_BILLING.md) / [docs/design/SUGGESTION_ENGINE.md §B-4](../design/SUGGESTION_ENGINE.md)
- 課金モデル: [ADR-0002](./0002-tenant-billing-per-api-call.md)
- インシデント対応: [docs/operations/INCIDENT_RESPONSE.md §6.8 (月初 cron 失敗時)](../operations/INCIDENT_RESPONSE.md)
- 用語: [docs/business/GLOSSARY.md (縮退モード)](../business/GLOSSARY.md)
