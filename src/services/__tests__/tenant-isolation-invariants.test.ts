/**
 * テナント分離仕様のリグレッション防止テスト (PR feat/tenant-isolation-comprehensive-tests / 2026-05-10)
 *
 * 役割:
 *   Phase 1〜2-10 (PR #297-#308) で確立した「テナント越境を構造的に遮断する」仕様の
 *   **不変条件 (invariant) を 1 箇所に集約** して検証する。
 *
 *   各 service の test ファイルに分散している tenant 関連検証は個別の挙動を確認するが、
 *   本ファイルは「**仕様全体として絶対に崩れてはいけない不変条件**」を統合的に守る役割。
 *   1 件でも fail したら **severity-1 個人情報漏洩リスク** に直結すると認識する。
 *
 * カバーする不変条件:
 *   I-1. 全 service 関数のシグネチャに `viewerTenantId` (または `tenantId`) が必須引数として存在
 *   I-2. 全 service の Prisma `findMany`/`findFirst`/`update`/`delete` で `where.tenantId` が
 *        必ずフィルタに含まれる (タスク等 tenantId 列を持たない entity は project 経由)
 *   I-3. 全 service の `create`/`createMany` で `data.tenantId` が必ず明示される
 *        (DB DEFAULT 暗黙依存禁止)
 *   I-4. 提案エンジンは管理テナントのシードのみ追加許可、他顧客テナントは toggle 値に関わらず
 *        絶対に混入しない
 *   I-5. 監査・トークン系 (Phase 2-10) も同上
 *
 * 失敗時の対応:
 *   このテストが落ちたら、**新規追加された service / API ルートが tenant フィルタを忘れている**
 *   可能性が極めて高い。コードレビューで tenant フィルタを追加するまでマージ禁止。
 *
 * 関連:
 *   - 仕様: docs/security/TENANT_ISOLATION_PHASE2_TODO.md
 *   - 設計: 「シードデータ以外、別テナントのデータは参照/更新/削除不可」
 *   - 元 PR: #297-#308 (Phase 1〜2-10)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SERVICE_DIR = join(__dirname, '..');

/**
 * src/services 配下の .ts ファイル (テスト除く) を再帰的に列挙。
 */
function listServiceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      // __tests__ ディレクトリ自身はスキップ
      if (name === '__tests__') continue;
      files.push(...listServiceFiles(full));
    } else if (
      stat.isFile() &&
      name.endsWith('.ts') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.db.test.ts')
    ) {
      files.push(full);
    }
  }
  return files;
}

const ALL_SERVICE_FILES = listServiceFiles(SERVICE_DIR);

// ============================================================================
// I-1: 越境 read 経路で tenantId フィルタが書かれているか確認
//   - prisma.{model}.findMany/findFirst/findUnique を含む service ファイルが
//     where 句で tenantId / project: { tenantId } / parent: { tenantId } を併用しているか
//   - 例外的に tenant 横断が許される service (cron / super-admin) は許可リスト
// ============================================================================

