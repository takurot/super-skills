import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { parseArgs } from "../scripts/install-lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const applyScript = path.join(repoRoot, "scripts", "install-apply.mjs");
const statusScript = path.join(repoRoot, "scripts", "install-status.mjs");
const claudeTemplatePath = path.join(repoRoot, "plugins", "claude", "templates", "AGENTS.md");

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "super-skills-install-"));
}

function runNode(scriptPath, args, options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    ...options
  });
}

test("parseArgs defaults force to false and accepts --force", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.force, false);

  const withForce = parseArgs(["--force"]);
  assert.equal(withForce.force, true);
});

test("install-apply supports --force and dry-run reports force mode", () => {
  const tempRoot = makeTempRoot();
  const result = runNode(applyScript, [
    "--dry-run",
    "--force",
    "--profile",
    "developer",
    "--target",
    "claude",
    "--target-root",
    tempRoot
  ]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Force mode: authored file overwrites enabled/);
});

test("install-apply overwrites edited authored files when --force is set", () => {
  const tempRoot = makeTempRoot();
  const targetFile = path.join(tempRoot, ".claude", "AGENTS.md");
  const originalSource = fs.readFileSync(claudeTemplatePath, "utf8");

  let result = runNode(applyScript, [
    "--profile",
    "developer",
    "--target",
    "claude",
    "--target-root",
    tempRoot
  ]);
  assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(targetFile, "utf8"), originalSource);

  fs.writeFileSync(targetFile, `${originalSource}\nLOCAL EDIT\n`, "utf8");

  result = runNode(applyScript, [
    "--profile",
    "developer",
    "--target",
    "claude",
    "--target-root",
    tempRoot
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to overwrite authored file/);

  result = runNode(applyScript, [
    "--force",
    "--profile",
    "developer",
    "--target",
    "claude",
    "--target-root",
    tempRoot
  ]);
  assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(targetFile, "utf8"), originalSource);
});

test("install-status reports installed, missing, and not installed states", () => {
  const installedRoot = makeTempRoot();
  let result = runNode(applyScript, [
    "--profile",
    "developer",
    "--target",
    "claude",
    "--target-root",
    installedRoot
  ]);
  assert.equal(result.status, 0);

  result = runNode(statusScript, [
    "--json",
    "--target",
    "claude",
    "--target-root",
    installedRoot
  ]);
  assert.equal(result.status, 0);

  const statusJson = JSON.parse(result.stdout);
  assert.equal(statusJson.installed, true);
  assert.equal(statusJson.target, "claude");
  assert.equal(statusJson.profile, "developer");
  assert.ok(statusJson.ok.some((entry) => entry.path === ".claude/AGENTS.md"));
  assert.ok(statusJson.ok.some((entry) => entry.path === ".claude/skills/review/SKILL.md"));
  assert.deepEqual(statusJson.missing, []);

  fs.rmSync(path.join(installedRoot, ".claude", "skills", "review", "SKILL.md"));

  result = runNode(statusScript, [
    "--target",
    "claude",
    "--target-root",
    installedRoot
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /MISSING\s+\.claude\/skills\/review\/SKILL\.md/);

  const codexRoot = makeTempRoot();
  result = runNode(applyScript, [
    "--profile",
    "developer",
    "--target",
    "codex",
    "--target-root",
    codexRoot
  ]);
  assert.equal(result.status, 0);

  fs.rmSync(path.join(codexRoot, ".codex", "agents", "explorer.toml"));

  result = runNode(statusScript, [
    "--target",
    "codex",
    "--target-root",
    codexRoot
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /MISSING\s+\.codex\/agents\/explorer\.toml/);

  const authoredMissingRoot = makeTempRoot();
  result = runNode(applyScript, [
    "--profile",
    "developer",
    "--target",
    "claude",
    "--target-root",
    authoredMissingRoot
  ]);
  assert.equal(result.status, 0);

  fs.rmSync(path.join(authoredMissingRoot, ".claude", "AGENTS.md"));

  result = runNode(statusScript, [
    "--target",
    "claude",
    "--target-root",
    authoredMissingRoot
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /MISSING\s+\.claude\/AGENTS\.md/);

  const emptyRoot = makeTempRoot();
  result = runNode(statusScript, [
    "--target",
    "claude",
    "--target-root",
    emptyRoot
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /NOT INSTALLED/);
});
