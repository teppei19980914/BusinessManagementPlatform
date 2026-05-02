/**
 * テナント境界の認可ユーティリティ (PR #2-b / T-03 提案エンジン v2)
 *
 * 同テナント内のデータのみ操作可能にするため、API ルートやサービス層の入り口で
 * 「リクエストユーザの tenantId」と「操作対象データの tenantId」が一致することを
 * 検証する。不一致時は TenantBoundaryError を投げ、cross-tenant 攻撃を遮断する。
 *
 * 設計方針:
 *   - **Fail Secure**: 一致を確認できなければ拒否 (デフォルト拒否)
 *   - **クエリ + 結果の二重防御**: where に `tenantScope()` を必ず含めた上で、
 *     結果に対しても `requireSameTenant()` で再検証する (DEFAULT 設定漏れの保険)
 *   - v1 (2026-06-01) の単一テナント運用では実質ノーオペだが、
 *     v1.x マルチテナント UI 提供時にコードを書き換えずに効力を発揮する
 *
 * 使い方の例:
 *
 *   // Pattern A: 単体取得 + 検証
 *   const project = await prisma.project.findUnique({
 *     where: { id: projectId, ...tenantScope(session.user.tenantId) },
 *   });
 *   if (!project) throw new NotFoundError();
 *   requireSameTenant(session.user.tenantId, project);
 *
 *   // Pattern B: 一覧取得 (where に tenantScope を含めるだけで境界担保)
 *   const projects = await prisma.project.findMany({
 *     where: { ...tenantScope(session.user.tenantId), status: 'in_progress' },
 *   });
 *   requireAllSameTenant(session.user.tenantId, projects); // 結果の念のため再検証
 *
 *   // Pattern C: 関連エンティティの整合性チェック
 *   const project = await prisma.project.findUnique({ where: { id: projectId } });
 *   const customer = await prisma.customer.findUnique({ where: { id: customerId } });
 *   requireSameTenant(session.user.tenantId, project);
 *   requireSameTenant(session.user.tenantId, customer);
 *
 * 関連:
 *   - `src/lib/tenant.ts`: DEFAULT_TENANT_ID 定数
 *   - `src/lib/permissions/check-permission.ts`: 役割ベースの認可 (本ユーティリティと併用)
 */

/**
 * テナント境界違反時に投げる例外。
 *
 * API ルートはこれを catch して 403 Forbidden を返す。
 * 例外メッセージには tenantId を含めるが、レスポンスには含めない (情報漏洩防止)。
 */
export class TenantBoundaryError extends Error {
  /**
   * @param userTenantId   リクエストユーザの所属テナント ID
   * @param entityTenantId 操作対象エンティティの所属テナント ID
   */
  constructor(
    public readonly userTenantId: string,
    public readonly entityTenantId: string,
  ) {
    super(
      `Tenant boundary violation: user=${userTenantId} entity=${entityTenantId}`,
    );
    this.name = 'TenantBoundaryError';
  }
}

/**
 * tenantId を持つエンティティの最小契約。
 * Prisma の生成型はこの shape を満たすため、特定モデルに依存しない汎用 helper として使える。
 */
export interface TenantOwned {
  tenantId: string;
}

/**
 * リクエストユーザの tenantId とエンティティの tenantId が一致することを検証する。
 *
 * - エンティティが `null` / `undefined` のときは何もしない (存在しないリソースは
 *   別経路で 404 として扱う設計; テナント境界の検証対象外)
 * - 不一致時は `TenantBoundaryError` を投げる
 *
 * @throws TenantBoundaryError 不一致時
 */
export function requireSameTenant(
  userTenantId: string,
  entity: TenantOwned | null | undefined,
): void {
  if (entity == null) {
    return;
  }
  // 副作用 (Proxy/getter) を 1 回に固定するため、tenantId を読むのは 1 度のみ。
  const entityTenantId = entity.tenantId;
  if (userTenantId !== entityTenantId) {
    throw new TenantBoundaryError(userTenantId, entityTenantId);
  }
}

/**
 * 複数エンティティに対する一括検証。
 * findMany の結果セットや関連エンティティの整合性チェックに使用。
 *
 * @throws TenantBoundaryError いずれかが不一致のとき (最初の不一致で停止)
 */
export function requireAllSameTenant(
  userTenantId: string,
  entities: ReadonlyArray<TenantOwned | null | undefined>,
): void {
  for (const entity of entities) {
    requireSameTenant(userTenantId, entity);
  }
}

/**
 * Prisma の `where` 節に展開してテナント境界をクエリレベルで強制する helper。
 *
 * `requireSameTenant()` と二重防御で使うことを想定:
 *   - `tenantScope()` で **DB 側で** 別テナントのデータを絞り込み除外
 *   - `requireSameTenant()` で **アプリ側で** 万一漏れ込んだ場合に検出
 *
 * @example
 *   prisma.project.findMany({
 *     where: { ...tenantScope(session.user.tenantId), status: 'in_progress' },
 *   })
 */
export function tenantScope(tenantId: string): { tenantId: string } {
  return { tenantId };
}
