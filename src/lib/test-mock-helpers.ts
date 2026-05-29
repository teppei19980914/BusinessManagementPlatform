/**
 * vitest mock 補助ヘルパー (PR fix/test-tsc-strict-cleanup / 2026-05-29)
 *
 * test ファイルが strict tsc (`pnpm tsc --noEmit`) で 201 件の型エラーを出していた問題を
 * 「test 本文に as any を撒く」のではなく「ヘルパー内部に as を閉じ込める」方針で解消する。
 *
 * 役割:
 *   - `mock.calls[N][0]` の `T | undefined` を呼出側が指定した型で返す
 *   - ESLint `@typescript-eslint/no-explicit-any` rule に違反しない (=`any` を一切使わない)
 *   - ヘルパー自体は src/lib/__tests__/test-mock-helpers.test.ts でカバー
 *
 * 設計メモ:
 *   - Prisma の汎用 (generic) シグネチャ (`<T extends FindManyArgs>(args?: T)`) を持つ関数を
 *     `vi.mocked()` でラップすると `Parameters<F>` が解決できず `never[]` になる罠がある。
 *     そのため引数は `{ mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }` で受ける。
 *   - デフォルト型 `DeepLooseObject` は「任意のフィールドを再帰的に同型で許容する」recursive type で、
 *     test 内の `call.where.AND` / `call.data.X.Y` のような chain アクセスを `as` 無しに通す。
 *     vitest の `toEqual` / `toBe` / `toContainEqual` は引数が `any` で型チェックしないため、
 *     `DeepLooseObject` のまま比較に渡しても実害がない (= 実行時アサーションは vitest が担保)。
 *   - より厳密な型が欲しい呼出側は `getMockCallArg<MyType>(...)` で type parameter を明示できる。
 */

type MockWithCalls = {
  mock: {
    calls: ReadonlyArray<ReadonlyArray<unknown>>;
  };
};

/**
 * 任意のフィールド/インデックスアクセスを再帰的に通す "loose" 型。
 *
 * `any` を使わずに `obj.foo.bar.baz` や `obj[0].x` のような chain を許容する。
 * vitest の matcher (`toEqual` 等) は内部で `any` 受けなので、この型のまま渡しても問題ない。
 */
export type DeepLooseObject = {
  readonly [key: string]: DeepLooseObject;
  readonly [index: number]: DeepLooseObject;
};

/**
 * 指定 index の mock 呼出の第 0 引数を、呼出側で推論した型で返す。
 *
 * 呼び出されていない場合は明示的に throw する (= サイレント undefined アクセスを防ぐ)。
 *
 * @example
 *   // デフォルト型 (DeepLooseObject) で任意の chain アクセスを許容
 *   const call = getMockCallArg(vi.mocked(prisma.knowledge.findMany));
 *   expect(call.where.AND).toEqual([{ deletedAt: null }, ...]);
 *
 *   // 厳密な型を指定したいとき
 *   const call = getMockCallArg<Prisma.KnowledgeCreateArgs>(vi.mocked(prisma.knowledge.create));
 */
export function getMockCallArg<TArg = DeepLooseObject>(
  mockFn: MockWithCalls,
  callIdx = 0,
): TArg {
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
  return call[0] as TArg;
}
