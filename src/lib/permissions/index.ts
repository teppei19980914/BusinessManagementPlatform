export { checkPermission } from './check-permission';
export type { PermissionContext, PermissionResult, Action } from './check-permission';
export {
  checkMembership,
  getActualProjectRole,
  checkMembershipWithActualRole,
} from './membership';
export type { MembershipInfo, FullMembershipInfo } from './membership';
// PR #2-b (T-03): テナント境界認可ユーティリティ
export {
  requireSameTenant,
  requireAllSameTenant,
  tenantScope,
  TenantBoundaryError,
} from './tenant';
export type { TenantOwned } from './tenant';
// PR-X1 (2026-05-07): ロール判定ヘルパ (super_admin / admin / general 3 階層)
export {
  isSuperAdmin,
  isTenantAdmin,
  isAdminOrAbove,
  requireSuperAdmin,
} from './role';
export type { RoleContext } from './role';
