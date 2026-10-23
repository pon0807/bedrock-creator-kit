// 共通の ESLint 設定。各プロジェクトの eslint.config.mjs から読み込む
import tseslint from "typescript-eslint";
import minecraftLinting from "eslint-plugin-minecraft-linting";

export default tseslint.config(
  { ignores: ["**/node_modules/**", ".bkit/**", "dist/**", "**/*.d.ts"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,mts,js,mjs}"],
    plugins: { "minecraft-linting": minecraftLinting },
    rules: {
      // Mojang のルール: API で書ける処理を runCommand で済ませていないか
      "minecraft-linting/avoid-unnecessary-command": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-expressions": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
      "no-empty": "warn",
      "prefer-const": "warn",
      "no-constant-condition": ["warn", { checkLoops: false }],
    },
  },
);
