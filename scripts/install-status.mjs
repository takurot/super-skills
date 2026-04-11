#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { loadManifestBundle, parseArgs, printJson } from "./install-lib.mjs";

function usage() {
  return [
    "Usage: node scripts/install-status.mjs [options]",
    "Options:",
    "  --target <codex|claude|opencode|cursor>",
    "  --target-root <path>",
    "  --json"
  ].join("\n");
}

function statePathFor(options) {
  return path.join(options.targetRoot, ".super-skills", "install-state", `${options.target}.json`);
}

function readStateFile(statePath) {
  if (!fs.existsSync(statePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function expectedKindForPath(relPath) {
  return path.extname(relPath) ? "file" : "directory";
}

function readFilesRecursive(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = [];

  function visit(currentDir, prefix = "") {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const relativePath = path.join(prefix, entry.name);
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, relativePath);
        continue;
      }
      files.push(relativePath);
    }
  }

  visit(dir);
  return files.sort();
}

function pushExpectedPath(expectedByPath, expected) {
  const existing = expectedByPath.get(expected.path);
  if (!existing || (existing.kind !== "directory" && expected.kind === "directory")) {
    expectedByPath.set(expected.path, expected);
  }
}

function skillNamesForModule(module) {
  return module.sourcePaths
    .map((entry) => entry.match(/^skills\/([^/]+)\/\*\*$/))
    .filter(Boolean)
    .map((match) => match[1]);
}

function expandCopyOperation(state, operation) {
  const sourcePath = path.join(state.repoRoot, operation.from);
  if (!fs.existsSync(sourcePath)) {
    return [{ path: operation.to, kind: expectedKindForPath(operation.to) }];
  }

  const sourceStats = fs.statSync(sourcePath);
  if (!sourceStats.isDirectory()) {
    return [{ path: operation.to, kind: "file" }];
  }

  const files = readFilesRecursive(sourcePath);
  if (files.length === 0) {
    return [{ path: operation.to, kind: "directory" }];
  }

  return files.map((relativePath) => ({
    path: path.join(operation.to, relativePath),
    kind: "file"
  }));
}

function expandGenerateOperation(state, operation, module) {
  if (operation.generator === "scripts/install-apply.mjs" && operation.outputRoot === ".codex") {
    return [{ path: path.join(".codex", "config.toml"), kind: "file" }];
  }

  if (operation.generator === "scripts/install-apply.mjs" && operation.outputRoot === ".super-skills/targets") {
    return [{ path: path.join(".super-skills", "targets", `${state.target}.json`), kind: "file" }];
  }

  if (!module) {
    return [{ path: operation.outputRoot, kind: "directory" }];
  }

  const skillNames = skillNamesForModule(module);
  if (skillNames.length === 0) {
    return [{ path: operation.outputRoot, kind: "directory" }];
  }

  const expected = [];
  for (const skillName of skillNames) {
    const generatedRoot = path.join(state.repoRoot, operation.outputRoot, skillName);
    const files = readFilesRecursive(generatedRoot);
    if (files.length === 0) {
      expected.push({
        path: path.join(operation.outputRoot, skillName),
        kind: "directory"
      });
      continue;
    }
    for (const relativePath of files) {
      expected.push({
        path: path.join(operation.outputRoot, skillName, relativePath),
        kind: "file"
      });
    }
  }

  return expected;
}

function expandPendingOperations(state, bundle) {
  const expectedByPath = new Map();

  for (const operation of state.pendingOperations ?? []) {
    const module = bundle.moduleById.get(operation.module);

    if (operation.type === "copy" && operation.to) {
      for (const expected of expandCopyOperation(state, operation)) {
        pushExpectedPath(expectedByPath, expected);
      }
      continue;
    }

    if (operation.type === "generate" && operation.outputRoot) {
      for (const expected of expandGenerateOperation(state, operation, module)) {
        pushExpectedPath(expectedByPath, expected);
      }
    }
  }

  return [...expectedByPath.values()];
}

function checkExpectedPath(targetRoot, expected) {
  const absolutePath = path.join(targetRoot, expected.path);

  if (!fs.existsSync(absolutePath)) {
    return {
      path: expected.path,
      kind: expected.kind,
      status: "MISSING",
      detail: expected.kind === "directory" ? "missing directory" : "missing file"
    };
  }

  const stats = fs.statSync(absolutePath);
  if (expected.kind === "directory") {
    if (!stats.isDirectory()) {
      return {
        path: expected.path,
        kind: expected.kind,
        status: "MISSING",
        detail: "expected directory"
      };
    }

    const entries = fs.readdirSync(absolutePath);
    if (entries.length === 0) {
      return {
        path: expected.path,
        kind: expected.kind,
        status: "MISSING",
        detail: "empty directory"
      };
    }
  } else if (!stats.isFile()) {
    return {
      path: expected.path,
      kind: expected.kind,
      status: "MISSING",
      detail: "expected file"
    };
  }

  return {
    path: expected.path,
    kind: expected.kind,
    status: "OK",
    detail: expected.kind === "directory" ? "non-empty directory" : "file exists"
  };
}

function formatEntry(entry) {
  const suffix = entry.detail ? ` (${entry.detail})` : "";
  return `${entry.status.padEnd(7)} ${entry.path}${suffix}`;
}

function formatReport(report) {
  if (!report.installed) {
    return "NOT INSTALLED";
  }

  return [
    `Installed: ${report.target}  profile=${report.profile}  at=${report.installedAt}`,
    ...report.ok.map(formatEntry),
    ...report.missing.map(formatEntry)
  ].join("\n");
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const statePath = statePathFor(options);
  const state = readStateFile(statePath);
  const bundle = loadManifestBundle();

  if (!state) {
    const report = {
      installed: false,
      target: options.target,
      profile: null,
      ok: [],
      missing: [],
      message: "NOT INSTALLED"
    };

    if (options.json) {
      printJson(report);
    } else {
      process.stdout.write(`${formatReport(report)}\n`);
    }

    process.exit(1);
  }

  const expectedPaths = expandPendingOperations(state, bundle);
  const checked = expectedPaths.map((entry) => checkExpectedPath(options.targetRoot, entry));
  const ok = checked.filter((entry) => entry.status === "OK");
  const missing = checked.filter((entry) => entry.status === "MISSING");
  const report = {
    installed: true,
    target: state.target ?? options.target,
    profile: state.profile ?? null,
    installedAt: state.installedAt ?? null,
    ok,
    missing
  };

  if (options.json) {
    printJson(report);
  } else {
    process.stdout.write(`${formatReport(report)}\n`);
  }

  process.exit(missing.length === 0 ? 0 : 1);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exit(1);
}
