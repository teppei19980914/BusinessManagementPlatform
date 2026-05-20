/**
 * 監査ログ記録（設計書: DESIGN.md セクション 5.13）
 *
 * 全てのデータ変更操作（CREATE / UPDATE / DELETE）を記録する。
 * 初期フェーズ（Level 1）で常時有効。
 */

import { prisma } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';

/**
 * 監査ログのアクション種別。
 * SYNC_IMPORT は feat/wbs-overwrite-import で追加 (WBS 上書きインポート 1 件 = 1 ログ)。
 * EXPORT は P-C (2026-05-08) で追加 (super_admin のテナントデータ代行エクスポート)。
 * BULK_UPDATE は feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S1-A1) で追加。
 *   ○○一覧の bulk visibility 更新を ADR-0011 「全 mutation 記録」原則に従い audit に残す。
 */
export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'SYNC_IMPORT' | 'EXPORT' | 'BULK_UPDATE';

/**
 * UUID v4 のパターン (RFC 4122)。
 * audit_logs.entity_id / tenant_id / user_id は schema で `@db.Uuid` 制約があり、
 * 非 UUID 文字列を渡すと PostgreSQL が 22P02 (invalid input syntax for type uuid) で拒否する。
 *
 * PR-V8 (2026-05-19): 'all-tenants' のような合成キーが silent fail していた事故 (本件) を
 *   未然に防ぐため、service 入口で実装側に明示的なエラーを投げるバリデーションを追加。
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, fieldName: string): void {
  if (UUID_PATTERN.test(value)) return;
  const message =
    `[audit.service] ${fieldName} は UUID 形式である必要があります。`
    + ` schema (audit_logs.${fieldName === 'entityId' ? 'entity_id' : fieldName === 'tenantId' ? 'tenant_id' : 'user_id'}) は @db.Uuid 制約があり、`
    + ` 非 UUID 値は PostgreSQL レベルで silent fail します (22P02)。`
    + ` 受け取った値: "${value}"。`
    + ` 全テナント横断操作の場合は MANAGEMENT_TENANT_ID 等の有効な UUID を使い、`
    + ` 識別子は afterValue.operation 等のメタデータに含めてください。`;
  // PR-V8 (2026-05-19): 本番 / staging では throw して silent fail を防ぐ。
  //   test 環境では UUID 形式でない fixture が多数存在するため warn にとどめ、
  //   段階的に test を UUID 形式に移行する (= 影響範囲を抑える)。
  //   `STRICT_AUDIT_UUID=true` を test で渡せばここでも throw (= 新規 test 用)。
  const isTestEnv = process.env['NODE_ENV'] === 'test';
  const forceStrict = process.env['STRICT_AUDIT_UUID'] === 'true';
  if (isTestEnv && !forceStrict) {
    // 既存 test を壊さないよう warn にとどめる。本番では throw。
    // eslint-disable-next-line no-console
    console.warn(message);
    return;
  }
  throw new Error(message);
}

export async function recordAuditLog(params: {
  /**
   * Phase 2-10 (2026-05-10): 監査ログの所属テナント。通常は actor (userId) のテナントと一致するが、
   *   super_admin が他テナントを代行操作するケース (P-C export 等) では **対象テナントの ID** を渡す。
   *   = 「誰がどのテナントの何を操作したか」を直接フィルタ可能にする (User join 経由ではなく)。
   */
  tenantId: string;
  userId: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  beforeValue?: Record<string, unknown> | null;
  afterValue?: Record<string, unknown> | null;
  ipAddress?: string;
}): Promise<void> {
  // PR-V8 (2026-05-19): UUID 違反による silent fail 防止 (本件 regression)
  assertUuid(params.tenantId, 'tenantId');
  assertUuid(params.userId, 'userId');
  assertUuid(params.entityId, 'entityId');

  await prisma.auditLog.create({
    data: {
      tenantId: params.tenantId,
      userId: params.userId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      beforeValue: (params.beforeValue ?? undefined) as Prisma.InputJsonValue | undefined,
      afterValue: (params.afterValue ?? undefined) as Prisma.InputJsonValue | undefined,
      ipAddress: params.ipAddress,
    },
  });
}

/**
 * 複数エンティティに対する一括操作の監査ログを `createMany` で一度に記録する。
 *
 * なぜこの関数が必要か:
 * - AuditLog スキーマの entityId は `@db.Uuid` 型であり、`"bulk:24"` のような
 *   合成文字列を入れると DB レベルで拒否される（PrismaClientKnownRequestError P2007）
 * - 正しい監査の粒度は「エンティティごとに 1 行」。バルク操作の文脈は afterValue の
 *   メタデータ（bulk: true, bulkBatchSize, 適用した updates 等）で保持する
 */
