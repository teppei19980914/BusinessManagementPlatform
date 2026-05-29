/**
 * vitest mock 補助ヘルパー (PR fix/test-tsc-strict-cleanup / 2026-05-29)
 *
 * test ファイルが strict tsc (`pnpm tsc --noEmit`) で 201 件の型エラーを出していた問題を
 * 「test 本文に as any を撒く」のではなく「ヘルパー内部に as を閉じ込める」方針で解消する。
 *
 * 役割:
 *   - `mock.calls[N][0]` の `T | undefined` を NonNullable<T> で返す型安全アクセサ
 *   - ESLint `@typescript-eslint/no-explicit-any` rule に違反しない (=`any` を一切使わない)
 *   - ヘルパー自体は src/lib/__tests__/test-mock-helpers.test.ts でカバー
 */

/**
 * 指定 index の mock 呼出の第 0 引数を、NonNullable で型付けして返す。
 *
 * 呼び出されていない場合は明示的に throw する (= サイレント undefined アクセスを防ぐ)。
 *
 * @example
 *   const args = getMockCallArg(vi.mocked(prisma.knowledge.findMany));
 *   expect(args.where?.AND).toEqual([{ deletedAt: null }, ...]);
 */
export function getMockCallArg<
  F extends (...args: never[]) => unknown,
>(
  mockFn: { mock: { calls: ReadonlyArray<Parameters<F>> } },
  callIdx = 0,
): NonNullable<Parameters<F>[0]> {
  const calls = mockFn.mock.calls;
  if (callIdx >= calls.length) {
    throw new Error(
      `getMockCallArg: expected call at index ${callIdx}, but only ${calls.length} calls recorded`,
    );
  }
  const call = calls[callIdx];
  if (call === undefined) {
    throw new Error(`getMockCallArg: call at index ${callIdx} is undefined`);
  }
  return call[0] as NonNullable<Parameters<F>[0]>;
}
