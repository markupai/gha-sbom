// See: https://rollupjs.org/introduction/

import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const config = {
  // One entry per node action; each action.yml points at dist/<name>/index.js.
  input: { "stamp/index": "src/stamp/index.ts", "pnpm/index": "src/pnpm/index.ts" },
  output: {
    esModule: true,
    dir: "dist",
    format: "es",
    sourcemap: true,
    entryFileNames: "[name].js",
  },
  preserveEntrySignatures: false,
  plugins: [
    typescript({ tsconfig: "./tsconfig.build.json" }),
    nodeResolve({ preferBuiltins: true }),
    commonjs(),
  ],
  onwarn(warning, warn) {
    // Suppress circular dependency warnings from @actions/core
    if (warning.code === "CIRCULAR_DEPENDENCY" && warning.message.includes("@actions/core")) {
      return;
    }
    // Suppress other circular dependency warnings that are known to be safe
    if (warning.code === "CIRCULAR_DEPENDENCY") {
      return;
    }
    warn(warning);
  },
};

export default config;
