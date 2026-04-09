#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildPlan,
  buildStatePayload,
  defaultStatePath,
  ensurePlanOk,
  formatPlan,
  loadManifestBundle,
  parseArgs,
  printJson,
  writeStateFile
} from "./install-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ranGenerators = new Set();

function normalizePath(filePath) {
  return path.resolve(filePath);
}

function samePath(left, right) {
  return normalizePath(left) === normalizePath(right);
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readFileIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

function copyFileSafely(sourcePath, destinationPath, { generated = false, force = false } = {}) {
  if (samePath(sourcePath, destinationPath)) {
    return;
  }

  const sourceContent = fs.readFileSync(sourcePath, "utf8");
  const existingContent = readFileIfExists(destinationPath);
  if (existingContent !== null && existingContent !== sourceContent && !generated && !force) {
    throw new Error(`Refusing to overwrite authored file: ${destinationPath}`);
  }

  ensureParent(destinationPath);
  fs.writeFileSync(destinationPath, sourceContent, "utf8");
}

function copyDirectorySafely(sourcePath, destinationPath, options = {}) {
  const { generated = false } = options;
  if (samePath(sourcePath, destinationPath)) {
    return;
  }

  if (generated && fs.existsSync(destinationPath)) {
    fs.rmSync(destinationPath, { recursive: true, force: true });
  }

  ensureDir(destinationPath);
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    copyPath(
      path.join(sourcePath, entry.name),
      path.join(destinationPath, entry.name),
      options
    );
  }
}

function copyPath(sourcePath, destinationPath, options = {}) {
  const stats = fs.statSync(sourcePath);
  if (stats.isDirectory()) {
    copyDirectorySafely(sourcePath, destinationPath, options);
    return;
  }
  copyFileSafely(sourcePath, destinationPath, options);
}

function runGenerator(generatorPath) {
  if (ranGenerators.has(generatorPath)) {
    return;
  }

  const result = spawnSync(process.execPath, [generatorPath], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Generator failed: ${generatorPath}`);
  }
  ranGenerators.add(generatorPath);
}

function skillNamesForModule(module) {
  return module.sourcePaths
    .map((entry) => entry.match(/^skills\/([^/]+)\/\*\*$/))
    .filter(Boolean)
    .map((match) => match[1]);
}

function copyGeneratedSkillSet(module, sourceRoot, destinationRoot, options = {}) {
  for (const skillName of skillNamesForModule(module)) {
    copyDirectorySafely(
      path.join(repoRoot, sourceRoot, skillName),
      path.join(destinationRoot, skillName),
      { ...options, generated: true }
    );
  }
}

function writeGeneratedTargetMetadata(plan, options) {
  const metadataPath = path.join(
    options.targetRoot,
    ".super-skills",
    "targets",
    `${plan.selection.target}.json`
  );
  ensureParent(metadataPath);
  fs.writeFileSync(
    metadataPath,
    `${JSON.stringify(
      {
        version: 1,
        target: plan.selection.target,
        profile: plan.selection.profile.id,
        targetSupport: plan.selection.targetSupport,
        components: plan.selection.selectedComponents.map((component) => component.id),
        modules: plan.selection.selectedModules.map((module) => module.id)
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function applyCopyOperation(operation, options) {
  copyPath(
    path.join(repoRoot, operation.from),
    path.join(options.targetRoot, operation.to),
    options
  );
}

function applyGenerateOperation(module, operation, plan, options) {
  if (operation.generator === "scripts/build-skills.js") {
    runGenerator(operation.generator);
    copyGeneratedSkillSet(
      module,
      ".agents/skills",
      path.join(options.targetRoot, ".agents", "skills"),
      options
    );
    return;
  }

  if (operation.generator === "scripts/build-claude-skills.js") {
    runGenerator(operation.generator);
    copyGeneratedSkillSet(
      module,
      ".claude/skills",
      path.join(options.targetRoot, ".claude", "skills"),
      options
    );
    return;
  }

  if (operation.generator === "scripts/install-apply.mjs" && operation.outputRoot === ".codex") {
    copyFileSafely(
      path.join(repoRoot, ".codex", "config.toml"),
      path.join(options.targetRoot, ".codex", "config.toml"),
      { ...options, generated: true }
    );
    return;
  }

  if (operation.generator === "scripts/install-apply.mjs" && operation.outputRoot === ".super-skills/targets") {
    writeGeneratedTargetMetadata(plan, options);
    return;
  }

  throw new Error(`Unsupported generate operation for ${module.id}: ${operation.generator}`);
}

function applyPlan(plan, options) {
  for (const module of plan.selection.selectedModules) {
    for (const operation of module.targetSpec.operations) {
      if (operation.type === "copy") {
        applyCopyOperation(operation, options);
        continue;
      }
      if (operation.type === "generate") {
        applyGenerateOperation(module, operation, plan, options);
        continue;
      }
      if (operation.type === "write-state") {
        continue;
      }
      throw new Error(`Unsupported operation type: ${operation.type}`);
    }
  }
}

function usage() {
  return [
    "Usage: node scripts/install-apply.mjs [options]",
    "Options:",
    "  --profile <name>",
    "  --target <codex|claude|opencode|cursor>",
    "  --with <component>[,<component>...]",
    "  --without <component>[,<component>...]",
    "  --config <json-file>",
    "  --target-root <path>",
    "  --state-path <path>",
    "  --dry-run",
    "  --force",
    "  --json"
  ].join("\n");
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const bundle = loadManifestBundle();
  const plan = ensurePlanOk(buildPlan(bundle, options));
  const state = buildStatePayload(plan, options);
  const statePath = defaultStatePath(options);

  if (options.dryRun) {
    if (options.json) {
      printJson({
        mode: "dry-run",
        plan,
        statePath,
        state,
        force: options.force
      });
    } else {
      process.stdout.write(`${formatPlan(plan)}\n`);
      if (options.force) {
        process.stdout.write("\nForce mode: authored file overwrites enabled\n");
      }
      process.stdout.write(`\nDry run only. State would be written to ${statePath}\n`);
      process.stdout.write("install-apply dry run completed. No files were written.\n");
    }
    process.exit(0);
  }

  applyPlan(plan, options);
  writeStateFile(statePath, state);

  if (options.json) {
    printJson({
      status: "ok",
      applied: true,
      statePath,
      state
    });
  } else {
    process.stdout.write(`${formatPlan(plan)}\n`);
    process.stdout.write(`\nState written to ${statePath}\n`);
    process.stdout.write("install-apply applied supported copy/generate operations and recorded installer state.\n");
  }
} catch (error) {
  if (error.plan && process.argv.includes("--json")) {
    printJson(error.plan);
    process.exit(1);
  }

  process.stderr.write(`${error.message}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exit(1);
}
