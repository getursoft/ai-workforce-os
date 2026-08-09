import js from "@eslint/js";
import next from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: [
      "**/.next/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/next-env.d.ts"
    ]
  },
  {
    ...js.configs.recommended,
    files: ["**/*.{js,cjs,mjs}"],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },
  ...tseslint.configs.strict.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"]
  })),
  {
    ...next.configs["core-web-vitals"],
    files: [
      "apps/dashboard/**/*.{ts,tsx}",
      "apps/dashboard/eslint.config.mjs",
      "src/**/*.{ts,tsx}",
      "eslint.config.mjs"
    ],
    rules: {
      "@next/next/no-html-link-for-pages": "off"
    }
  },
  {
    // Only the two classic rules already in use across the dashboard — eslint-plugin-react-hooks v7's
    // "recommended" preset ships a much broader, React-Compiler-oriented rule set not evaluated for this
    // codebase; adopting it wholesale is out of scope for a lint-config fix.
    files: ["apps/dashboard/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn"
    }
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports"
        }
      ],
      "@typescript-eslint/no-extraneous-class": "off"
    }
  },
  prettier
];