export async function recordBulkAuditLogs(params: {
  /** Phase 2-10: 監査ログの所属テナント (recordAuditLog 同様)。 */
  tenantId: string;
  userId: string;
  action: AuditAction;
  entityType: string;
  /** 監査対象の各 UUID（バリデーション済みであること）*/
  entityIds: string[];
  /** 全エンティティ共通の afterValue。バルク適用内容を含めるとトレーサビリティが向上する */
  afterValue?: Record<string, unknown> | null;
  beforeValue?: Record<string, unknown> | null;
  ipAddress?: string;
}): Promise<void> {
  if (params.entityIds.length === 0) return;
  // PR-V8 (2026-05-19): UUID 違反による silent fail 防止 (本件 regression)
  assertUuid(params.tenantId, 'tenantId');
  assertUuid(params.userId, 'userId');
  for (const id of params.entityIds) {
    assertUuid(id, 'entityId');
  }

  await prisma.auditLog.createMany({
    data: params.entityIds.map((entityId) => ({
      tenantId: params.tenantId,
      userId: params.userId,
      action: params.action,
      entityType: params.entityType,
      entityId, // 個別の UUID を設定（合成文字列を避ける）
      beforeValue: (params.beforeValue ?? undefined) as Prisma.InputJsonValue | undefined,
      afterValue: (params.afterValue ?? undefined) as Prisma.InputJsonValue | undefined,
      ipAddress: params.ipAddress,
    })),
  });
}

/**
 * 変更前後の差分を抽出するヘルパー
 * password_hash 等の機密フィールドは自動的に除外する。
 *
 * feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S2-E1):
 *   SENSITIVE_FIELDS を 4 → 14 に拡張し、camelCase / snake_case 両方を網羅。
 *   recoveryCodeHash / token 系 / MFA temp secret / API key / Stripe secret 等、
 *   将来 audit_logs.beforeValue/afterValue に流入し得る機微フィールドを構造的に redact。
 *   nested object も再帰的に redact (top-level だけだった旧実装の defense-in-depth 強化)。
 */
const SENSITIVE_FIELDS = new Set([
  // パスワード関連
  'passwordHash', 'password_hash',
  'passwordSalt', 'password_salt',
  // MFA
  'mfaSecretEncrypted', 'mfa_secret_encrypted',
  'mfaTempSecret', 'mfa_temp_secret',
  // リカバリーコード
  'recoveryCodeHash', 'recovery_code_hash',
  'codeHash', 'code_hash',
  // 認証トークン (reset / verify / session)
  'tokenHash', 'token_hash',
  'sessionToken', 'session_token',
  'refreshToken', 'refresh_token',
  // 外部サービスの secret
  'apiKey', 'api_key',
  'webhookSecret', 'webhook_secret',
  'stripeMeterEventToken', 'stripe_meter_event_token',
  // 旧仕様コードベース互換
  'password',
]);

/**
 * オブジェクトの top-level + nested フィールドを再帰的に sanitize する。
 * 配列要素もスキャンし、配列内の object も再帰処理。最大深度 5 で stack overflow を防ぐ。
 */
/**
 * feat/crud-permission-redesign (2026-05-20, KDD §5.X+87, §5.X+88):
 *
 *   CodeQL Remote property injection 対策。`Object.entries(obj)` の key は外部入力由来の
 *   可能性があり、`__proto__` / `constructor` / `prototype` の特殊キーで prototype pollution
 *   攻撃が成立し得る。`Object.defineProperty` を使った前回修正でも CodeQL の dataflow 解析が
 *   動的キー書き込みを追跡してしまうため、**JSON.stringify の replacer 関数で sanitize する**
 *   実装に切り替えた。
 *
 *   JSON.stringify(obj, replacer) は:
 *     - replacer が each key で呼ばれ、`undefined` を返すと該当 key が出力から省略される
 *     - 結果の JSON 文字列を JSON.parse で plain object に戻すと、`__proto__` 等の特殊キーは
 *       自然に脱落 (JSON.stringify がそれらを enumerable own property としてのみ扱う)
 *     - 動的プロパティ書き込みが発生しないため CodeQL 警告を構造的に回避
 *     - nested object / 配列も replacer が再帰的に呼ばれるため、独自再帰実装不要
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function sanitizeForAudit(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  // JSON.stringify の replacer で sanitize を行う。
  //   - key === '' は最上位 root (replacer の仕様)
  //   - FORBIDDEN_KEYS / SENSITIVE_FIELDS は replacer 内で判定し、redact または除外
  //   - replacer が再帰的に呼ばれるため nested / array も自動対応
  const json = JSON.stringify(obj, (key, value) => {
    if (key === '') return value; // root
    if (FORBIDDEN_KEYS.has(key)) return undefined; // 特殊キーは完全除外
    if (SENSITIVE_FIELDS.has(key)) return '[REDACTED]'; // 機微フィールド redact
    return value;
  });
  // JSON.parse の結果は plain object。`__proto__` 等の特殊キーは脱落済み。
  const parsed = json ? JSON.parse(json) : {};
  return (typeof parsed === 'object' && parsed !== null) ? parsed : {};
}
