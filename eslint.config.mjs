import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettierConfig from "eslint-config-prettier";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettierConfig,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/generated/**",
    // PR #84: v8 coverage が生成する HTML レポート配下 (lcov-report/) を除外
    "coverage/**",
  ]),
  {
    // PR #115 (2026-04-24 / DESIGN §9.8.5):
    //   src 配下での console.* 新規追加をブロックする。エラー情報は
    //   src/services/error-log.service.ts の recordError / logUnknownError 経由で
    //   system_error_logs に保存する方針 (機密情報を Console に出さない)。
    //   テスト・E2E・スクリプト類は対象外 (ignore 指定)。
    files: ["src/**/*.{ts,tsx,js,jsx}"],
    ignores: [
      "src/**/*.test.{ts,tsx}",
      "src/**/*.spec.{ts,tsx}",
    ],
    rules: {
      "no-console": ["error"],
    },
  },
]);

export default eslintConfig;