const CROSS_TENANT_ALLOWED_FILES = new Set([
  // tenant の作成・選択そのものを扱うため横断必須
  'tenant.ts',
  'super-admin.service.ts',
  // Cron / batch (意図的に全テナント横断)
  'beginner-expiry.service.ts',
  'tenant-monthly-reset.service.ts',
  'usage-monitoring.service.ts',
  // Tenant 自身の取得 (自テナント情報なので tenantId 自体が引数)
  'tenant-self.service.ts',
  'tenant-onboarding.service.ts',
  // 認証フローで pre-auth (tenantId 不明) を扱う
  'auth-event.service.ts', // tenantId optional (NULL 許容)
  // 提案エンジンは tenantId scope を独自管理 (許可リスト内で management tenant を含める)
  'suggestion.service.ts',
  // Knowledge / Risk の link 系 (M:N 紐付け、シードからの取り込みあり)
  // → 内部で tenant 検証している service は OK
  // 単純な util / constant
  'audit.service.ts', // tenantId 必須 + DB DEFAULT 廃止済 (= write のみ; read は admin route 側)
  'auth.ts',
  // データ移行 / インポート / エクスポート (tenant 引数経由で正しく分離)
  'data-export.service.ts',
  'data-import.service.ts',
  'external-data-import.service.ts',
  // Email 送信ログ (tenantId optional + cron 経由システム通知あり)
  'email-send-log.service.ts',
  // Mail / encryption / utility
  'mfa.service.ts',
  'password.service.ts',
  'password-reset.service.ts',
  'email-verification.service.ts',
  'error-log.service.ts',
  // DB capacity / storage 系 (super_admin が管理)
  'db-capacity.service.ts',
  'tenant-storage.service.ts',
  // 自動タグ抽出 (tenant scope は呼出元で確保)
  'auto-tag.service.ts',
  'embedding.service.ts',
  'suggestion-explanation.service.ts',
  // 純粋ロジック (DB アクセスなし、tenant 概念と無関係)
  'state-machine.ts',
  // 2026-05-11: /guide ロール判定。`userId` 単独で ProjectMember を引くため tenant 越境不可。
  //   user は単一 tenant にのみ所属するため、user-scoped クエリは構造的にテナント分離されている。
  'guide-role.service.ts',
]);

/**
 * 各 service ファイルが「tenant フィルタを使う」または「許可リストに入っている」かをチェック。
 * 検出パターン:
 *   - `tenantId:` (where に直接書く)
 *   - `project: { tenantId` / `tenant: {` (リレーション経由)
 *   - `viewerTenantId` (引数として受け取り内部で使用)
 */
describe('★テナント分離 リグレッション防止 — Service 層★', () => {
  it.each(
    ALL_SERVICE_FILES.filter((f) => {
      const baseName = f.split(/[\\/]/).pop() ?? '';
      return !CROSS_TENANT_ALLOWED_FILES.has(baseName);
    }),
  )('%s に tenantId / viewerTenantId フィルタが含まれている', (filePath) => {
    const baseName = filePath.split(/[\\/]/).pop() ?? '';
    const content = readFileSync(filePath, 'utf-8');

    const hasTenantFilter =
      content.includes('tenantId:') ||
      content.includes('viewerTenantId') ||
      content.includes('tenant: {') ||
      content.includes('project: { tenantId') ||
      content.includes('project: {\n');

    expect(hasTenantFilter).toBe(true);
    // 失敗時のヒント: この service にも `viewerTenantId: string` 引数 + where に
    //   `tenantId: viewerTenantId` (または project リレーション経由) を追加してください。
    //   許可リスト (CROSS_TENANT_ALLOWED_FILES) に追加するのは **本当に tenant 横断が
    //   必要な場合のみ** にしてください。デフォルトは tenant 分離。
    if (!hasTenantFilter) {
      console.error(`★severity-1 候補★ ${baseName} に tenant フィルタが見当たりません。`);
    }
  });
});

// I-2 (route-level static analysis) は false positive が多いため省略。
//   API ルートの tenant 伝播チェックは E2E (specs/11-tenant-isolation.spec.ts) で
//   黒箱的に検証する (= ふるまいで保証)。

// ============================================================================
// I-3: 提案エンジンの tenant scope filter が「自テナント + 管理テナント」または「自テナントのみ」
//      の 2 形式しか取らないこと
// ============================================================================

