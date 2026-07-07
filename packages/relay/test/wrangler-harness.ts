/**
 * Boots a real `wrangler dev` against the OSS relay worker
 * (`oss/relay-oss/src/index.js`) so `relay-e2e.test.ts` can drive
 * `@mainspring/relay`'s public API against the ACTUAL protocol instead of a
 * mock. Local-mode only (simulated KV in a throwaway temp dir), dummy
 * secrets generated per run, random ports — no real network, no real
 * secrets. Ported from `oss/relay-oss/test/e2e-invariants.mjs`'s boot/wait/
 * shutdown pattern so both suites stay honest about what the worker
 * actually does, rather than diverging mock behavior.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STARTUP_TIMEOUT_MS = 60_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A booted relay worker plus what's needed to drive its agent + portal sides. */
export interface RelayHarness {
  baseUrl: string;
  /** Name of the env var `RelayClient` should read the dummy agent key from. */
  agentKeyEnvVar: string;
  vaPassword: string;
  /** Logs into the human portal and returns the `relay_session` cookie header value. */
  portalLogin(): Promise<string>;
  /** Terminates wrangler dev and removes its temp KV persistence dir. */
  stop(): void;
}

/** Locate `oss/relay-oss` by walking up from this file looking for its manifest. */
function resolveRelayOssRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "oss", "relay-oss");
    if (existsSync(join(candidate, "wrangler.jsonc"))) return candidate;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate oss/relay-oss (expected a wrangler.jsonc) above " + dirname(fileURLToPath(import.meta.url)));
}

/**
 * Boot wrangler dev for `oss/relay-oss` and wait until it answers HTTP.
 * Throws (never resolves) if wrangler can't start in this sandbox — callers
 * should catch that and `test.skip` with the reason, never fake a pass.
 */
export async function startRelay(): Promise<RelayHarness> {
  const relayOssRoot = resolveRelayOssRoot();
  const port = 8990 + Math.floor(Math.random() * 300);
  const inspectorPort = 9630 + Math.floor(Math.random() * 300);
  const baseUrl = `http://127.0.0.1:${port}`;

  const agentKey = "mainspring-e2e-agent-key-local-only-do-not-use-in-prod";
  const vaPassword = "mainspring-e2e-portal-password-local-only";
  const encKey = Buffer.alloc(32, 9).toString("base64"); // valid AES-256 key, throwaway
  const sessionSecret = "mainspring-e2e-session-secret-local-only";

  const agentKeyEnvVar = "MAINSPRING_RELAY_E2E_AGENT_KEY";
  process.env[agentKeyEnvVar] = agentKey;

  const persistDir = mkdtempSync(join(tmpdir(), "mainspring-relay-e2e-"));
  let childLog = "";
  let child: ChildProcess;
  try {
    child = spawn(
      "npx",
      [
        "wrangler", "dev",
        "--local",
        "--ip", "127.0.0.1",
        "--port", String(port),
        "--inspector-port", String(inspectorPort),
        "--persist-to", persistDir,
        "--show-interactive-dev-session", "false",
        "--var", `RELAY_AGENT_KEY:${agentKey}`,
        "--var", `RELAY_VA_PASSWORD:${vaPassword}`,
        "--var", `RELAY_ENC_KEY:${encKey}`,
        "--var", `RELAY_SESSION_SECRET:${sessionSecret}`,
        "--var", "REQUEST_TTL_DAYS:7",
        "--var", "RELAY_PUBLIC_URL:",
      ],
      { cwd: relayOssRoot, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, CI: "1" } },
    );
  } catch (err) {
    rmSync(persistDir, { recursive: true, force: true });
    delete process.env[agentKeyEnvVar];
    throw err;
  }
  child.stdout?.on("data", (d) => { childLog += d.toString(); });
  child.stderr?.on("data", (d) => { childLog += d.toString(); });

  function stop(): void {
    try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
    try { rmSync(persistDir, { recursive: true, force: true }); } catch { /* best effort */ }
    delete process.env[agentKeyEnvVar];
  }

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      stop();
      throw new Error(`wrangler dev exited early (code ${child.exitCode})\n${childLog.slice(-2000)}`);
    }
    try {
      const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
      if (res.ok && (await res.text()).includes("Fabler Relay")) {
        ready = true;
        break;
      }
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  if (!ready) {
    stop();
    throw new Error(`wrangler dev not ready within ${STARTUP_TIMEOUT_MS}ms\n${childLog.slice(-2000)}`);
  }

  async function portalLogin(): Promise<string> {
    const form = new URLSearchParams({ password: vaPassword }).toString();
    const res = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      redirect: "manual",
    });
    const setCookies = res.headers.getSetCookie
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") || ""];
    const cookie = (setCookies.find((c) => c && c.startsWith("relay_session=")) || "").split(";")[0];
    if (!cookie) throw new Error(`portal login did not set relay_session (status ${res.status})`);
    return cookie;
  }

  return { baseUrl, agentKeyEnvVar, vaPassword, portalLogin, stop };
}
