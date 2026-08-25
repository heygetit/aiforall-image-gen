#!/usr/bin/env node

/* Shared installer, key configurator, and post-upgrade recovery check. */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE_ROOT = resolve(SCRIPT_DIR, "..");
const HOME = process.env.USERPROFILE || process.env.HOME || homedir();
const CODEX_HOME = resolve(process.env.CODEX_HOME || join(HOME, ".codex"));
const MARKETPLACE_PATH = resolve(
  process.env.AIFORALL_MARKETPLACE_PATH || join(HOME, "codex-marketplaces", "aiforall-plugins"),
);
const MARKETPLACE_NAME = "aiforall-plugins";
const PLUGIN_NAME = "aiforall-image-gen";
const RULE_BEGIN = "<!-- BEGIN aiforall-image-gen managed rules -->";
const RULE_END = "<!-- END aiforall-image-gen managed rules -->";
const RULES = `${RULE_BEGIN}
- For image generation, image editing, transparent-background, and batch-image tasks, use the \`aiforall-image-gen\` Codex plugin first.
- Use \`gpt-image-2\` by default. Use \`--native-transparent\` only when the user explicitly requests it and never silently submit a paid fallback request after native transparency fails.
- Set the outer command timeout to at least 360 seconds. The plugin API request timeout is at least 300 seconds.
- Do not print complete API keys in chat, logs, source files, tests, or Git. Use environment variables or the plugin's private configuration flow.
- Treat timeout, disconnect, and \`fetch failed\` results as unknown after submission. Do not automatically resubmit a paid request; check request history first.
- Save generated files to the current project's \`aiforall-image-gen/\` directory unless the user specifies another output directory.
- For batch work, use the plugin's worker pool and bounded concurrency. Respect the configured per-key slots and do not create duplicate paid requests to compensate for a client-side timeout.
${RULE_END}`;

function parseArgs(argv) {
  const flags = { install: false, restore: false, configureKey: false, checkOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--install") flags.install = true;
    else if (value === "--restore") flags.restore = true;
    else if (value === "--configure-key") flags.configureKey = true;
    else if (value === "--check-only") flags.checkOnly = true;
    else if (value === "--skip-dependencies" || value === "--no-dependency-check") flags.skipDependencies = true;
    else if (value === "--no-sync") flags.noSync = true;
    else if (value === "--source-root" && argv[i + 1]) flags.sourceRoot = argv[++i];
    else if (value === "--marketplace-path" && argv[i + 1]) flags.marketplacePath = argv[++i];
    else if (value === "--repo" && argv[i + 1]) flags.repo = argv[++i];
    else if (value === "--help" || value === "-h") flags.help = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  return flags;
}

function commandAvailable(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", stdio: "ignore", windowsHide: true });
  return !result.error && result.status === 0;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
    env: options.env,
  });
}

function git(args, cwd, options = {}) {
  const result = run("git", args, { cwd, capture: options.capture });
  if (result.error || result.status !== 0) {
    const details = String(result.stderr || result.error?.message || "git command failed").trim();
    throw new Error(`git ${args[0] || "command"} failed in ${cwd}: ${details}`);
  }
  return String(result.stdout || "").trim();
}

function dependencyCheck(skip = false) {
  if (skip || process.env.AIFORALL_SETUP_SKIP_DEPENDENCY_CHECK === "1") return;
  const missing = [];
  if (!commandAvailable("git")) missing.push("git");
  if (!commandAvailable("node") || Number(process.versions.node.split(".")[0]) < 18) missing.push("Node.js 18+");
  if (!commandAvailable("python") && !commandAvailable("python3")) missing.push("Python 3");
  if (!commandAvailable("codex")) missing.push("Codex CLI");
  const python = commandAvailable("python") ? "python" : "python3";
  if (commandAvailable(python)) {
    const pillow = run(python, ["-c", "import PIL"], { capture: true });
    if (pillow.error || pillow.status !== 0) missing.push("Pillow (Python)");
  }
  if (missing.length > 0) {
    throw new Error(`Missing prerequisites: ${missing.join(", ")}. Use --skip-dependencies only for an offline test.`);
  }
}

