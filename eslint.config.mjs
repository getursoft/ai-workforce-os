import js from "@eslint/js";
import next from "@next/eslint-plugin-next";
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
