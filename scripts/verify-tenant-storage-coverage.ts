/**
 * CI ガード: テナント計測対象テーブルの網羅性を検証 (ADR-0020 / 2026-05-25)
 *
 * 目的:
 *   旧 calculateTenantStorageBytes は SQL に 16 テーブル名をハードコードしていたため、
 *   新規 model 追加時に SQL 修正漏れで「計測されないテーブル」が発生する構造的欠陥があった (R1)。
 *
 *   本スクリプトは以下を検証:
 *     1. schema.prisma で `tenant_id` カラムを持つ model を列挙
 *     2. tenant-storage-tables.service.ts の JOIN_BASED_TABLES と組み合わせて全網羅
 *     3. 期待される @@map テーブル名と動的計測の到達範囲が一致するかをチェック
 *
 *   不一致なら exit 1 (CI fail) で merge を阻止する。
 *
 * 使い方:
 *   pnpm tsx scripts/verify-tenant-storage-coverage.ts
 *
 * CI 統合:
 *   .github/workflows/ci.yml のテストステップに `pnpm verify:storage-coverage` を追加する。
 *
 * 関連:
 *   - ADR: docs/adr/0020-db-capacity-usage-based-billing.md
 *   - 動的計測: src/services/tenant-storage-tables.service.ts
 *   - schema: prisma/schema.prisma
 *   - Memory: feedback_3layer_sync_filter.md (テナント関連フィルタの 3 レイヤ同期)
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JOIN_BASED_TABLE_NAMES } from '../src/services/tenant-storage-tables.service';

const SCHEMA_PATH = resolve(process.cwd(), 'prisma/schema.prisma');

type ModelDef = {
  modelName: string;
  tableName: string;
  hasTenantId: boolean;
};

/**
 * schema.prisma を parse して model 一覧を取得する。
 * - model 名 + `@@map("table_name")` から物理テーブル名を抽出
 * - tenant_id カラムの有無も判定
 */
function parsePrismaSchema(schemaContent: string): ModelDef[] {
  const models: ModelDef[] = [];
  const lines = schemaContent.split('\n');

  // line-by-line でブロック検出 (regex の greedy/multi-line 問題を回避)
  let currentModel: { name: string; bodyLines: string[] } | null = null;
  let braceDepth = 0;

  for (const line of lines) {
    const modelStart = line.match(/^model\s+(\w+)\s*\{/);
    if (modelStart) {
      currentModel = { name: modelStart[1]!, bodyLines: [] };
      braceDepth = 1;
      continue;
    }

    if (currentModel) {
      // brace 数で end of model 判定 (`}` 単独行 or `}` を含む行)
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      braceDepth += opens - closes;

      if (braceDepth <= 0) {
        // この line で model 終了。body 解析
        const body = currentModel.bodyLines.join('\n');
        const mapMatch = body.match(/@@map\(\s*"([^"]+)"\s*\)/);
        const tableName = mapMatch ? mapMatch[1]! : currentModel.name;
        const hasTenantId =
          /\btenantId\s+[A-Z]/.test(body) ||
          /@map\(\s*"tenant_id"\s*\)/.test(body) ||
          /\btenant_id\s+[A-Z]/.test(body);

        models.push({ modelName: currentModel.name, tableName, hasTenantId });
        currentModel = null;
        braceDepth = 0;
      } else {
        currentModel.bodyLines.push(line);
      }
    }
  }

  return models;
}

function main() {
  console.log('[verify-tenant-storage-coverage] Starting CI guard check...');

  const schemaContent = readFileSync(SCHEMA_PATH, 'utf-8');
  const models = parsePrismaSchema(schemaContent);

  console.log(`[verify-tenant-storage-coverage] Found ${models.length} models in schema`);

  // tenant_id 持ち model
  const directTenantModels = models.filter((m) => m.hasTenantId);
  const directTenantTableNames = directTenantModels.map((m) => m.tableName).sort();

  console.log(
    `[verify-tenant-storage-coverage] Direct tenant_id tables (${directTenantTableNames.length}):`,
  );
  for (const t of directTenantTableNames) console.log(`  - ${t}`);

  // JOIN ベース (= tenant_id を持たないが、親 model 経由で tenant に紐づく)
  console.log(
    `\n[verify-tenant-storage-coverage] JOIN-based tables in service (${JOIN_BASED_TABLE_NAMES.length}):`,
  );
  for (const t of JOIN_BASED_TABLE_NAMES) console.log(`  - ${t}`);

  // schema 上に JOIN_BASED_TABLES のテーブル名が存在することを確認
  const allTableNames = new Set(models.map((m) => m.tableName));
  const missingFromSchema = JOIN_BASED_TABLE_NAMES.filter((t) => !allTableNames.has(t));

  // JOIN_BASED_TABLES は意図的に tenant_id を持たない (= directTenantModels には含まれない想定)
  // 万一 tenant_id が生えた場合は重複集計のリスクがあるため警告
  const accidentallyDuplicated = JOIN_BASED_TABLE_NAMES.filter((t) =>
    directTenantTableNames.includes(t),
  );

  let hasError = false;

  if (missingFromSchema.length > 0) {
    console.error(
      `\n❌ ERROR: JOIN_BASED_TABLES に schema 未定義のテーブルが含まれます: ${missingFromSchema.join(', ')}`,
    );
    console.error(
      '  → tenant-storage-tables.service.ts の JOIN_BASED_TABLES を schema.prisma と整合させてください。',
    );
    hasError = true;
  }

  if (accidentallyDuplicated.length > 0) {
    console.error(
      `\n❌ ERROR: JOIN_BASED_TABLES と direct tenant_id テーブルが重複: ${accidentallyDuplicated.join(', ')}`,
    );
    console.error(
      '  → 動的計測で二重集計のリスクがあります。schema に tenant_id を追加した場合は JOIN_BASED_TABLES から削除してください。',
    );
    hasError = true;
  }

  // model 数のサニティチェック (40+ ある想定、極端に少ない場合は parse 失敗)
  if (models.length < 30) {
    console.error(
      `\n❌ ERROR: schema 解析で検出した model 数が少なすぎます (${models.length})。parse ロジックを確認してください。`,
    );
    hasError = true;
  }

  // tenant 所属 model 数のサニティ (= 20+ ある想定)
  if (directTenantTableNames.length + JOIN_BASED_TABLE_NAMES.length < 20) {
    console.error(
      `\n❌ ERROR: tenant 所属テーブル数が少なすぎます (direct=${directTenantTableNames.length}, join=${JOIN_BASED_TABLE_NAMES.length})。schema parse or JOIN_BASED_TABLES 定義を確認してください。`,
    );
    hasError = true;
  }

  if (hasError) {
    console.error('\n[verify-tenant-storage-coverage] FAILED');
    process.exit(1);
  }

  const total = directTenantTableNames.length + JOIN_BASED_TABLE_NAMES.length;
  console.log(
    `\n✅ [verify-tenant-storage-coverage] PASSED — ${total} tables covered (direct=${directTenantTableNames.length}, join=${JOIN_BASED_TABLE_NAMES.length})`,
  );
}

main();
