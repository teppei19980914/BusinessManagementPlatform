# ADR-0002: テナント単位の従量課金モデル (per-API-call)

- **Status**: Accepted
- **Date**: 2026-04 (反復改訂を経て確定)
- **Deciders**: teppei

---

## Context

外部公開フェーズで課金モデルを設計するにあたり、複数の方式を反復検討した。
本サービスの主な変動コストは **LLM API (Anthropic Claude) + Embedding API (Voyage) + Vector DB クエリ (Supabase pgvector)** であり、ユーザ行動と直結する。

検討時の制約:

- **コスト追跡可能性**: ユーザの「いつ・いくら請求されるか」が明確である必要がある (信頼関係の根幹)
- **収益化の段階性**: 初期ユーザ獲得時は「使った分だけ」の低リスク提示が必要、定着後は上位プランへの誘導が必要
- **悪用防止**: 低価格プランで API を浪費する経済的攻撃 (例: 月初に無料枠を使い切らせる連続呼び出し) を回避する必要がある
- **per-user 課金は脆弱**: ユーザ数で課金すると「1 アカウントを共用する」で容易に回避できる
- **per-token 課金は不透明**: LLM の token 数はユーザにとって不可視で、月額予測ができない

## Decision

**3 プラン構成 + 提案エンジン API 呼び出しごとの従量課金** を採用する。

### プラン構成

| プラン | 月額固定 | 提案 API 呼び出し | 上限超過時の単価 |
|---|---|---|---|
| Beginner | ¥0 | 月 100 回まで無料 | 縮退モード (上限到達で fail-safe) |
| Expert | ¥3,000 | 月 100 回まで月額に含む | ¥10/回 |
| Pro | ¥10,000 | 月 500 回まで月額に含む | ¥30/回 |

詳細は [docs/business/TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md) §13.7 / §26.7 参照。

### プラン切替ルール

- **Expert ↔ Pro**: 即時反映 (per-call 課金のため月途中切替が単価で吸収可能)
- **Beginner ダウングレード**: 禁止 (悪用防止: 上位プランで使い切ってから Beginner に戻す逃れ口を塞ぐ)
- **Storage プラン**: LLM プランと直交する独立軸 ([docs/business/TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md) §34.14)

### 縮退モード

Beginner プラン上限到達時、**完全停止はせず**裏方の AI 処理 (embedding 自動生成) のみ停止する。
ユーザは作成・更新を継続でき、NULL embedding は **月初バッチで補完** される。
fail-safe 設計の詳細は [docs/business/TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md) §34.14.4 / [docs/design/SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md) §B-4 参照。

## Consequences

### Positive
- 「使った分だけ」が明確で、初期ユーザの心理的ハードルが低い
- per-call 課金により、テナント単位での月額予測が可能 (テナント月次使用履歴 `tenant_monthly_usage_history` で追跡)
- 悪用 (Beginner で使い倒す) を Beginner ダウングレード禁止ルールで防げる
- 縮退モードにより、上限到達時もサービスが「壊れない」(ハードカット 429 を採用していない)

### Negative / Trade-off
- 課金単位の管理が複雑 (Bulk な LLM 操作は「1 業務操作 = 1 ApiCallLog」に集約する必要あり — memory: feedback_bulk_llm_call_unit)
- `visibility='draft'` のエンティティに embedding を生成しないルール等、課金最適化のために業務ロジックに制約が生まれる (memory: feedback_visibility_embedding)
- 月初バッチでの embedding 補完が前提のため、バッチ失敗時のリカバリ手順を運用設計に含める必要がある

### Risk / 留意事項
- **課金根拠データはダッシュボード遷移時に再集計する**: cron キャッシュへの依存は誤請求リスクを生む (memory: feedback_billing_data_realtime)
- **コスト超過監視**: テナント単位の利用量推移を毎月モニタする運用が必要 ([docs/design/SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md) §F)

## Alternatives Considered

### Alt-1: per-user 課金 (席課金)
- 概要: テナント内のユーザ数 × 月額単価で課金
- メリット: 課金額の予測が極めて簡単
- 不採用理由: 「1 アカウントを複数人で共用する」で容易に回避できる。SaaS 業界で広く採用されているが、本サービスのコスト構造 (LLM API がコストの大部分) と整合しない

### Alt-2: per-token 課金 (LLM の入出力トークン数で従量課金)
- 概要: Anthropic API の `usage.input_tokens + usage.output_tokens` を単位に課金
- メリット: 実コストとの整合性が完璧
- 不採用理由: token 数はユーザにとって不可視で、月額予測ができない。「なぜこの請求になったか」の説明コストが高い

### Alt-3: 月額固定のみ (従量課金なし)
- 概要: Beginner / Expert / Pro の月額固定で、API 利用量は無制限
- メリット: 課金モデルが極めて単純
- 不採用理由: ヘビーユーザによる API コスト超過が損益直撃。Beginner プランで悪用された場合のリスクが大きすぎる

### Alt-4: 上限到達時のハードカット (HTTP 429)
- 概要: Beginner で月 100 回到達したら、追加呼び出しを 429 で拒否
- メリット: 課金境界が明確
- 不採用理由: 「サービスが急に壊れる」体験を作る。継続利用したいユーザに「アップグレード必須」を強要する形になり、収益化の段階性が損なわれる。**縮退モード (fail-safe)** の方が顧客体験と収益化を両立できる

## Related

- 詳細設計: [docs/business/TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md) Part 1〜5 (要件 → 仕様 → アーキテクチャ → コスト試算)
- 提案エンジンとのコスト構造: [docs/design/SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md) §D, §E
- マルチテナント基盤: [ADR-0001](./0001-multitenant-foundation.md)
- 提案エンジン採用: [ADR-0003](./0003-embedding-based-suggestion-engine.md)
