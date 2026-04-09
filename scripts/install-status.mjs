#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { parseArgs, printJson } from "./install-lib.mjs";

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

function expandPendingOperations(state) {
  const expectedByPath = new Map();

  for (const operation of state.pendingOperations ?? []) {
    if (operation.type === "copy" && operation.to) {
      const kind = expectedKindForPath(operation.to);
      const existing = expectedByPath.get(operation.to);
      if (!existing || (existing.kind !== "directory" && kind === "directory")) {
        expectedByPath.set(operation.to, { path: operation.to, kind });
      }
      continue;
    }

    if (operation.type === "generate" && operation.outputRoot) {
      const existing = expectedByPath.get(operation.outputRoot);
      if (!existing || existing.kind !== "directory") {
        expectedByPath.set(operation.outputRoot, {
          path: operation.outputRoot,
          kind: "directory"
        });
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

  const expectedPaths = expandPendingOperations(state);
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
