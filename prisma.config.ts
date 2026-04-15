import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // ランタイム: DATABASE_URL（Supabase Pooler or ローカル PostgreSQL）
    // マイグレーション: DIRECT_URL が設定されていればそちらを使用
    url: process.env['DIRECT_URL'] || process.env['DATABASE_URL'],
  },
});