function sourceRoot(flags) {
  return resolve(flags.sourceRoot || process.env.AIFORALL_SETUP_SOURCE_ROOT || DEFAULT_SOURCE_ROOT);
}

function marketplacePath(flags) {
  return resolve(flags.marketplacePath || process.env.AIFORALL_MARKETPLACE_PATH || MARKETPLACE_PATH);
}

function normalizeRemote(remote) {
  return String(remote || "").trim().replace(/^git@github\.com:/i, "https://github.com/").replace(/\.git$/i, "").toLowerCase();
}

function syncMarketplace(source, destination, options = {}) {
  if (options.noSync) return destination;
  if (existsSync(destination) && existsSync(source)) {
    try {
      if (realpathSync(source) === realpathSync(destination) && !options.forceUpdate) return destination;
    } catch {
      // One of the paths may be a junction that has just been removed.
    }
  }
  if (!existsSync(destination)) {
    mkdirSync(dirname(destination), { recursive: true });
    let remote = "";
    try {
      remote = git(["config", "--get", "remote.origin.url"], source);
    } catch {
      remote = "";
    }
    // Clone the checked-out source so local repository content is preserved, then
    // retain its GitHub remote for future fast-forward recovery.
    git(["clone", "--local", "--no-hardlinks", source, destination]);
    if (remote) git(["remote", "set-url", "origin", remote], destination);
    return destination;
  }
  if (!existsSync(join(destination, ".git"))) throw new Error(`Persistent marketplace is not a Git repository: ${destination}`);
  const dirty = git(["status", "--porcelain"], destination);
  if (dirty) throw new Error(`Persistent marketplace has local changes; commit or clean it before updating: ${destination}`);
  git(["fetch", "--prune", "origin"], destination);
  let upstream = "";
  try {
    upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], destination);
  } catch {
    try {
      upstream = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], destination);
    } catch {
      upstream = "";
    }
  }
  if (upstream) git(["merge", "--ff-only", upstream], destination);
  return destination;
}

function validateMarketplace(root) {
  const marketplaceFile = join(root, ".agents", "plugins", "marketplace.json");
  const pluginFile = join(root, "plugins", PLUGIN_NAME, ".codex-plugin", "plugin.json");
  if (!existsSync(marketplaceFile) || !existsSync(pluginFile)) throw new Error(`Invalid marketplace: expected ${marketplaceFile} and ${pluginFile}`);
  const marketplace = JSON.parse(readFileSync(marketplaceFile, "utf8"));
  const plugin = JSON.parse(readFileSync(pluginFile, "utf8"));
  if (marketplace.name !== MARKETPLACE_NAME) throw new Error(`Marketplace name must be ${MARKETPLACE_NAME}`);
  if (plugin.name !== PLUGIN_NAME) throw new Error(`Plugin manifest name must be ${PLUGIN_NAME}`);
  return { marketplaceFile, pluginFile, marketplace, plugin };
}

function tomlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function upsertTable(text, header, values) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const output = [];
  let inserted = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== header) {
      output.push(lines[i]);
      continue;
    }
    if (!inserted) {
      output.push(header, ...values);
      inserted = true;
    }
    i += 1;
    while (i < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[i])) i += 1;
    i -= 1;
  }
  if (!inserted) {
    while (output.length && output.at(-1) === "") output.pop();
    if (output.length) output.push("");
    output.push(header, ...values);
  }
  return `${output.join("\n").replace(/\n+$/, "")}\n`;
}

function updateCodexConfig(root, checkOnly = false) {
  const configPath = join(CODEX_HOME, "config.toml");
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const marketplaceValues = [
    "source_type = \"local\"",
    `source = \"${tomlString(root)}\"`,
  ];
  const pluginValues = ["enabled = true"];
  const marketplaceHeader = `[marketplaces.${MARKETPLACE_NAME}]`;
  const pluginHeader = `[plugins."${PLUGIN_NAME}@${MARKETPLACE_NAME}"]`;
  const expected = current.includes(marketplaceHeader) && current.includes(pluginHeader);
  if (checkOnly) return { configPath, configured: expected && current.includes(`source = \"${tomlString(root)}\"`) };
  mkdirSync(CODEX_HOME, { recursive: true });
  let updated = upsertTable(current, marketplaceHeader, marketplaceValues);
  updated = upsertTable(updated, pluginHeader, pluginValues);
  writeFileSync(configPath, updated, "utf8");
  return { configPath, configured: true };
}

