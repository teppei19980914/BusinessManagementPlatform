# ADR-0012: Vercel + Supabase 無料枠を MVP 期のインフラに採用 (AWS 移行を視野)

- **Status**: **Superseded by [ADR-0023](./0023-netlify-starter-migration.md)** (2026-05-18 に Vercel Hobby の商用 TOS 違反を解消するため Netlify Starter へ移行、その後 credits 制約により Netlify Personal へ昇格)
- **Date**: 2026-04 (インフラ選定時)
- **Deciders**: teppei

> ⚠️ **本 ADR の Vercel 採用部分は ADR-0023 で Superseded されています。** 2026-05-18 に Netlify Starter (商用利用 OK) へ移行し、その後 credits 制約のため Netlify Personal ($9/seat/month) へ昇格済。
> 本文の Vercel 関連記述は当時の判断記録として保持しますが、現行構成については [ADR-0023](./0023-netlify-starter-migration.md) を参照してください。
> Supabase / Brevo / LLM / Embedding / Storage の選定は本 ADR のまま有効です。

---

## Context

MVP 期 (2026/04 開発開始 〜 2026/06 外部公開 〜 数ヶ月) のインフラ選定にあたり、以下の制約があった:

- **初期コストはゼロ円が望ましい**: ユーザがまだいない / 少ない段階で月額費用が発生すると、収益化前の固定コストが圧迫
- **個人 / 少人数開発の運用負荷を最小化**: SRE 専任者がいないため、サーバ管理 / ネットワーク / セキュリティパッチ等を自前で運用するのは避けたい
- **Next.js (App Router) との整合性**: SSR / API Routes / Edge runtime / image optimization 等の機能を最大活用したい
- **PostgreSQL が必要**: pgvector / JSONB / 全文検索の理由から ([ADR-0004](./0004-postgresql-prisma.md))
- **将来の AWS / Azure 移行余地**: 規模拡大時 (テナント 100+ 等) に独立性の高いインフラへ移行できる構成
- **本サービスの差別化点に集中したい**: インフラ運用に時間を取られず、提案エンジン / UX の磨き込みにリソース投入したい

## Decision

**Vercel (アプリ) + Supabase (PostgreSQL) の無料枠** で MVP 期を運用する。
ただし、**Supabase / Vercel 固有機能には依存しない**設計とし、将来の移行を可能にする。

### 構成

| レイヤ | 採用 | プラン |
|---|---|---|
| アプリホスティング | Vercel | Hobby (Free) → 商用化時に Pro |
| データベース | Supabase (PostgreSQL 16) | Free → 必要時に Pro |
| メール送信 | Brevo (旧 Sendinblue) | Free (300 通/日) → Pro |
| LLM | Anthropic Claude API | 従量課金 (テナント上限管理) |
| Embedding | Voyage AI | 従量課金 |
| ファイルストレージ | Supabase Storage | Free → Pro |
| キャッシュ / Queue | (現状未使用) | 将来 Upstash Redis 検討 |

### 固有機能の使用方針

| Supabase 機能 | 使用するか | 理由 |
|---|---|---|
| **PostgreSQL** | YES | コア要件 |
| **Storage** | YES (限定的) | アバター / 添付ファイル。S3 互換 API のため AWS S3 への移行容易 |
| **Auth** | NO | NextAuth.js で自前管理 ([ADR-0009](./0009-nextauth-credentials-mfa-totp.md)) |
| **Row Level Security (RLS)** | NO (PHASE 2 で検討) | アプリ層認可で完結 ([ADR-0005](./0005-rbac-two-stage-tenant-authorization.md)) |
| **Realtime (subscription)** | NO | サービス要件に存在しない |
| **Edge Functions** | NO | Vercel Edge Runtime で代替 |
| **Database Webhooks** | NO | アプリ側の cron で代替 |

| Vercel 機能 | 使用するか | 理由 |
|---|---|---|
| **Hosting / Serverless Functions** | YES | コア要件 |
| **Cron Jobs** | YES | 月初バッチ / 日次集計に使用 (Hobby は日次以下のみ。memory: feedback_vercel_cron_hobby_limit) |
| **Image Optimization** | YES | Next.js Image 標準機能 |
| **Edge Middleware** | YES (限定的) | 認証セッション確認のみ。複雑な認可は Service 層 |
| **KV / Postgres** | NO | Supabase に集約 |
| **Blob Storage** | NO | Supabase Storage に集約 |

## Consequences

### Positive
- **MVP 期の月額コスト ¥0** (LLM/Voyage の従量分を除く): 収益化前の固定コストを完全排除
- **運用負荷ほぼゼロ**: SSL / セキュリティパッチ / バックアップ / スケーリングが自動
- **開発速度の最大化**: インフラ構築に時間を取られず、機能開発に集中
- **Next.js とのシームレスな統合**: Vercel は Next.js の開発元 (Vercel Inc.) であり、新機能リリース時の追従が早い
- **DB の管理が容易**: Supabase Dashboard で GUI 操作 (migration / ロール / バックアップ)