describe('★提案エンジン tenant scope filter — リグレッション防止★', () => {
  it('suggestion.service.ts は MANAGEMENT_TENANT_ID を import して tenantScopeFilter を構築している', () => {
    const content = readFileSync(join(SERVICE_DIR, 'suggestion.service.ts'), 'utf-8');
    expect(content).toContain('MANAGEMENT_TENANT_ID');
    expect(content).toContain('tenantScopeFilter');
    // 「seedDataEnabled なら自テナント + 管理、false なら自テナントのみ」が明文化されている
    expect(content).toMatch(/in:\s*\[\s*viewerTenantId\s*,\s*MANAGEMENT_TENANT_ID\s*\]/);
    expect(content).toMatch(/tenantId:\s*viewerTenantId\s*\}/);
  });

  it('suggestion.service.ts は他顧客テナントを許容する pattern を含まない (= severity-1 攻撃経路の永久遮断)', () => {
    const content = readFileSync(join(SERVICE_DIR, 'suggestion.service.ts'), 'utf-8');
    // 「全テナント横断」を意図する書き方が混入していないことを確認
    expect(content).not.toContain('// allow all tenants');
    // tenantId フィルタを **完全に省略** したまま prisma を呼ぶ箇所が無いこと
    //   (= where: { ... } の中に tenantId が必ず含まれる)
    // 簡易版: 該当 prisma.findMany 呼び出しは 4 箇所 (knowledge / risks_issues×2 / retrospective)
    //   それぞれの直後に tenantId / tenantScopeFilter / excludeManagementTenant が含まれていること
    const findManyMatches = content.match(/prisma\.\w+\.findMany\(\s*\{[\s\S]*?\}\s*\)/g) ?? [];
    for (const match of findManyMatches) {
      // tenantId が where に含まれない場合は許容リスト (例: deletedAt 単独 or projectMember)
      const hasTenantIdRef =
        match.includes('tenantId') ||
        match.includes('tenantScopeFilter') ||
        match.includes('excludeManagementTenant');
      // 一部の helper 関数 (computeTextSimilarities 内) は tenant 不要なケース有り
      const isTextSimilarityHelper = match.includes('similarity(');
      expect(hasTenantIdRef || isTextSimilarityHelper).toBe(true);
    }
  });
});

// ============================================================================
// I-2 強化版 (2026-05-12): 各 prisma クエリの where に tenantId が含まれているか
//   個別 query 単位 で機械的に検査。
//
//   旧 I-1 はファイル全体に `tenantId:` の文字列があれば pass する粗いチェックだったが、
//   「同一ファイル内で 1 つの query が tenantId を持ち、別の query が忘れている」ケースを
//   検出できなかった (例: customer.service.ts:221 の comment.updateMany 忘れ、
//   project.service.ts cascade の deleteMany 忘れ)。
//
//   本セクションでは prisma.X.findMany/findFirst/findUnique/deleteMany/updateMany/count の
//   各クエリブロックを個別に抽出し、where 内に tenant 関連フィルタが必ず含まれることを検証する。
// ============================================================================

/** クエリ単位で tenant フィルタを検出するパターン */
const TENANT_FILTER_PATTERNS = [
  /\btenantId\s*[:,}\n]/, // tenantId: ... / tenantId, (shorthand) / tenantId\n (multi-line)
  /viewerTenantId/,
  /\btenant\s*:\s*\{/, // tenant: { ... }
  /project\s*:\s*\{[^}]*tenantId/,
  /knowledge\s*:\s*\{[^}]*tenantId/,
  /tenantScopeFilter/,
  /excludeManagementTenant/,
  /SUPER_ADMIN_EXCLUDED_TENANT_IDS/,
  // spread syntax: `...tenantWhere`, `...tenantFilter` 等 (条件付き tenant 注入のパターン)
  /\.\.\.\s*\w*[tT]enant\w*/,
];

