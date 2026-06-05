# ADR-0033: スターターデータ取込 + 提案/チャットの単一テナント化 + 請求先のプラン別出し分け

- **Status**: Accepted
- **Date**: 2026-06-05
- **Deciders**: PM (teppei) + Claude Code
- **関連**: [ADR-0013](./0013-beginner-downgrade-prohibition.md) (Beginner ダウングレード禁止) / [ADR-0016](./0016-multi-tenant-user-membership.md) (マルチテナント / サインアップ 3 層判定) / 旧「提案エンジン: シードデータ参照」(seedDataEnabled, PR G #24) を **撤去**

---

## Context (背景)

LP からたすきばに辿り着いても **テナント払い出しのハードルが高い** という課題があった。原因は 2 つ。

1. **無料の Beginner プランでも請求先情報 (住所・会社名等) の入力を強制** していた。Beginner は課金が発生しない (90 日試用 + 月 50 call 無料 → 読み取り専用) にもかかわらず、開設時に住所まで求めるのは過剰で離脱要因だった。
2. **開設直後はデータが空** で、提案エンジン・AI チャット検索の価値を体験できない。デモ環境を別途用意するリソースは無い。

また、空テナントでも提案が出るよう、提案エンジンは `seedDataEnabled` トグルで **管理テナント (MANAGEMENT_TENANT_ID) のシードを越境参照** していた。これはテナント分離の観点では「許容された越境」であり、分離を弱める要素だった。

---

## Decision (決定)

### 1. 請求先情報のプラン別出し分け

- **Beginner**: 請求先セクションを **非表示・任意化**。請求担当者名/メールは初期管理者の値を自動補完、`billingType=individual` 既定。住所は NULL 可のまま (DB カラムは元々 nullable、migration 不要)。
- **Expert / Pro**: 従来どおり住所一式 (法人は会社名も) を **必須**。
- zod は `superRefine` でプラン分岐 (両方向をユニットテストで固定)。
- **有料化ガード**: Beginner → Expert/Pro 昇格、Expert ↔ Pro 切替の瞬間に請求先住所が未完なら `BILLING_INFO_INCOMPLETE` で拒否し、設定画面の請求先入力へ誘導 (= 請求書送付先のない有料テナントを生まない)。

### 2. スターターデータ取込 (選択肢A: 管理テナントからのクローン)

- テナント設定に「スターターデータを取り込む / 削除」を新設 (admin 限定)。
- **取込**: 管理テナントの `isSampleData=true` (顧客/プロジェクト/子の課題・リスク/振り返り + テナント級ナレッジ) を **厳格フィルタ** で読み、実行者テナントへ `isSampleData=false` (一覧表示) + `is_seed_sample=true` (削除マーカー) で複製。embedding は raw SQL で複製元からコピー (= Voyage 再呼出なし、課金ゼロ)。一覧表示のため課題/リスク・振り返りは M:N 連結も作成。
- **ガード**: `precheckImportStorage` で容量判定 (Beginner 50MB 超はブロック、Expert/Pro は UI 確認ダイアログ→承認で投入)。監査ログ記録。
- **削除**: 自テナントの `is_seed_sample=true` のみを依存順に **物理削除** (使い捨てサンプルのため。論理削除では Customer の NOT NULL `customer_id` FK と整合せず容量も解放されない)。手動データは無傷。
- **識別マーカー**: `is_seed_sample` 列を customers/projects/knowledges/risks_issues/retrospectives の 5 テーブルに追加 (`isSampleData` とは別軸。後の一括削除の対象特定専用)。migration `20260612`。

### 3. 提案/チャットの単一テナント化 + seedDataEnabled 撤去

- 提案エンジン (`suggestion.service`) / チャット検索 (`chat-search.service`) を **常に自テナントのみ参照** に純化 (`MANAGEMENT_TENANT_ID` 越境参照を全撤去)。テナント分離をさらに強化。
- `seed_data_enabled` カラムを撤去 (migration `20260613`)、関連 UI トグル・API・サービスを全削除。tenant-isolation-invariant テストを「越境参照復活防止」に反転。
- **管理テナントのシードは存続**。役割が「提案の越境参照元」から「スターターデータ取込のクローン元」に変わっただけ (db:seed は継続)。

### 4. キュレーション UI (super_admin)

- `/admin/super/seed-data` を新設。super_admin が取込元 (管理テナント) の Project/Knowledge の `isSampleData` を画面から切替 (見本データの追加・除外)。更新は `MANAGEMENT_TENANT_ID` 限定 (越境防御) + 「全テナントの取込対象になる」警告表示。

---

## Consequences (影響)

### Positive

- Beginner の開設フォームが約 13 → 約 5 項目に削減され、**気軽に試せる**。
- 空テナントでも 1 クリックで「データのある状態」を体験でき、提案/チャットの価値が伝わる (プロジェクト一覧の空状態にも導線)。
- 提案/チャットが単一テナント参照になり、**テナント分離が一段強化** (フェイルオープン risk も構造的に消滅)。

### Negative / トレードオフ

- **自動コールドスタートの喪失**: 越境参照を撤去したため、未取込の新規テナントは取り込むまで提案が空になる (= スターターデータをデモ/スターター位置づけとし、永続共有ナレッジではないと割り切った)。
- Expert/Pro でのスターターデータ取込は DB 容量従量課金の対象 (UI で事前確認)。複数回取込は無制限だが容量 precheck が自然な歯止め。
- キュレーションで管理テナントの実データを誤ってサンプル化すると全テナントへ漏洩しうるため、super_admin 限定 + 警告 + `isSampleData=true` 厳格フィルタで防御。

---

## 実装 (一次ソース)

- 請求先: `tenant-onboarding.service.ts` (zod superRefine) / `src/app/(auth)/signup/page.tsx` / `tenant-self.service.ts` (changePlan ガード)
- 取込/削除: `sample-clone.service.ts` / `src/app/api/tenants/me/sample-data/route.ts` / tenant-settings-client `SampleDataSection`
- キュレーション: `sample-curation.service.ts` / `src/app/api/admin/super/seed-data/route.ts` / `src/app/(dashboard)/admin/super/seed-data/`
- 単一テナント化: `suggestion.service.ts` / `chat-search.service.ts` / `src/app/api/chat/search/route.ts`
- migration: `20260612_add_is_seed_sample_marker` / `20260613_drop_seed_data_enabled`
