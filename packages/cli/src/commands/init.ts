import { access, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParsedArgs } from "../args.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the repo's `templates/` directory by walking up from this module.
 * The production build lives at `dist/commands/init.js` and the test build at
 * `dist-test/src/commands/init.js`, so a fixed `../../..` count is wrong for
 * one of them — walking up until we see `templates/CONSTITUTION.minimal.md`
 * works for both. Returns null if no templates dir is found.
 */
async function findTemplatesDir(): Promise<string | null> {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "templates");
    if (await exists(join(candidate, "CONSTITUTION.minimal.md"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function replaceTokenInFile(path: string, token: string, value: string): Promise<void> {
  const content = await readFile(path, "utf8");
  if (!content.includes(token)) return;
  await writeFile(path, content.split(token).join(value), "utf8");
}

export async function init(args: ParsedArgs): Promise<void> {
  const target = args.positionals[0];
  if (!target) {
    console.error(
      'Usage: mainspring init <dir> [--name "My Business"] [--template minimal|full] [--brain echo] [--force]',
    );
    process.exitCode = 1;
    return;
  }

  const brain = typeof args.flags.brain === "string" ? args.flags.brain : "echo";
  if (brain !== "echo") {
    console.error(
      `Only --brain echo ships in this skeleton. Implement a custom Brain and edit mainspring.config.ts after init.`,
    );
  }

  const template = typeof args.flags.template === "string" ? args.flags.template : "minimal";
  if (template !== "minimal" && template !== "full") {
    console.error(`Unknown --template "${template}". Use "minimal" (default) or "full".`);
    process.exitCode = 1;
    return;
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

  const templatesDir = await findTemplatesDir();
  // templates/default holds the non-Constitution scaffold (STATE.md, LEDGER.csv,
  // mainspring.config.ts, package.json, .gitignore). The Constitution itself is
  // chosen by --template and copied from templates/CONSTITUTION.<variant>.md.
  const defaultDir = templatesDir ? join(templatesDir, "default") : "";
  const constitutionTemplate = templatesDir ? join(templatesDir, `CONSTITUTION.${template}.md`) : "";
  if (!templatesDir || !(await exists(defaultDir)) || !(await exists(constitutionTemplate))) {
    console.error(`Could not find the workspace templates. Is @mainspring/cli installed correctly?`);
    process.exitCode = 1;
    return;
  }

  // 1. Lay down the scaffold: STATE.md, LEDGER.csv, mainspring.config.ts,
  //    package.json, .gitignore. (The default's own CONSTITUTION.md is
  //    overwritten in step 2 with the chosen --template variant.)
  await cp(defaultDir, targetDir, { recursive: true });

  // 2. Write the Constitution from the requested template, with --name in place.
  const constitution = await readFile(constitutionTemplate, "utf8");
  await writeFile(join(targetDir, "CONSTITUTION.md"), constitution, "utf8");

  // 3. journal/ is the brain's durable per-day memory. `run` creates today's
  //    file on first session, but ship the directory (tracked via .gitkeep) so
  //    a freshly-init'd workspace already has the shape doctor/run expect.
  await mkdir(join(targetDir, "journal"), { recursive: true });
  await writeFile(
    join(targetDir, "journal", ".gitkeep"),
    "# journal/ holds one YYYY-MM-DD.md file per session day. Keep this dir tracked.\n",
    "utf8",
  );

  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "mainspring-business";

  for (const file of ["CONSTITUTION.md", "STATE.md", "mainspring.config.ts"]) {
    await replaceTokenInFile(join(targetDir, file), "{{BUSINESS_NAME}}", name);
  }
  await replaceTokenInFile(join(targetDir, "package.json"), "{{BUSINESS_SLUG}}", slug);

  console.log(`Initialized a Mainspring workspace "${name}" at ${targetDir}`);
  console.log(`  template: ${template}  ·  brain: echo`);
  console.log(`Next steps:`);
  console.log(`  cd ${target}`);
  console.log(`  pnpm add @mainspring/core   # or npm/yarn — links the workspace's Brain runtime`);
  console.log(`  mainspring doctor           # verify the workspace is runnable`);
  console.log(`  mainspring run              # let the echo Brain take its first session`);
}