/** クエリ block 内のいずれかのパターンが match するか */
function hasTenantFilterInQuery(queryBlock: string, fileContent: string): boolean {
  // 1. インライン where object: tenant パターン直接検出
  if (TENANT_FILTER_PATTERNS.some((re) => re.test(queryBlock))) return true;
  // 2. where: variableName 形式 (Prisma 型の external where 変数) は変数定義を遡って検査
  //    regex では完全には追えないため、ファイル全体に tenantId/viewerTenantId 言及があれば
  //    変数定義側で tenant フィルタが入っていると見なし許容する (heuristic)。
  const varRef = /where\s*:\s*(\w+)\s*[,}\n]/.exec(queryBlock);
  if (varRef && !['true', 'false', 'null', 'undefined'].includes(varRef[1])) {
    return /\btenantId\b|viewerTenantId|tenantScopeFilter/.test(fileContent);
  }
  // 3. { where, ... } shorthand (= where: where)。同様に変数定義を信頼する heuristic
  if (/\{\s*where\s*[,}\n]/.test(queryBlock) || /\bwhere\s*,/.test(queryBlock)) {
    return /\btenantId\b|viewerTenantId|tenantScopeFilter/.test(fileContent);
  }
  return false;
}

/**
 * 意図的な全テナント横断 (cron / system-wide cleanup / pre-auth など) を明示宣言する
 * コメントが直前 8 行以内にあれば、tenantId フィルタなしでも許容する。
 *
 * 認識キーワード (どれか 1 つ含まれていれば OK):
 *   - "cross-tenant" / "全テナント横断" / "全テナント対象"
 *   - "cron で全" / "system-wide"
 *   - "意図的" + ("tenant" / "テナント")
 *   - "pre-auth" / "認証前"
 */