function backupAndUpdateManagedFile(filePath, block, checkOnly = false) {
  const exists = existsSync(filePath);
  const current = exists ? readFileSync(filePath, "utf8") : "";
  const pattern = new RegExp(`${RULE_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n[\\s\\S]*?${RULE_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m");
  const next = pattern.test(current)
    ? current.replace(pattern, block)
    : `${current.replace(/\s*$/, "")}${current ? "\n\n" : ""}${block}\n`;
  if (checkOnly) return { changed: next !== current, backedUp: false };
  if (next === current) return { changed: false, backedUp: false };
  mkdirSync(dirname(filePath), { recursive: true });
  let backup = null;
  if (exists) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backup = `${filePath}.bak-${stamp}`;
    copyFileSync(filePath, backup);
  }
  writeFileSync(filePath, next, "utf8");
  return { changed: true, backedUp: backup };
}

function updateGlobalRules(checkOnly = false) {
  const files = [join(CODEX_HOME, "AGENTS.md"), join(CODEX_HOME, "instruction.ctf.md")];
  return files.map((filePath) => ({ filePath, ...backupAndUpdateManagedFile(filePath, RULES, checkOnly) }));
}

function previewKey(key) {
  const value = String(key || "");
  if (!value) return null;
  if (value.length <= 12) return `${value.slice(0, 4)}...${value.slice(-2)}`;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function readPluginConfig() {
  const filePath = join(CODEX_HOME, "aiforall-image-gen-config.json");
  if (!existsSync(filePath)) return { filePath, config: { workers: [] } };
  try {
    const config = JSON.parse(readFileSync(filePath, "utf8"));
    return { filePath, config: config && typeof config === "object" ? config : { workers: [] } };
  } catch (error) {
    throw new Error(`Cannot parse plugin config ${filePath}: ${error.message}`);
  }
}

function normalizePluginConfig(config) {
  const normalized = { ...(config && typeof config === "object" ? config : {}) };
  const workers = Array.isArray(normalized.workers) ? normalized.workers.map((worker) => ({ ...worker })) : [];
  if (normalized.apiKey && workers.length === 0) {
    workers.push({
      id: "worker-1",
      name: "default",
      apiKey: String(normalized.apiKey).trim(),
      enabled: true,
      createdAt: new Date().toISOString(),
      models: ["gpt-image-2"],
      maxInFlight: 2,
    });
  }
  delete normalized.apiKey;
  normalized.workers = workers.filter((worker) => worker?.apiKey).map((worker) => ({
    ...worker,
    enabled: worker.enabled !== false,
    models: Array.isArray(worker.models) && worker.models.length > 0 ? worker.models : ["gpt-image-2"],
    maxInFlight: Number.isFinite(Number(worker.maxInFlight)) ? Math.max(1, Math.min(10, Math.floor(Number(worker.maxInFlight)))) : 2,
  }));
  return normalized;
}

function savePluginConfig(filePath, config) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(filePath, 0o600); } catch { /* Windows ACLs provide the effective protection. */ }
  if (platform() === "win32" && process.env.AIFORALL_SETUP_SKIP_ACL !== "1") {
    const account = process.env.USERDOMAIN && process.env.USERNAME
      ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
      : process.env.USERNAME;
    if (account) {
      const acl = run("icacls", [filePath, "/inheritance:r", "/grant:r", `${account}:F`], { capture: true });
      if (acl.error || acl.status !== 0) console.warn("WARNING: Could not tighten Windows ACLs for the plugin config; review the file permissions.");
    }
  }
}

function upsertWorker(config, key, model, name) {
  const workers = Array.isArray(config.workers) ? [...config.workers] : [];
  const found = workers.find((worker) => worker?.apiKey === key);
  if (found) {
    const models = new Set(Array.isArray(found.models) ? found.models : []);
    models.add(model);
    found.models = [...models];
    found.enabled = true;
    return found;
  }
  const ids = workers.map((worker) => Number(String(worker?.id || "").replace(/^worker-/, ""))).filter(Number.isFinite);
  const nextId = `worker-${(ids.length ? Math.max(...ids) : 0) + 1}`;
  const worker = {
    id: nextId,
    name: name || (model === "gpt-image-1.5" ? "native-transparent" : workers.length ? nextId : "default"),
    apiKey: key,
    enabled: true,
    createdAt: new Date().toISOString(),
    models: [model],
    maxInFlight: 2,
  };
  workers.push(worker);
  config.workers = workers;
  return worker;
}

function configureKeys(checkOnly = false) {
  const { filePath, config: rawConfig } = readPluginConfig();
  const config = normalizePluginConfig(rawConfig);
  const workers = Array.isArray(config.workers) ? config.workers : [];
  const main = process.env.AIFORALL_SETUP_MAIN_KEY?.trim();
  const native = process.env.AIFORALL_SETUP_NATIVE_KEY?.trim();
  if (checkOnly || (!main && !native)) {
    const mainWorker = workers.find((worker) => worker?.models?.includes("gpt-image-2"));
    const nativeWorker = workers.find((worker) => worker?.models?.includes("gpt-image-1.5"));
    console.log(`Config: ${filePath}`);
    console.log(`gpt-image-2: ${previewKey(mainWorker?.apiKey) || "not configured"}`);
    console.log(`gpt-image-1.5: ${previewKey(nativeWorker?.apiKey) || "not configured"}`);
    return;
  }
  if (main) upsertWorker(config, main, "gpt-image-2", "default");
  if (native) upsertWorker(config, native, "gpt-image-1.5", "native-transparent");
  savePluginConfig(filePath, config);
  console.log(`Saved private plugin config: ${filePath}`);
  console.log(`gpt-image-2: ${previewKey(main) || "unchanged"}`);
  console.log(`gpt-image-1.5: ${previewKey(native) || "unchanged"}`);
}

function runCodexSetup(root, options = {}) {
  if (process.env.AIFORALL_SETUP_SKIP_CODEX === "1") {
    console.log("Codex CLI registration skipped by offline test setting.");
    return;
  }
  if (!commandAvailable("codex")) {
    console.warn("WARNING: codex CLI was not found; marketplace registration was written to config.toml only.");
    return;
  }
  const marketplace = run("codex", ["plugin", "marketplace", "add", root], { capture: true });
  if (marketplace.error || marketplace.status !== 0) {
    console.warn(`WARNING: codex plugin marketplace add failed; config fallback was used (${String(marketplace.stderr || "unknown error").trim()}).`);
  }
  const help = run("codex", ["plugin", "--help"], { capture: true });
  const supportsAdd = !help.error && help.status === 0 && /\badd\b/.test(`${help.stdout}\n${help.stderr}`);
  if (!supportsAdd) {
    console.warn("NOTICE: this Codex CLI has no plugin add subcommand; restart Codex and install from the configured marketplace.");
    return;
  }
  const installed = run("codex", ["plugin", "add", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`], { capture: true });
  if (installed.error || installed.status !== 0) {
    console.warn(`WARNING: plugin installation command failed; restart Codex and install from the marketplace (${String(installed.stderr || "unknown error").trim()}).`);
  } else if (!options.quiet) {
    console.log("Codex plugin installed/enabled.");
  }
}

