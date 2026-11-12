import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { build } from 'esbuild';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDirectory, '..');
const loaderId = 'dsh-feishu-lark-cli';

async function buildHost() {
  await build({
    entryPoints: [resolve(packageRoot, 'src/host/index.ts')],
    outfile: resolve(packageRoot, 'lib/index.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    packages: 'external',
  });
}

async function buildClient() {
  const result = await build({
    entryPoints: [resolve(packageRoot, 'src/client/index.tsx')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['chrome100'],
    external: ['react', 'react-dom'],
    write: false,
    legalComments: 'none',
  });
  const bundled = result.outputFiles?.[0]?.text;
  if (!bundled) throw new Error('esbuild did not produce a client bundle');
  const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(loaderId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`;
  await mkdir(dirname(resolve(packageRoot, 'lib/client.js')), { recursive: true });
  await writeFile(resolve(packageRoot, 'lib/client.js'), wrapped, 'utf8');
}

async function emitTypes() {
  const result = spawnSync('npx', ['tsc', '--emitDeclarationOnly'], { stdio: 'inherit', cwd: packageRoot });
  if (result.status) process.exit(result.status);
}

/** 触发来源是纯逻辑，单独产出一份 ESM 供测试导入。 */
async function buildTriggerModule() {
  await build({
    entryPoints: [resolve(packageRoot, 'src/client/feishu-trigger.ts')],
    outfile: resolve(packageRoot, 'lib/feishu-trigger.js'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
  });
}

await buildHost();
await buildTriggerModule();
await buildClient();
await emitTypes();
console.log('built lib/index.js, lib/client.js and lib/types');