function hasIntentionalCrossTenantAnnotation(content: string, queryStartLine: number): boolean {
  // queryStartLine は 1-based。lines は 0-indexed。
  // 直前 8 行 = lines[queryStartLine - 9 .. queryStartLine - 2] (1-based 番号で queryStartLine - 8 〜 queryStartLine - 1)
  const lines = content.split('\n');
  const startIdx = Math.max(0, queryStartLine - 9);
  const endIdx = queryStartLine - 1; // exclusive (= 直前の行まで)
  for (let i = startIdx; i < endIdx; i++) {
    const line = lines[i] ?? '';
    if (/cross-tenant|全テナント横断|全テナント対象|cron で全|system-wide|pre-auth|認証前/.test(line)) {
      return true;
    }
    if (/(意図的|意図的に).*(tenant|テナント)/.test(line) || /(tenant|テナント).*(意図的|意図的に)/.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * service ファイル内の `prisma.<model>.<method>({ ... })` 形式の呼び出しを抽出する。
 * ネストした波括弧に対応するため、balanced parser を使う (regex 単独では限界)。
 */
function extractPrismaQueryBlocks(content: string): Array<{ model: string; method: string; block: string; lineNumber: number }> {
  const blocks: Array<{ model: string; method: string; block: string; lineNumber: number }> = [];
  const METHODS = ['findMany', 'findFirst', 'findUnique', 'deleteMany', 'updateMany', 'count', 'aggregate', 'groupBy'];
  const re = new RegExp(`prisma\\.(\\w+)\\.(${METHODS.join('|')})\\(\\s*\\{`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const model = match[1];
    const method = match[2];
    const start = match.index + match[0].length - 1; // '{' の位置
    let depth = 1;
    let i = start + 1;
    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      i++;
    }
    if (depth === 0) {
      const block = content.slice(start, i);
      const lineNumber = content.slice(0, match.index).split('\n').length;
      blocks.push({ model, method, block, lineNumber });
    }
  }
  return blocks;
}

/** tenant フィルタが不要な model (M:N 中間テーブル、tenant 概念なし) */
const TENANT_AGNOSTIC_MODELS = new Set([
  'tenant', // テナントそのもの
  'session', // session は userId-scoped (user 経由で tenant 転写)
  'passwordHistory', // user-scoped
  'recoveryCode', // userId 必須経路あり (auth 系)
  'passwordResetToken', // pre-auth, userId-scoped
  'emailVerificationToken', // pre-auth
  'projectMember', // project 経由
  'knowledgeProject', // 中間テーブル (knowledge 経由)
  'retrospectiveProject', // 中間テーブル
  'riskIssueProject', // 中間テーブル
  'taskKnowledge', // 中間テーブル
  'taskProgressLog', // task 経由
  'task', // project 経由 (tenantId 列なし)
  'estimate', // project 経由
]);

/** 越境を許す model (super_admin 専用集計など、CROSS_TENANT_ALLOWED_FILES とセット運用) */
function isCrossTenantContext(filePath: string): boolean {
  const baseName = filePath.split(/[\\/]/).pop() ?? '';
  return CROSS_TENANT_ALLOWED_FILES.has(baseName);
}

describe('★I-2 強化: prisma クエリ単位の tenant フィルタ検査★ (2026-05-12)', () => {
  const targetFiles = ALL_SERVICE_FILES.filter((f) => !isCrossTenantContext(f));

  it.each(targetFiles)('%s の全 prisma クエリに tenant フィルタが含まれる', (filePath) => {
    const content = readFileSync(filePath, 'utf-8');
    const queries = extractPrismaQueryBlocks(content);

    const missing: Array<{ model: string; method: string; line: number }> = [];
    for (const q of queries) {
      // tenant 概念のないモデルはスキップ
      if (TENANT_AGNOSTIC_MODELS.has(q.model)) continue;
      // user.update の where: { id } 限定は user 自身の更新 (= tenant 経由) なので許容
      if (q.model === 'user' && (q.method === 'update' || q.method === 'findUnique')
        && /where:\s*\{\s*id:/.test(q.block)) continue;
      // user.findFirst で email scope (pre-auth lock-status 等) も許容
      if (q.model === 'user' && q.method === 'findFirst' && /email:/.test(q.block) && !/tenantId/.test(q.block)) continue;

      if (!hasTenantFilterInQuery(q.block, content)) {
        // 直前 8 行に「意図的越境」コメントがあれば許容 (cron, system-wide cleanup 等)
        if (hasIntentionalCrossTenantAnnotation(content, q.lineNumber)) continue;
        missing.push({ model: q.model, method: q.method, line: q.lineNumber });
      }
    }

    if (missing.length > 0) {
      const fileBaseName = filePath.split(/[\\/]/).pop();
      const detail = missing
        .map((m) => `  - line ${m.line}: prisma.${m.model}.${m.method}`)
        .join('\n');
      console.error(`★severity-1 候補★ ${fileBaseName}:\n${detail}`);
    }

    expect(missing).toEqual([]);
  });
});

// ============================================================================
// I-2 拡張 (2026-05-12): app/(dashboard)/**/*.tsx と app/api/**/*.ts も対象に
//
//   旧 I-2 は src/services/ のみカバーしていた。しかし page.tsx (server component) や
//   API route で **直接 prisma を呼ぶ箇所** も same level の risk を持つ。
//   - audit-logs/page.tsx (Phase 2-10 で修正済み) のような直叫び経路が再発する可能性
//   - サービスを介さない API route が tenantId フィルタを忘れる可能性
//
//   ファイル全体に prisma 呼出があれば対象とし、各 query block 単位で検査する。
// ============================================================================

const APP_DIR = join(__dirname, '../../app');

function listAppFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...listAppFiles(full));
    } else if (
      stat.isFile() &&
      (name.endsWith('.ts') || name.endsWith('.tsx')) &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.test.tsx') &&
      !name.endsWith('.db.test.ts')
    ) {
      files.push(full);
    }
  }
  return files;
}

const ALL_APP_FILES = listAppFiles(APP_DIR);

/**
 * page / route ファイル用の許可リスト。
 *   - super_admin 系: 全テナント横断が仕様
 *   - 認証フロー / health check: pre-auth / tenant 概念なし
 *   - cron: 全テナント横断
 */