function runPluginChecks(root, options = {}) {
  const script = join(root, "plugins", PLUGIN_NAME, "scripts", "generate.mjs");
  if (!existsSync(script)) throw new Error(`Plugin script missing: ${script}`);
  if (process.env.AIFORALL_SETUP_SKIP_PLUGIN_CHECKS === "1") {
    console.log("Plugin runtime checks skipped by offline test setting.");
    return;
  }
  if (options.checkOnly) {
    const syntax = run(process.execPath, ["--check", script], { cwd: root, capture: true });
    if (syntax.error || syntax.status !== 0) throw new Error(`Node syntax check failed: ${String(syntax.stderr || syntax.error?.message || "unknown error").trim()}`);
    console.log("Plugin manifest and Node syntax: OK");
    return;
  }
  for (const args of [["--get-config"], ["--list-workers"], ["--self-test-workers"]]) {
    const result = run(process.execPath, [script, ...args], { cwd: root, capture: true, env: { ...process.env, CODEX_HOME } });
    if (result.error || result.status !== 0) throw new Error(`Plugin check failed (${args.join(" ")}): ${String(result.stderr || result.error?.message || "unknown error").trim()}`);
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    if (/sk-[A-Za-z0-9_-]{12,}/.test(output)) throw new Error("Plugin check emitted an unmasked API key; refusing to continue.");
  }
  console.log("Plugin manifest, Node syntax, config, workers, and offline self-test: OK");
}

