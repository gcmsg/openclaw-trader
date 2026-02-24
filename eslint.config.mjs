// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  // ── 忽略非源码文件 ──────────────────────────────────
  {
    ignores: ["dist/**", "node_modules/**", "logs/**", "*.mjs"],
  },

  // ── 基础规则（js + ts）──────────────────────────────
  eslint.configs.recommended,

  // ── TypeScript 严格类型检查规则集 ────────────────────
  // strictTypeChecked: 包含 no-explicit-any, no-unsafe-*, no-floating-promises 等
  // stylisticTypeChecked: 包含风格规范（prefer-nullish-coalescing 等）
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // ── 项目级配置 ───────────────────────────────────────
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── 类型安全 ──
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",

      // ── 异步安全 ──
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // ── 类型表达力 ──
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/consistent-type-exports": [
        "error",
        { fixMixedExportsWithInlineTypeSpecifier: true },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",

      // ── 代码质量 ──
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/array-type": ["error", { default: "array" }],

      // ── 实用放宽（有充分理由的特例）──
      // 数字/布尔在模板字面量中是合法语义，无需强制 .toString()
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      // 加减法允许数字+数字（strictTypeChecked 会把 number+string 标红）
      "@typescript-eslint/restrict-plus-operands": [
        "error",
        { allowNumberAndString: false },
      ],
      // delete obj[key] 在本项目持仓管理中是有意为之，降级警告
      "@typescript-eslint/no-dynamic-delete": "warn",
      // ! 断言：非空意图明确时可接受，降级警告
      "@typescript-eslint/no-non-null-assertion": "warn",
      // 空函数：mock/stub 场景下合法
      "@typescript-eslint/no-empty-function": "warn",
      // _ 前缀变量约定为有意忽略（如 catch (_e: unknown)）
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },

  // ── 测试文件：放宽部分严格规则 ──────────────────────
  {
    files: ["src/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "off",    // 测试里 .property 访问灵活处理
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-explicit-any": "warn",           // 测试里降级为警告
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  // ── Prettier（必须最后，覆盖冲突的格式规则）──────────
  prettierConfig
);
