import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import type { MainspringConfig } from "@mainspring/core";

/**
 * `mainspring.config.ts` is plain TypeScript so it type-checks against
 * @mainspring/core's Constitution/Brain types in an editor. Loading it at
 * runtime needs no bundler: we strip types with the TypeScript compiler API
 * (already a dependency of this CLI) and evaluate the result as ESM. The
 * output file is written inside the workspace's own `.mainspring/` folder
 * (not the OS temp dir) so Node's module resolution walks up to the
 * workspace's `node_modules` and finds `@mainspring/core` there.
 */
export async function loadConfig(workspaceDir: string): Promise<MainspringConfig> {
  const configPath = join(workspaceDir, "mainspring.config.ts");
  const source = await readFile(configPath, "utf8").catch(() => {
    throw new Error(`No mainspring.config.ts found in ${workspaceDir}. Run "mainspring init" first.`);
  });

  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      esModuleInterop: true,
    },
    fileName: "mainspring.config.ts",
  });

  const cacheDir = join(workspaceDir, ".mainspring");
  await mkdir(cacheDir, { recursive: true });
  const outFile = join(cacheDir, `config.${Date.now()}.mjs`);
  await writeFile(outFile, transpiled.outputText, "utf8");

  try {
    const mod = (await import(pathToFileURL(outFile).href)) as { default?: MainspringConfig };
    if (!mod.default) {
      throw new Error(`${configPath} must \`export default defineConfig({...})\``);
    }
    return mod.default;
  } finally {
    await unlink(outFile).catch(() => {});
  }
}
