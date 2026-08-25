import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const setup = join(repoRoot, "scripts", "codex-setup.mjs");

function runSetup(args, env) {
  return execFileSync(process.execPath, [setup, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fixtureEnv(root, marketplace) {
  return {
    CODEX_HOME: join(root, ".codex"),
    AIFORALL_MARKETPLACE_PATH: marketplace,
    AIFORALL_SETUP_SKIP_CODEX: "1",
    AIFORALL_SETUP_SKIP_DEPENDENCY_CHECK: "1",
    AIFORALL_SETUP_SKIP_PLUGIN_CHECKS: "1",
  };
}

test("install appends one managed rules block, backs up existing rules, and uses a persistent marketplace", () => {
  const root = mkdtempSync(join(tmpdir(), "aiforall-setup-test-"));
  const marketplace = join(root, "marketplace");
  execFileSync("git", ["clone", "--local", "--no-hardlinks", repoRoot, marketplace], { encoding: "utf8" });
  const env = fixtureEnv(root, marketplace);
  const codexHome = env.CODEX_HOME;
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "AGENTS.md"), "existing user rules\n", "utf8");
  writeFileSync(join(codexHome, "instruction.ctf.md"), "canonical rules\n", "utf8");

  const first = runSetup(["--install", "--no-sync", "--source-root", marketplace], env);
  const second = runSetup(["--install", "--no-sync", "--source-root", marketplace], env);
  const agents = readFileSync(join(codexHome, "AGENTS.md"), "utf8");
  const instruction = readFileSync(join(codexHome, "instruction.ctf.md"), "utf8");
  assert.match(first, /Persistent marketplace/);
  assert.match(second, /Install complete/);
  assert.match(agents, /existing user rules/);
  assert.match(instruction, /canonical rules/);
  assert.equal((agents.match(/BEGIN aiforall-image-gen managed rules/g) || []).length, 1);
  assert.equal((instruction.match(/BEGIN aiforall-image-gen managed rules/g) || []).length, 1);
  assert.ok(readdirSync(codexHome).some((name) => name.startsWith("AGENTS.md.bak-")));
  assert.ok(readdirSync(codexHome).some((name) => name.startsWith("instruction.ctf.md.bak-")));
  const config = readFileSync(join(codexHome, "config.toml"), "utf8");
  assert.match(config, /marketplaces\.aiforall-plugins/);
  assert.doesNotMatch(config, /\.codex[\\/]\.tmp/);
});

test("configure-key persists masked workers without exposing the key", () => {
  const root = mkdtempSync(join(tmpdir(), "aiforall-key-test-"));
  const env = fixtureEnv(root, join(root, "marketplace"));
  const secret = "setup-main-private-123456789";
  const output = runSetup(["--configure-key"], {
    ...env,
    AIFORALL_SETUP_MAIN_KEY: secret,
    AIFORALL_SETUP_NATIVE_KEY: "native-private-987654321",
  });
  const configPath = join(env.CODEX_HOME, "aiforall-image-gen-config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assert.match(output, /setup-ma\.\.\.[0-9]+/);
  assert.doesNotMatch(output, /setup-main-private-123456789/);
  assert.equal(config.workers.length, 2);
  assert.equal(config.workers[0].models[0], "gpt-image-2");
  assert.equal(config.workers[1].models[0], "gpt-image-1.5");
});

test("restore check-only reports missing cache and does not create files", () => {
  const root = mkdtempSync(join(tmpdir(), "aiforall-restore-test-"));
  const marketplace = join(root, "marketplace");
  execFileSync("git", ["clone", "--local", "--no-hardlinks", repoRoot, marketplace], { encoding: "utf8" });
  const env = fixtureEnv(root, marketplace);
  const output = runSetup(["--restore", "--check-only"], env);
  assert.match(output, /Plugin cache: missing/);
  assert.match(output, /Check-only mode/);
  assert.doesNotMatch(output, /Codex plugin installed/);
});
