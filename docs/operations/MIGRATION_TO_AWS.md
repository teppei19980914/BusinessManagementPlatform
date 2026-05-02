# AWS / Azure / GCP への移行計画 (Operations)

本ドキュメントは、現状の Vercel + Supabase 構成から AWS / Azure / GCP への移行計画を集約する (DESIGN.md §34.13 を転記)。

---

### 34.13 インフラスケーラビリティと将来の移行計画

現状のインフラ (Vercel Hobby + Supabase Free) は試験運用段階での運用には十分だが、**外部ユーザ拡大に伴いいくつかの制約に直面する可能性** がある。本セクションでは、これらの制約と移行候補を整理する。

#### 34.13.1 Vercel の制約と回避策

Vercel Hobby プランの主要な制約は、Function 実行時間の上限 (Hobby: 10 秒、Pro: 60 秒、Enterprise: 900 秒) と、月間 Function 実行回数の制約である。提案エンジンは LLM 呼び出しと embedding 検索を含むため、Phase 3 の re-ranking では Anthropic API のレスポンス時間 (1〜3 秒) が乗ることで合計 4〜8 秒となり、10 秒上限の余裕は徐々に薄れる。

短期的な対策として、Vercel Pro プラン ($20/月) へのアップグレードで 60 秒上限を確保する。これは月数千円のコストだが、Function timeout エラーによるユーザ体験の悪化を確実に防ぐ。10 秒上限のままでは、ピーク時に処理が時間切れになる可能性が無視できない。

中期的な対策として、Edge Functions (Cloudflare Workers ベース、低レイテンシ) と Serverless Functions (Node.js、長時間処理向け) の使い分けを最適化する。LLM 呼び出しのような長時間処理は Serverless Functions に閉じ込め、軽量な GET リクエストは Edge に乗せることで、それぞれの強みを活かす。

長期的な視点として、ユーザが **数千〜数万人規模に達した場合** は、Vercel から AWS / Azure / GCP への移行を検討する余地がある。具体的には、Next.js の output mode を `standalone` に変更して Docker 化し、AWS ECS Fargate / Azure Container Apps / Google Cloud Run のいずれかにデプロイする選択肢がある。これらの選択肢は Function 実行時間の制約がなく、必要に応じて instance の縦・横スケールが可能。コストは Vercel より低く抑えられる場合があるが、運用負荷は増す。

#### 34.13.2 Supabase の制約と移行候補

Supabase Free プランの主要な制約は、データベースサイズ (500MB)、月間 API 呼び出し数 (50,000 / 月)、同時接続数 (60)、月間帯域 (5GB) である。提案エンジンの embedding カラムは 1 行あたり 6KB と大きく、テナント数が増えると 500MB 上限に到達する可能性がある。100 テナント × 平均 1000 entity × 6KB = 600MB と、Free 枠を超える試算になる。

短期的な対策として、Supabase Pro プラン ($25/月) で 8GB のデータベースサイズに拡大する。これでも数千テナント規模までは余裕が生まれる。

中期的には、AWS RDS for PostgreSQL に移行する選択肢がある。Supabase の独自機能 (Auth、Realtime、Storage) を本サービスがほとんど使っていないため、移行の障壁は低い。RDS なら 1TB 規模のデータベースを月数十ドルで運用でき、IOPS の調整も柔軟である。

#### 34.13.3 移行判断のトリガー条件

インフラ移行は早すぎても遅すぎてもコストになる。以下を **移行検討のトリガー** として記録しておく。

第一に、月次の Vercel Function timeout エラー率が 1% を超えた場合。これはユーザが「ロードが終わらない」体験をする頻度を意味し、サービス品質の悪化シグナルとなる。

第二に、Supabase データベースサイズが Free / Pro プランの 80% に達した場合。これは数ヶ月以内に上限到達することを意味し、移行を計画する時間的余裕を確保する。

第三に、月間 Anthropic / Voyage の API 利用料が $100 を超えた場合。これはサービスが事業として成立する規模に達したことを意味し、より柔軟なインフラへの投資を正当化する。

第四に、ユーザから「動作が遅い」というフィードバックが構造的に集まった場合。これは単一の指標ではなく総合的な判断だが、最も重要なトリガーである。

#### 34.13.4 移行時のコード変更ポイント

本サービスのアーキテクチャは、現時点で **インフラに対する依存をほぼコード化していない** ため、移行コストは比較的低い。具体的には、Prisma が DB プロバイダを抽象化しており、PostgreSQL 互換 DB への移行は接続文字列の変更で完結する。Next.js のサーバランタイムも `output: 'standalone'` で Docker 化可能で、Vercel 依存の API (例: `@vercel/cron`) は標準の cron に置き換える程度の変更で対応できる。

移行時の主な作業は、環境変数の再設定、Docker image の構築、CI/CD パイプラインの再構築 (GitHub Actions → AWS / Azure)、監視・ログの再設定 (Vercel Analytics → CloudWatch / Application Insights) である。実工数は 1〜2 週間と見込む。

これらは将来の判断材料として記録するが、v1 リリース時点ではすべて Vercel + Supabase で運用する。本格的な事業拡大段階で判断する。

