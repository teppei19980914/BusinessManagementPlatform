# STRIDE 脅威モデリング 実施手順 (人間運用版)

本ドキュメントは、たすきば Knowledge Relay の **STRIDE 脅威モデリング** を人間が手動で実施するための手順書です。

> **背景**: 2026-06-01 以降、本プロジェクトは人間駆動運用に切り替わります。
> 旧 AI 駆動運用では `/threat-model` skill で半自動化されていた脅威分析を、
> 人間が四半期ごとに手動実施する形に簡素化します。
>
> 過去の AI 駆動時代の自動レポート例は [SUGGESTION_ENGINE_THREAT_MODEL.md](./SUGGESTION_ENGINE_THREAT_MODEL.md) /
> [PHASE2_THREAT_MODEL.md](./PHASE2_THREAT_MODEL.md) を参照。これらと同等の品質を人間が再現することが目標です。

---

## いつ実施するか

### 定期 (四半期ごと)

毎四半期 (1月 / 4月 / 7月 / 10月 の初週) に **全体再評価** を実施。
担当: teppei (将来チーム化したら持ち回り)。

### 臨時 (以下の変更が入ったとき)

- **新しい外部 SaaS / API の導入** (例: Stripe 決済連携、Voyage モデルバージョン更新)
- **データモデルの根本構造変更** (新エンティティ、認可境界の変更、テナント分離方式の変更)
- **認証・認可方式の変更** (ロール追加、MFA 仕様変更、SSO 導入)
- **新規 page.tsx / route.ts の追加で重要機能を提供する場合**
- **インシデント発生後の事後分析** (実発生事例を脅威モデルに反映)

---

## STRIDE とは

STRIDE は Microsoft が提唱した脅威分類モデル。**「攻撃者目線で何ができるか」を 6 カテゴリで体系化** します。

| カテゴリ | 意味 | 対応する Security Property | 典型例 |
|---|---|---|---|
| **S**poofing | なりすまし | 認証 (Authentication) | 他人のセッションでログイン、捨てアドレスで大量アカウント作成 |
| **T**ampering | 改ざん | 完全性 (Integrity) | DB レコード直接書換え、プロンプトインジェクション、リクエスト改ざん |
| **R**epudiation | 否認 | 監査性 (Non-repudiation) | 「自分は使っていない」と主張、ログ未整備で反証不能 |
| **I**nformation Disclosure | 情報漏洩 | 機密性 (Confidentiality) | API キー漏洩、テナント越境、エラーメッセージから内部情報露呈 |
| **D**enial of Service | サービス妨害 | 可用性 (Availability) | 大量リクエストで API 課金爆発、巨大入力での処理停止 |
| **E**levation of Privilege | 権限昇格 | 認可 (Authorization) | 一般ユーザが admin 機能を実行、`subscription_tier` 改ざん |

---

## 実施手順 (5 ステップ)

### Step 1: 対象スコープを明確化 (15-30 分)

「何の脅威分析をするか」を 1 段落で書き出す。

- **対象機能 / コンポーネント**: 例 → 提案エンジン v2 / Stripe 決済連携 / MFA 認証フロー
- **分析の起点となる変更**: 何の PR / 機能追加が契機か (定期実施なら「定期見直し」)
- **想定する攻撃者像**:
  - 外部の匿名攻撃者 (未認証)
  - 一般ユーザ (認証済、悪意あり)
  - 内部関係者 (admin 権限の悪用)
  - サービスベンダー側 (Anthropic / Voyage / Supabase / Vercel)

### Step 2: 攻撃面 (Attack Surface) を分解 (30-60 分)

データ・処理が外部とやり取りする **境界** を 4-6 個に分けて列挙する。
ボックス図を頭の中で描き、それぞれの境界で何が流れるかを書く。

典型的な境界 (本プロジェクトの場合):

1. **クライアント (ブラウザ) ↔ Next.js サーバ**: 認証 Cookie、CSRF token、ユーザ入力
2. **Next.js サーバ ↔ PostgreSQL (Supabase)**: Prisma クエリ、pgvector 検索
3. **Next.js サーバ ↔ Anthropic Claude API**: LLM プロンプト、API キー、レスポンス
4. **Next.js サーバ ↔ Voyage AI API**: Embedding 入力、API キー、ベクトル
5. **Next.js サーバ ↔ Brevo (メール)**: 認証メール、通知メール、機密情報候補
6. **Next.js サーバ ↔ Stripe**: 決済情報、Webhook、署名検証

### Step 3: STRIDE 各カテゴリで脅威を列挙 (90-180 分)

**6 × 攻撃面 = 24-36 個のセル** を 1 つずつ確認し、該当する脅威があれば書き出す。
脅威ごとに以下を記録:

- **ID** (例: S-1, T-2, I-3 等)
- **概要 (1-2 文)**: 何が起きうるか
- **発生確率 (低 / 中 / 高)**: 攻撃の現実性
- **影響度 (低 / 中 / 高 / 致命的)**: 起きた場合の損害
- **既存の対策**: 現在実装されている防御
- **追加すべき対策 (該当時)**: 不足している防御

> **目安**: 1 つのカテゴリで 2-5 個の脅威が出るのが普通。0 個なら見落とし、10 個超なら抽象度が低すぎる可能性。

### Step 4: 優先度付け + 対応計画 (30-60 分)

リスクスコア = 発生確率 × 影響度 で並べる。