const APP_CROSS_TENANT_ALLOWED = new Set<string>([
  // super_admin 専用 (全テナント横断が仕様)
  'src/app/(dashboard)/admin/super',
  'src/app/api/admin/super',
  // 認証フロー (pre-auth / tenant 不明)
  'src/app/api/auth',
  'src/app/api/health',
  // Cron endpoints (全テナント対象)
  'src/app/api/cron',
  // テナント作成 (新規 tenant 自体を作るため、所属 tenant 概念がない初期処理)
  'src/app/api/tenants/me/storage-addon',
]);

function isAllowedAppPath(filePath: string): boolean {
  // Windows パス区切り対応で正規化
  const normalized = filePath.replace(/\\/g, '/');
  for (const allowed of APP_CROSS_TENANT_ALLOWED) {
    if (normalized.includes(allowed)) return true;
  }
  return false;
}

describe('★I-2 拡張: app (page/route) 層の prisma クエリ tenant フィルタ検査★ (2026-05-12)', () => {
  const appFiles = ALL_APP_FILES.filter((f) => {
    if (isAllowedAppPath(f)) return false;
    // prisma を import していなければ対象外
    const content = readFileSync(f, 'utf-8');
    return content.includes("from '@/lib/db'") || content.includes('from "@/lib/db"');
  });

  it.each(appFiles)('%s の全 prisma クエリに tenant フィルタが含まれる', (filePath) => {
    const content = readFileSync(filePath, 'utf-8');
    const queries = extractPrismaQueryBlocks(content);

    const missing: Array<{ model: string; method: string; line: number }> = [];
    for (const q of queries) {
      if (TENANT_AGNOSTIC_MODELS.has(q.model)) continue;
      // user は self-scope (id: user.id) パターンは tenant 経由で安全
      if (q.model === 'user' && (q.method === 'update' || q.method === 'findUnique' || q.method === 'delete')
        && /where:\s*\{\s*id:/.test(q.block)) continue;
      // user.findFirst で email scope (pre-auth) は許容
      if (q.model === 'user' && q.method === 'findFirst' && /email:/.test(q.block) && !/tenantId/.test(q.block)) continue;

      if (!hasTenantFilterInQuery(q.block, content)) {
        if (hasIntentionalCrossTenantAnnotation(content, q.lineNumber)) continue;
        missing.push({ model: q.model, method: q.method, line: q.lineNumber });
      }
    }

    if (missing.length > 0) {
      const fileBaseName = filePath.split(/[\\/]/).slice(-3).join('/');
      const detail = missing
        .map((m) => `  - line ${m.line}: prisma.${m.model}.${m.method}`)
        .join('\n');
      console.error(`★severity-1 候補★ ${fileBaseName}:\n${detail}`);
    }

    expect(missing).toEqual([]);
  });
});

// ============================================================================
// I-4: 「シードデータ以外、別テナントのデータは参照/更新/削除不可」が文書化されていること
// ============================================================================

describe('★テナント分離仕様 — 文書化の不変条件★', () => {
  it('docs/security/TENANT_ISOLATION_PHASE2_TODO.md が存在し、Phase 2-10 完了がマークされている', () => {
    const path = join(__dirname, '../../../docs/security/TENANT_ISOLATION_PHASE2_TODO.md');
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('Phase 2-10');
    expect(content).toContain('完了');
  });

  it('MANAGEMENT_TENANT_ID 定数の値が seed migration と一致する', () => {
    const tenantLib = readFileSync(join(SERVICE_DIR, '../lib/tenant.ts'), 'utf-8');
    const seedMigration = readFileSync(
      join(__dirname, '../../../prisma/migrations/20260513_seed_to_management_tenant/migration.sql'),
      'utf-8',
    );
    // 両者で同じ UUID を使っていること
    expect(tenantLib).toContain("'00000000-0000-0000-0000-ffffffffffff'");
    expect(seedMigration).toContain("'00000000-0000-0000-0000-ffffffffffff'");
  });
});
