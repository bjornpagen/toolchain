import { defineConfig } from "oxlint"

/** A configuration on another preset: it loads no dev tools plugin. */
export default defineConfig({
	plugins: ["typescript"],
	rules: { "eslint/no-debugger": "error" }
})
