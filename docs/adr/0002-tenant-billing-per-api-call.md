# ADR-0002: テナント単位の従量課金モデル (per-API-call)

- **Status**: Accepted (2026-04 初版 → 2026-05-15 料金構造を反映して改訂)
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

### プラン構成 (2026-05-15 改定版 — 半額化)

| プラン | 月額固定 | 席数 | API 呼び出し上限 | 単価 | モデル |
|---|---|---|---|---|---|
| Beginner | ¥0 | 5 席 | 月 100 回まで無料 (上限到達後は縮退) | — | Haiku |
| Expert | ¥0 | 無制限 | 無制限 (テナント管理者設定の `monthlyBudgetCapJpy` で上限) | **¥5 / 1 API 呼び出し** (改定前 ¥10) | Haiku |
| Pro | ¥0 | 無制限 | 無制限 (同上) | **¥15 / 1 API 呼び出し** (改定前 ¥30) | Sonnet |

#### 価格改定の経緯 (2026-05-15 半額改定)

旧仕様 (初版 ADR) では Expert ¥3,000/月 100 回含、Pro ¥10,000/月 500 回含のハイブリッドモデルだったが、**2026-05-15 反復改訂で月額固定を撤廃し純粋な従量課金 (Expert ¥10 / Pro ¥30) に統一**。さらに同日中に **ユーザ採用ハードル削減のため半額化 (Expert ¥5 / Pro ¥15)** を決定。

**半額化の理由**:
- 創業者ヒアリングと初期 UX 検証で「**1 操作 ¥30 は心理的に高い**」という直観的フィードバック
- 競合 (Notion AI ¥1,500/月、Microsoft Copilot ¥4,500/月、Asana + AI 等) と比較し、座席数 10 のチームで本サービスは ¥1,000-3,000/月 (旧価格) → 圧倒的に安いが、per-call 課金特有の「クリック不安」が adoption に影響
- 半額後も粗利 73-75% を維持 (旧 85%)、ワーストケース (Anthropic 値上げ 2 倍 + Voyage 無料枠超過) でも 50%+ 粗利確保
- Stripe 手数料 (国内クレカ 3.6%) を考慮しても黒字維持
- Pro/Expert 単価比 3x を保ち、プラン差別化 (Sonnet 品質 + 「なぜ?」説明文 Pro 限定) は維持

**今後の方針**: 実運用データを 3-6 ヶ月見て、Pro 単価を更に下げる余地を継続検討する (例: ¥15 → ¥12)。

詳細は [docs/business/TENANT_AND_BILLING.md Part 5 §34.14](../business/TENANT_AND_BILLING.md) (確定版) 参照。

### 「1 回の API 呼び出し」の定義 (1 業務操作 = 1 ApiCallLog ルール、2026-05-15)

ユーザ視点での 1 操作で内部的に複数の LLM/Embedding API を呼んでも、課金単位は 1 回に集約する。

- **プロジェクト作成・更新**: `featureUnit='project-upsert'` (内部で Anthropic auto-tag + Voyage embedding を 1 度の `withMeteredLLM` ラップで集約)
- **各資産 (Knowledge / RiskIssue / Retrospective / Memo) の作成・更新**: 資産種別ごとの featureUnit (`knowledge-embedding` / `risk-issue-embedding` / `retrospective-embedding` / `memo-embedding`) で **1 業務 = 1 ApiCallLog**
- **「公開範囲: 自分のみ」(Knowledge/RiskIssue/Retrospective: `visibility='draft'` / Memo: `visibility='private'`)** は embedding 生成しない → 課金なし
- **「公開範囲: 全メンバー」かつ embedding 対象項目の実値変更時** のみ Voyage 呼び出し → 1 件課金

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
