export { checkPermission } from './check-permission';
export type { PermissionContext, PermissionResult, Action } from './check-permission';
export { checkMembership, getActualProjectRole } from './membership';
export type { MembershipInfo } from './membership';
// PR #2-b (T-03): テナント境界認可ユーティリティ
export {
  requireSameTenant,
  requireAllSameTenant,
  tenantScope,
  TenantBoundaryError,
} from './tenant';
export type { TenantOwned } from './tenant';