function cacheStatus() {
  const cacheRoot = join(CODEX_HOME, "plugins", "cache", PLUGIN_NAME);
  return { path: cacheRoot, present: existsSync(cacheRoot) && statSync(cacheRoot).isDirectory() };
}

function printHelp() {
  console.log(`aiforall-image-gen Codex setup\n\nUsage:\n  install-codex [--marketplace-path PATH] [--skip-dependencies]\n  restore-codex [--check-only] [--repo URL]\n  configure-key [--check-only]\n\nPersistent marketplace: ${MARKETPLACE_PATH}\nCodex home: ${CODEX_HOME}`);
}

function install(flags) {
  dependencyCheck(flags.skipDependencies);
  const source = sourceRoot(flags);
  const target = marketplacePath(flags);
  const root = syncMarketplace(source, target, { noSync: flags.noSync });
  validateMarketplace(root);
  updateCodexConfig(root, false);
  runCodexSetup(root);
  updateCodexConfig(root, false);
  const rules = updateGlobalRules(false);
  for (const item of rules) if (item.backedUp) console.log(`Backed up ${item.filePath} -> ${item.backedUp}`);
  runPluginChecks(root);
  console.log(`Persistent marketplace: ${root}`);
  console.log(`Install complete. Configure a key with scripts/configure-key.ps1 or scripts/configure-key.sh.`);
}

function restore(flags) {
  const target = marketplacePath(flags);
  if (!existsSync(target)) throw new Error(`Persistent marketplace is missing: ${target}. Run install-codex first.`);
  const remote = normalizeRemote(git(["config", "--get", "remote.origin.url"], target));
  const allowed = normalizeRemote(flags.repo || "https://github.com/heygetit/aiforall-image-gen");
  if (remote && remote !== allowed) console.warn(`WARNING: marketplace remote is ${remote}; expected ${allowed} or an explicitly supplied --repo.`);
  if (!flags.checkOnly) {
    syncMarketplace(target, target, { noSync: false, forceUpdate: true });
    updateCodexConfig(target, false);
    runCodexSetup(target, { quiet: true });
    updateCodexConfig(target, false);
  }
  const metadata = validateMarketplace(target);
  const configState = updateCodexConfig(target, true);
  const cache = cacheStatus();
  console.log(`Marketplace: ${target}`);
  console.log(`Manifest: ${metadata.plugin.name}@${metadata.plugin.version} OK`);
  console.log(`Codex config registration: ${configState.configured ? "present" : "missing"}`);
  console.log(`Plugin cache: ${cache.present ? "present" : `missing (${cache.path})`}`);
  if (!cache.present) console.log("Next step: restart Codex or install the plugin once from the Codex plugin market.");
  runPluginChecks(target, { checkOnly: flags.checkOnly });
  if (flags.checkOnly) console.log("Check-only mode: no files, Git refs, marketplace, or Codex cache were modified.");
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || (!flags.install && !flags.restore && !flags.configureKey)) return printHelp();
  if (flags.configureKey) return configureKeys(flags.checkOnly);
  if (flags.install) return install(flags);
  return restore(flags);
}

try {
  main();
} catch (error) {
  console.error(`ERROR: ${error.message || String(error)}`);
  process.exitCode = 1;
}
