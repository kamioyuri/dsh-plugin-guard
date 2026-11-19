import { defineConfig } from 'tsdown'

// 双端打包：
// - Node 端 src/index.ts -> lib/index.js (ESM) + .d.ts；schemastery/cordis 不打包，
//   让 Loader 看到自己的实例来校验 Config schema。
// - 浏览器端 src/client/index.tsx -> lib/client.js (CJS 单文件)，用 ModuleLoader 包装，
//   inlineDynamicImports 保证单文件、无动态 import、无 Node 内置模块。
// client.js 的 __ModuleLoader__.load({ id }) 必须与 dsh 加载它时使用的 bundle 名一致，
// 否则 client-modules 校验 factories.has(id) 失败：
//   "loaded without registering \"<id>\" via __ModuleLoader__.load"
// 本插件在 profile 的 bundles 里用完整包名引用，故 id 用完整包名。
const PLUGIN_ID = '@yuri/dsh-plugin-guard'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
    deps: {
      neverBundle: ['@deepseek-ai/schemastery', '@deepseek-ai/cordis'],
    },
    outputOptions: {
      entryFileNames: 'index.js',
      chunkFileNames: 'chunks/[name].js',
    },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    target: 'es2022',
    // 平台模块是 dsh 运行时基线（ModuleLoader factory 的 require 提供），
    // 必须保持为外部引用，不能打包进 client.js。
    external: [
      'react', 'react/jsx-runtime',
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      inlineDynamicImports: true,
      banner: `window.__ModuleLoader__.load({ id: "${PLUGIN_ID}", factory: (require) => {`,
      footer: `return module.exports; } });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
