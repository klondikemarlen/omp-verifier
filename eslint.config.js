import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";

const config = defineConfig({
  files: ["**/*.{js,mjs}"],
  extends: [js.configs.recommended],
  languageOptions: {
    globals: globals.node,
  },
});

export default config;
