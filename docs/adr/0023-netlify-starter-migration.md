# ADR-0023: Vercel Hobby → Netlify (Starter → Personal) 移行 (商用 TOS 違反の解消)

- **Status**: Accepted
- **Date**: 2026-05-18 (Starter 移行) / 2026-05-XX (Personal 昇格)
- **Deciders**: teppei
- **Supersedes**: [ADR-0012](./0012-vercel-supabase-mvp-hosting.md) のホスティング部分のみ (Supabase / Brevo / LLM 等の選定は不変)

> ファイル名は歴史的経緯で `0023-netlify-starter-migration.md` のままだが、Starter は短期間で credits 制約が顕在化したため、その後 **Netlify Personal ($9/seat/month)** に昇格している。本 ADR では「Vercel → Netlify (Starter 経由 → Personal)」の経緯と現状方針をまとめる。

---

## Context

[ADR-0012](./0012-vercel-supabase-mvp-hosting.md) で MVP 期インフラとして **Vercel Hobby + Supabase Free** を採用したが、運用開始後に以下の問題が顕在化:

1. **Vercel Hobby の商用利用禁止**: Vercel Hobby プランは [Terms of Service](https://vercel.com/legal/terms) 上「個人・非商用」専用と明記されている。本サービス (たすきば Knowledge Relay) は **Expert / Pro プランで課金を行う商用 SaaS** であり、Hobby プランでの本番運用は TOS 違反となる
2. **staging も同じ制約**: 「staging だけ Hobby で」という運用案も検討したが、Hobby TOS は環境を問わず適用されるため staging も TOS 違反
3. **Vercel Pro の費用**: $20/月/seat。同等費用帯の Netlify と比べ Next.js 統合以外の優位性が薄い
4. **6/1 正式リリース (Expert/Pro プラン課金開始) が間近**: TOS 違反のまま本番課金を始められない

## Decision

**2 段階で Netlify に移行**:

1. **2026-05-18: Netlify Starter (Free, 商用 OK)** へ初期移行 (Vercel TOS 違反を即時解消)
2. **その後: Netlify Personal ($9/seat/month)** へ昇格 (Starter の credits 300/月では Production deploy 約 20 回程度で逼迫、本番運用に不十分)

Vercel 依存機能 (Vercel Cron) は **外部 cron サービス (cron-job.org) で代替** する。

### 移行後の構成 (現行: Netlify Personal)

| レイヤ | 採用 | プラン | 月額 |
|---|---|---|---|
| アプリホスティング | **Netlify** | **Personal** ($9/seat/month) | **$9** |
| データベース | Supabase (PostgreSQL 16) | Free → 必要時に Pro | $0 |
| メール送信 | Brevo (旧 Sendinblue) | Free (300 通/日) → Pro | $0 |
| LLM | Anthropic Claude API | 従量課金 (テナント上限管理) | 従量 |
| Embedding | Voyage AI | 従量課金 | 従量 |
| ファイルストレージ | Supabase Storage | Free → Pro | $0 |
| **Cron Jobs (新規)** | **cron-job.org** (外部 HTTP cron) | **Free** | $0 |
| **合計** | — | — | **$9/月 + LLM/Voyage 従量** |

### cron アーキテクチャの変更

| 旧 (Vercel) | 新 (Netlify + 外部 cron) |
|---|---|
| `vercel.json` の `crons` セクションで宣言 | `cron-job.org` のダッシュボードで HTTP POST スケジュール設定 |
| Vercel ランタイムが内部 trigger | 外部 cron が `/api/cron/*` を `Authorization: Bearer <CRON_SECRET>` で叩く |
| Hobby は 1 日 1 回が最小間隔 | cron-job.org は 1 分間隔まで Free |
| 監視: Vercel ダッシュボード | 監視: `cron_execution_logs` テーブル + `cron-health.service.ts` |

**理由**: Netlify Scheduled Functions も選択肢にあったが、Function 呼び出し回数を消費する + デプロイサイズも増えるため、既存の `/api/cron/*` ルート (CRON_SECRET Bearer 認証済) を外部 cron で叩く方が軽量。

### Starter → Personal 昇格の判断

| 項目 | Starter (Free) | Personal ($9/seat/month) | Pro ($19/seat/month、参考) |
|---|---|---|---|
| **統合 credits** | 300/月 | **1,000/月** | 1,000/月 |
| **1 Production deploy 相当** | ≈ 15 credits | ≈ 15 credits | ≈ 15 credits |
| **月間 Production deploy 上限** | **約 20 回** | **約 65 回** | 約 65 回 |
| **Function 実行時間 (Sync)** | 10 秒 | **10 秒** | 26 秒 (configurable) |
| **Background Functions** | 利用不可 | **利用不可** | **利用可 (15 分)** |
| **Bandwidth** | credits 枠で消費 | credits 枠で消費 | credits 枠で消費 |
| **ロール / SSO** | 1 ロール | 1 ロール | role-based access |
| **追加機能** | — | Smart secret detection、1-day observability、Priority email support | + role-based access |

**Starter は実質 20 deploy/月**しかなく、PR ごとの検証 + 本番 deploy + hotfix を考えると **数日で枯渇**。MVP リリース直前の検証回数増加でこの制約が顕在化したため Personal へ昇格 (credits 1,000/月確保)。Pro は同 credits でさらに Background Functions と role-based access が追加されるが、現状 Bulk LLM 処理は 10 秒以内に分割実行で対応できているため Personal で十分。

### Netlify 固有機能の使用方針

| Netlify 機能 | 使用するか | 理由 |
|---|---|---|
| **Build & Deploy (Next.js Runtime)** | YES | コア要件 (`@netlify/plugin-nextjs` プラグイン) |
| **Deploy Previews** | YES | PR ごとに `https://deploy-preview-NNN--tasukiba.netlify.app` を自動発行、UAT に活用 |
| **Branch Deploys** | YES (限定的) | Stripe Webhook 固定先用 (`https://<branch>--tasukiba.netlify.app`) |
| **Edge Functions** | NO | Netlify Functions (Node ランタイム) で完結。Edge Runtime 必須の処理なし |
| **Netlify Forms** | NO | お問い合わせは HomePage (Astro) 側で別途処理 |
| **Netlify Identity** | NO | NextAuth.js で自前管理 ([ADR-0009](./0009-nextauth-credentials-mfa-totp.md)) |
| **Netlify Scheduled Functions** | NO | 上記の通り cron-job.org を採用 |
| **Background Functions (Pro 以上)** | 将来検討 | Personal では利用不可。Bulk LLM 処理を 10 秒超で扱う必要が出たら Pro 昇格と合わせて検討 |

## Consequences

### Positive

- **TOS 違反の解消**: 商用 SaaS として合法的に運用可能
- **Personal による余裕**: credits 1,000/月 (Production deploy 約 65 回/月相当) で本番運用に必要な検証 / hotfix 回数を確保
- **コスト効率**: Pro 同等の credits を $9 (Pro $19 の半額以下) で確保
- **cron 間隔の制約緩和**: cron-job.org は 1 分間隔まで Free (Vercel Hobby は 1 日 1 回最小)
- **PR ごとの Deploy Preview**: Stripe フローや UI 変更を本番影響なく検証可能
- **GitHub Public + Netlify** の組み合わせで GitHub Actions も無料・無制限 (Public リポ)

### Negative / Trade-off

- **月額 $9 の固定費が発生**: MVP 期の「$0/月運用」目標は終了。Netlify Personal $9 + 将来の Supabase/Brevo Pro 化分が積み上がる
- **vercel.json → netlify.toml + 外部 cron 二段構え**: 設定が 2 箇所に分散
- **cron-job.org への登録漏れリスク**: Vercel Cron なら vercel.json コミットで自動登録だったが、外部 cron は手動登録が必要 → 監視ロジック (`cron-health.service.ts` の `expectedMaxGapHours` チェック) を追加で対応 (memory: `feedback_cron_watchdog_pattern` で 2026-05-19 に事故事例)
- **Netlify Personal の制約**:
  - 1,000 credits/月 (Production deploy 約 65 回相当)。1 日 2 deploy ペースで月末に逼迫
  - Function timeout 10 秒固定 (configurable な 26 秒は Pro 以上限定)
  - **Background Functions 利用不可** (Pro 以上限定) — Bulk LLM 処理は 10 秒以内に分割実行で対応
  - Bandwidth は credits 枠で消費 (20 credits/GB)
- **Next.js とのシームレスさは Vercel に若干劣る**: `@netlify/plugin-nextjs` プラグインで概ねカバーできるが、新機能リリース時の追従が Vercel より遅い場合あり

### Risk / 留意事項

- **credits 監視**: `src/services/netlify-metrics.service.ts` で日次集計、`src/app/(dashboard)/admin/super/page.tsx` でリアルタイム可視化。70% で警告、90% で critical
- **本番 URL のドメイン**: `tasukiba.com` (2026-05-29 Cloudflare Registrar で取得、独自ドメイン移行済)。Preview/Branch deploy は `*--tasukiba.netlify.app` のまま維持
- **NEXTAUTH_URL の deploy context 同期**: Deploy Preview / Branch Deploy で URL が変わるため、`scripts/netlify-build.sh` 経由で deploy context に合わせて環境変数を注入 (詳細: [KDD §5.X+99 / §5.X+101](../knowledge/KDD_PATTERNS.md))
- **Netlify build skip 指定の罠**: コミット message / PR body に `[skip ci]` 系キーワードを書くと予期せぬスキップが起きる (memory: `feedback_netlify_build_skip`)
- **Bulk LLM 処理の 10 秒制約**: Personal は Background Functions 不可のため、長時間処理が必要になったら Pro 昇格 ($19/seat/month)

## Alternatives Considered

### Alt-1: Vercel Pro ($20/月) で続行
- メリット: 既存設定 (vercel.json + Vercel Cron) をそのまま使える、移行コストゼロ、Next.js 統合は Vercel が最良
- 不採用理由: (1) 価格帯が Netlify Personal の倍以上 ($20 vs $9) (2) 既に Netlify への移行作業が完了している (3) ベンダーロックインを進めるより、移行可能性を確保する方が中長期的に良い

### Alt-2: Netlify Starter のまま運用継続
- メリット: 月額 $0 維持
- 不採用理由: (1) credits 300/月 では Production deploy 約 20 回でしか持たない (2) MVP リリース直前 / 直後の検証 + hotfix で確実に逼迫する (3) Personal $9 のコストはたすきば 1 テナント (Expert/Pro プラン契約) で十分回収可能

### Alt-3: Netlify Pro ($19/seat/month) へ直接昇格
- メリット: Background Functions (15 分上限) 利用可、role-based access、Function timeout 26 秒へ拡大可
- 不採用理由: (1) 現状の Bulk LLM 処理は 10 秒以内分割で対応できている (2) Personal の倍以上のコスト ($19 vs $9) (3) credits 上限は同じ 1,000/月のため、deploy 回数の余裕は変わらない。将来 Bulk 処理要件が増えたら昇格検討

### Alt-4: AWS Amplify Hosting
- メリット: AWS 内で完結、将来の Lambda / RDS 移行と統一感
- 不採用理由: (1) 設定の学習コスト (2) コールドスタートの問題が Lambda 由来で発生しやすい (3) 個人開発の運用負荷が増える

### Alt-5: Cloudflare Pages
- メリット: 無料枠が広い、Edge 配信
- 不採用理由: (1) Next.js App Router の SSR は Cloudflare Pages では Workers Runtime 必須となり、Prisma + Node ランタイム前提のサービス層と整合しない (2) Workers の制約 (実行時間・メモリ) が読みづらい

### Alt-6: Render / Fly.io
- メリット: Docker ベースで柔軟、Free プラン (Render) あり
- 不採用理由: (1) Free プランの sleep (Render) / 制約が多い (2) Next.js 専用最適化 (image / static / ISR) が Netlify ほど洗練されていない

## Related

- 移行元の判断: [ADR-0012](./0012-vercel-supabase-mvp-hosting.md) (Vercel + Supabase を MVP 期に採用、本 ADR で Vercel 部分を Superseded)
- 詳細設計: [docs/design/INFRASTRUCTURE.md](../design/INFRASTRUCTURE.md)
- デプロイ手順: [docs/operations/DEPLOYMENT.md](../operations/develop/DEPLOYMENT.md)
- 環境変数一覧: [docs/operations/ENV_VARS.md](../operations/ENV_VARS.md)
- credits 監視: `src/services/netlify-metrics.service.ts` / `src/app/(dashboard)/admin/super/page.tsx`
- cron 監視設計: memory `feedback_cron_watchdog_pattern`
- Netlify build skip 罠: memory `feedback_netlify_build_skip`
- NEXTAUTH_URL deploy context 分離: [KDD §5.X+99 / §5.X+101](../knowledge/KDD_PATTERNS.md)
- 関連 memory: `project_vercel_decommissioned` (Vercel を選択肢から外す方針)