### Negative / Trade-off
- **無料枠の制約**:
  - Supabase Free: 500MB DB / 1GB Storage / 50,000 monthly active users / 2GB egress / **1 週間アクセスなしで自動 pause**
  - Vercel Hobby: 100GB bandwidth / **cron は日次以下のみ** (毎日 03:00 UTC 等)
  - Brevo Free: 300 通/日
- **Vercel Hobby のクーリエ制約**: cron 最短間隔が日次のため、リアルタイム処理 (5 分 / 1 時間ごとの集計等) は不可
- **ベンダーロックインリスク**: Supabase / Vercel が値上げ・サービス終了する可能性
- **Pro プラン移行時の費用**: Supabase Pro = $25/月、Vercel Pro = $20/月、Brevo Pro = ~$25/月 (合計月 ~$70 = ~¥10,000)。テナント数が増えてからの判断
- **Supabase Free の自動 pause**: 1 週間ユーザアクセスがないと DB が pause。ステージング環境で起こりやすい

### Risk / 留意事項
- **DB 容量の継続モニタリング**: `db-capacity.service.ts` で日次チェック、500MB の 80% (400MB) でアラート ([INCIDENT_RESPONSE.md §6.9](../operations/INCIDENT_RESPONSE.md))
- **Pro プラン移行のトリガ条件を事前に決めておく**: 例「DB 容量 400MB 到達」「MAU 30,000 到達」「Vercel bandwidth 80GB 到達」のいずれかでアップグレード
- **AWS / Azure 移行計画**: [docs/operations/MIGRATION_TO_AWS.md](../operations/MIGRATION_TO_AWS.md) に予備計画を文書化済。実行は規模拡大後
- **本番障害時の対応**: Supabase / Vercel 全停止時の対処 ([INCIDENT_RESPONSE.md §6.9](../operations/INCIDENT_RESPONSE.md))

## Alternatives Considered

### Alt-1: AWS (ECS Fargate + RDS + S3) で MVP 期から運用
- 概要: 業界標準のクラウドインフラ
- メリット: スケーラビリティ / 機能網羅性 / ベンダーロックインの希薄化
- 不採用理由: (1) 初期コストが月 $30-50 程度発生 (RDS db.t4g.micro + ECS + ALB) (2) インフラ運用負荷が個人開発には過大 (3) MVP 期にスケーラビリティは不要 (4) Next.js 統合は Vercel が圧倒的に優位

### Alt-2: Cloudflare Pages + D1 / R2
- 概要: Cloudflare のサーバレス + SQLite ベース DB + S3 互換 storage
- メリット: 無料枠が広い、Edge 配信
- 不採用理由: (1) D1 (SQLite) は pgvector / JSONB / 全文検索の要件と整合しない (2) Next.js App Router の SSR は Cloudflare Pages では制約あり (3) コミュニティが Vercel ほど成熟していない

### Alt-3: 自前 VPS (Hetzner / Vultr / DigitalOcean)
- 概要: 月 $5-10 の VPS で Docker Compose で全部建てる
- メリット: コスト最小、完全な制御権
- 不採用理由: (1) セキュリティパッチ / SSL / バックアップ / 監視を自前運用するコストが個人開発に見合わない (2) 障害時の復旧が完全に自己責任 (3) スケーラビリティの自動化なし

### Alt-4: Heroku
- 概要: PaaS の老舗
- メリット: シンプルな運用
- 不採用理由: (1) Free プラン廃止済 ($5/月〜) (2) Next.js 統合は Vercel に大きく劣る (3) DB add-on のコストが高い

## Related

- 詳細設計: [docs/design/INFRASTRUCTURE.md](../design/INFRASTRUCTURE.md)
- AWS 移行計画: [docs/operations/MIGRATION_TO_AWS.md](../operations/MIGRATION_TO_AWS.md)
- 環境変数一覧: [docs/operations/ENV_VARS.md](../operations/ENV_VARS.md)
- Vercel Cron 制約: memory `feedback_vercel_cron_hobby_limit`
- DB 選定: [ADR-0004](./0004-postgresql-prisma.md)
- 認証: [ADR-0009](./0009-nextauth-credentials-mfa-totp.md) (Supabase Auth 不採用の理由)
- 認可: [ADR-0005](./0005-rbac-two-stage-tenant-authorization.md) (RLS 不採用の理由)
- インシデント対応 (Supabase 全停止): [docs/operations/INCIDENT_RESPONSE.md §6.9](../operations/INCIDENT_RESPONSE.md)