| 影響度＼確率 | 低 | 中 | 高 |
|---|---|---|---|
| **致命的** | 中 | **高** | **緊急** |
| **高** | 低 | 中 | **高** |
| **中** | 低 | 低 | 中 |
| **低** | 受容 | 受容 | 低 |

- **緊急 / 高**: 当該分析後 2 週間以内に対策実装 (別 PR を起票)
- **中**: 次四半期までに計画
- **低 / 受容**: 監視のみ、または明示的にリスク受容 (理由を記録)

### Step 5: ドキュメント化 + 共有 (30 分)

分析結果を `docs/security/<対象>_THREAT_MODEL.md` として記録。
形式は [SUGGESTION_ENGINE_THREAT_MODEL.md](./SUGGESTION_ENGINE_THREAT_MODEL.md) を雛形に。

必須セクション:

1. **対象機能と分析日**
2. **攻撃面の全体像**
3. **STRIDE 各カテゴリの脅威列挙**
4. **対策の実装 PR 一覧** (脅威 → PR のマッピング)
5. **残存リスクの受容と理由**
6. **次回レビュー予定日** (3-6 ヶ月後)

---

## 本プロジェクト固有の頻出脅威パターン

過去の脅威モデルから抽出した **本サービスで特に注意すべき脅威**:

### 1. テナント越境 (I カテゴリ最重要)

- **典型例**: 一覧系サービスで `viewerTenantId` を引数化し忘れ、別テナントのデータが返る
- **検知策**: コードレビューで「Service 関数の引数に `viewerTenantId` が含まれるか」を必ず確認 ([ADR-0005](../adr/0005-rbac-two-stage-tenant-authorization.md))
- **重大度**: severity-1 (個人情報漏洩相当、事故では済まない)

### 2. LLM API のコスト爆発 (D カテゴリ最重要)

- **典型例**: 1 ユーザが短時間に大量リクエストで API 課金を爆発させる
- **対策の 3 重防御**:
  1. アプリ層 rate limit (1 ユーザ / 分 / 時)
  2. プラン上限到達時の縮退モード ([ADR-0002](../adr/0002-tenant-billing-per-api-call.md))
  3. Anthropic workspace 全体の月間ハード上限
- **新機能追加時の必須確認**: 「この機能で新規 LLM API 呼び出しが発生するか?」「発生するなら withMeteredLLM ラップで集約されているか?」

### 3. API キー漏洩 (I カテゴリ致命的)

- **典型例**: ANTHROPIC_API_KEY / VOYAGE_API_KEY がコード・ログ・エラーメッセージに混入
- **対策の二重防御**:
  1. `.claude/hooks/block-dangerous-edit.sh` が `.env` 等への編集をブロック
  2. CI の `gitleaks` が push 時に検知
- **エラーログ出力時の注意**: `recordError` で API キー候補パターンを正規表現でマスク化

### 4. プロンプトインジェクション (T カテゴリ)

- **典型例**: ユーザ入力に「以前の指示を無視して...」のような誘導文字列が混入
- **対策の 4 層**:
  1. 入力長制限 (validator で enforce)
  2. システムプロンプトとユーザデータの XML タグ分離
  3. LLM 出力の zod スキーマ検証
  4. LLM コンテキストに他ユーザ・admin・システム秘匿情報を絶対含めない

### 5. Visibility による埋め込み生成漏れ (I カテゴリ)

- **典型例**: `visibility='draft'` (Knowledge/RiskIssue/Retrospective) や `visibility='private'` (Memo) の資産が誤って提案候補に乗る
- **対策**: 提案候補は **一律「公開範囲: 全メンバー」のみ**。embedding 生成も同時にスキップ ([ADR-0003](../adr/0003-embedding-based-suggestion-engine.md))
- **RiskIssue は追加条件**: `state='resolved'` も embedding 生成の必須条件

---

## チェックリスト (実施完了時に確認)

- [ ] 対象スコープが 1 段落で書かれている
- [ ] 攻撃面が 4-6 個に分解されている
- [ ] STRIDE 6 カテゴリすべてに「該当なし」も含めて言及している
- [ ] 各脅威に発生確率・影響度・対策がついている
- [ ] 緊急 / 高 リスクには対応 PR が起票されている
- [ ] 残存リスクの受容理由が明文化されている
- [ ] 次回レビュー予定日が記載されている
- [ ] `docs/security/` 配下にファイル保存
- [ ] [README.md](./README.md) の索引に追記

---

## 関連ドキュメント

- 過去の脅威モデル (フォーマット参考): [SUGGESTION_ENGINE_THREAT_MODEL.md](./SUGGESTION_ENGINE_THREAT_MODEL.md) / [PHASE2_THREAT_MODEL.md](./PHASE2_THREAT_MODEL.md)
- マルチテナント設計判断: [ADR-0001](../adr/0001-multitenant-foundation.md)
- 課金モデル設計判断: [ADR-0002](../adr/0002-tenant-billing-per-api-call.md)
- 提案エンジン設計判断: [ADR-0003](../adr/0003-embedding-based-suggestion-engine.md)
- 認可方式設計判断: [ADR-0005](../adr/0005-rbac-two-stage-tenant-authorization.md)
- セキュリティ設計全般: [../design/SECURITY.md](../design/SECURITY.md)
- 自動セキュリティ検査 (gitleaks / Semgrep / CodeQL / Trivy 等): [README.md](./README.md) §CI 統合
- 残対応のセキュリティタスク: [SECURITY-TASKS.md](./SECURITY-TASKS.md)
- 外部参考: [Microsoft STRIDE Threat Model](https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats) (公式) / [OWASP Threat Modeling Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html) (公式)
