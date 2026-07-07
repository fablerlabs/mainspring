import { access, cp, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParsedArgs } from "../args.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/commands/init.js -> dist/commands -> dist -> cli -> packages -> mainspring/templates/default
const TEMPLATE_DIR = resolve(__dirname, "..", "..", "..", "..", "templates", "default");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function replaceTokenInFile(path: string, token: string, value: string): Promise<void> {
  const content = await readFile(path, "utf8");
  if (!content.includes(token)) return;
  await writeFile(path, content.split(token).join(value), "utf8");
}

export async function init(args: ParsedArgs): Promise<void> {
  const target = args.positionals[0];
  if (!target) {
    console.error("Usage: mainspring init <dir> [--name \"My Business\"] [--brain echo]");
    process.exitCode = 1;
    return;
  }

  const brain = typeof args.flags.brain === "string" ? args.flags.brain : "echo";
  if (brain !== "echo") {
    console.error(`Only --brain echo ships in this skeleton. Implement a custom Brain and edit mainspring.config.ts after init.`);
  }

  const targetDir = resolve(process.cwd(), target);
  const name = typeof args.flags.name === "string" ? args.flags.name : target;

  if (await exists(targetDir)) {
    const entries = await readdir(targetDir);
    if (entries.length > 0 && !args.flags.force) {
      console.error(`${targetDir} already exists and is not empty. Pass --force to init into it anyway.`);
      process.exitCode = 1;
      return;
    }
  }

  if (!(await exists(TEMPLATE_DIR))) {
    console.error(`Could not find the default template at ${TEMPLATE_DIR}. Is @mainspring/cli installed correctly?`);
    process.exitCode = 1;
    return;
  }

  await cp(TEMPLATE_DIR, targetDir, { recursive: true });

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "mainspring-business";

  for (const file of ["CONSTITUTION.md", "STATE.md", "mainspring.config.ts"]) {
    await replaceTokenInFile(join(targetDir, file), "{{BUSINESS_NAME}}", name);
  }
  await replaceTokenInFile(join(targetDir, "package.json"), "{{BUSINESS_SLUG}}", slug);

  console.log(`Initialized a Mainspring workspace "${name}" at ${targetDir}`);
  console.log(`Next steps:`);
  console.log(`  cd ${target}`);
  console.log(`  pnpm add @mainspring/core   # or npm/yarn — links the workspace's Brain runtime`);
  console.log(`  mainspring run`);
}
