#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const COMPONENTS_PATH = path.join(repoRoot, "manifests", "install-components.json");
const PROFILES_PATH = path.join(repoRoot, "manifests", "install-profiles.json");
const MODULES_PATH = path.join(repoRoot, "manifests", "install-modules.json");

const SUPPORTED_TARGETS = ["codex", "claude", "opencode", "cursor"];
const COMPONENT_FAMILY_PREFIXES = ["baseline", "workflow", "capability", "agent", "mcp", "plugin", "target"];

function unique(values) {
  return [...new Set(values)];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadManifestBundle() {
  const components = readJson(COMPONENTS_PATH);
  const profiles = readJson(PROFILES_PATH);
  const modules = readJson(MODULES_PATH);

  const bundle = {
    components,
    profiles,
    modules,
    componentById: new Map(components.components.map((entry) => [entry.id, entry])),
    profileById: new Map(profiles.profiles.map((entry) => [entry.id, entry])),
    moduleById: new Map(modules.modules.map((entry) => [entry.id, entry]))
  };

  return bundle;
}

function maybeReadConfig(configPath) {
  if (!configPath) {
    return {};
  }

  const resolved = path.resolve(process.cwd(), configPath);
  return readJson(resolved);
}

function parseListValue(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const options = {
    profile: "core",
    target: "codex",
    with: [],
    without: [],
    dryRun: false,
    force: false,
    json: false,
    config: undefined,
    targetRoot: process.cwd(),
    statePath: undefined,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--profile") {
      options.profile = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--profile=")) {
      options.profile = arg.slice("--profile=".length);
      continue;
    }

    if (arg === "--target") {
      options.target = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--target=")) {
      options.target = arg.slice("--target=".length);
      continue;
    }

    if (arg === "--with") {
      options.with.push(...parseListValue(argv[index + 1]));
      index += 1;
      continue;
    }

    if (arg.startsWith("--with=")) {
      options.with.push(...parseListValue(arg.slice("--with=".length)));
      continue;
    }

    if (arg === "--without") {
      options.without.push(...parseListValue(argv[index + 1]));
      index += 1;
      continue;
    }

    if (arg.startsWith("--without=")) {
      options.without.push(...parseListValue(arg.slice("--without=".length)));
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--config") {
      options.config = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--config=")) {
      options.config = arg.slice("--config=".length);
      continue;
    }

    if (arg === "--target-root") {
      options.targetRoot = path.resolve(process.cwd(), argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--target-root=")) {
      options.targetRoot = path.resolve(process.cwd(), arg.slice("--target-root=".length));
      continue;
    }

    if (arg === "--state-path") {
      options.statePath = path.resolve(process.cwd(), argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--state-path=")) {
      options.statePath = path.resolve(process.cwd(), arg.slice("--state-path=".length));
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  const config = maybeReadConfig(options.config);
  const merged = {
    ...config,
    ...options,
    with: unique([...(config.with ?? []), ...options.with]),
    without: unique([...(config.without ?? []), ...options.without])
  };

  return merged;
}

function validateManifestConsistency(bundle) {
  const errors = [];
  const warnings = [];

  if (bundle.components.version !== 1 || bundle.profiles.version !== 1 || bundle.modules.version !== 1) {
    errors.push("All installer manifests must currently use version 1.");
  }

  const componentIds = bundle.components.components.map((entry) => entry.id);
  const profileIds = bundle.profiles.profiles.map((entry) => entry.id);
  const moduleIds = bundle.modules.modules.map((entry) => entry.id);

  if (new Set(componentIds).size !== componentIds.length) {
    errors.push("Duplicate component ids detected.");
  }

  if (new Set(profileIds).size !== profileIds.length) {
    errors.push("Duplicate profile ids detected.");
  }

  if (new Set(moduleIds).size !== moduleIds.length) {
    errors.push("Duplicate module ids detected.");
  }

  for (const component of bundle.components.components) {
    const [family] = component.id.split(":");
    if (!COMPONENT_FAMILY_PREFIXES.includes(family)) {
      errors.push(`Component ${component.id} uses unsupported family prefix ${family}.`);
    }

    if (component.family !== family) {
      errors.push(`Component ${component.id} family field must match id prefix.`);
    }

    for (const target of component.targets ?? []) {
      if (!SUPPORTED_TARGETS.includes(target)) {
        errors.push(`Component ${component.id} references unsupported target ${target}.`);
      }
    }

    for (const moduleId of component.modules ?? []) {
      if (!bundle.moduleById.has(moduleId)) {
        errors.push(`Component ${component.id} references unknown module ${moduleId}.`);
      }
    }
  }

  for (const profile of bundle.profiles.profiles) {
    for (const componentId of profile.components ?? []) {
      if (!bundle.componentById.has(componentId)) {
        errors.push(`Profile ${profile.id} references unknown component ${componentId}.`);
      }
    }
  }

  for (const module of bundle.modules.modules) {
    if (!["authored", "generated"].includes(module.kind)) {
      errors.push(`Module ${module.id} has unsupported kind ${module.kind}.`);
    }

    const targetEntries = Object.entries(module.targets ?? {});
    if (targetEntries.length === 0) {
      errors.push(`Module ${module.id} must declare at least one target mapping.`);
      continue;
    }

    for (const [target, targetSpec] of targetEntries) {
      if (!SUPPORTED_TARGETS.includes(target)) {
        errors.push(`Module ${module.id} references unsupported target ${target}.`);
      }

      if (!["full", "scaffold"].includes(targetSpec.status)) {
        errors.push(`Module ${module.id} target ${target} must declare status full or scaffold.`);
      }

      if (!Array.isArray(targetSpec.targetPaths) || targetSpec.targetPaths.length === 0) {
        errors.push(`Module ${module.id} target ${target} must declare targetPaths.`);
      }

      if (!Array.isArray(targetSpec.operations) || targetSpec.operations.length === 0) {
        errors.push(`Module ${module.id} target ${target} must declare operations.`);
      }
    }

    if (module.kind === "generated" && !module.generatedBy) {
      errors.push(`Generated module ${module.id} must declare generatedBy.`);
    }

    if (module.kind === "authored" && module.generatedBy) {
      warnings.push(`Authored module ${module.id} declares generatedBy and it will be ignored.`);
    }
  }

  return { errors, warnings };
}

function resolveSelection(bundle, options) {
  const errors = [];
  const warnings = [];
  const target = options.target || "codex";
  const profileId = options.profile || "core";

  if (!SUPPORTED_TARGETS.includes(target)) {
    errors.push(`Unsupported target: ${target}`);
  }

  const profile = bundle.profileById.get(profileId);
  if (!profile) {
    errors.push(`Unknown profile: ${profileId}`);
  }

  for (const componentId of options.with) {
    if (!bundle.componentById.has(componentId)) {
      errors.push(`Unknown component in --with: ${componentId}`);
    }
  }

  for (const componentId of options.without) {
    if (!bundle.componentById.has(componentId)) {
      errors.push(`Unknown component in --without: ${componentId}`);
    }
  }

  if (errors.length > 0) {
    return { errors, warnings };
  }

  const requestedComponents = new Set(profile.components);
  requestedComponents.add(`target:${target}`);

  for (const componentId of options.with) {
    requestedComponents.add(componentId);
  }

  for (const componentId of options.without) {
    requestedComponents.delete(componentId);
  }

  const selectedComponents = [];
  const skippedComponents = [];

  for (const componentId of requestedComponents) {
    const component = bundle.componentById.get(componentId);
    if (!component) {
      continue;
    }

    if (!(component.targets ?? []).includes(target)) {
      skippedComponents.push({
        id: component.id,
        reason: `Component does not support target ${target}.`
      });
      continue;
    }

    const explicitByWith = options.with.includes(component.id);
    const explicitByProfile = profileId !== "core" && (profile.components ?? []).includes(component.id);

    if (component.requiresExplicitOptIn && !(explicitByWith || explicitByProfile)) {
      errors.push(`Component ${component.id} requires explicit opt-in for target ${target}.`);
      continue;
    }

    selectedComponents.push(component);
  }

  const selectedModuleIds = unique(selectedComponents.flatMap((component) => component.modules ?? []));
  const selectedModules = [];
  const skippedModules = [];

  for (const moduleId of selectedModuleIds) {
    const module = bundle.moduleById.get(moduleId);
    if (!module) {
      errors.push(`Resolved unknown module ${moduleId}.`);
      continue;
    }

    const targetSpec = module.targets?.[target];
    if (!targetSpec) {
      skippedModules.push({
        id: module.id,
        reason: `Module has no target mapping for ${target}.`
      });
      continue;
    }

    selectedModules.push({
      ...module,
      targetSpec
    });
  }

  const targetPaths = unique(selectedModules.flatMap((module) => module.targetSpec.targetPaths ?? []));
  const requiredPrerequisites = unique([
    ...selectedModules
      .filter((module) => module.requiresSecrets)
      .map((module) => `${module.id} requires user-managed secrets or environment variables.`),
    ...selectedModules
      .flatMap((module) =>
        (module.targetSpec.operations ?? [])
          .filter((operation) => operation.type === "generate" && operation.generator)
          .map((operation) => `${module.id} depends on ${operation.generator}.`)
      )
  ]);

  const riskNotes = unique([
    ...selectedComponents
      .filter((component) => component.riskLevel !== "low")
      .map((component) => `${component.id} is labeled ${component.riskLevel} risk.`),
    ...selectedModules
      .filter((module) => module.riskLevel !== "low")
      .map((module) => `${module.id} is labeled ${module.riskLevel} risk for ${target}.`),
    ...selectedModules
      .filter((module) => module.targetSpec.status === "scaffold")
      .map((module) => `${module.id} is scaffold-only on ${target}.`)
  ]);

  return {
    errors,
    warnings,
    target,
    profile,
    selectedComponents,
    skippedComponents,
    selectedModules,
    skippedModules,
    targetPaths,
    requiredPrerequisites,
    riskNotes,
    targetSupport: selectedModules.every((module) => module.targetSpec.status === "full") ? "full" : "partial"
  };
}

function buildPlan(bundle, options) {
  const manifestValidation = validateManifestConsistency(bundle);
  const selection = resolveSelection(bundle, options);
  const errors = [...manifestValidation.errors, ...(selection.errors ?? [])];
  const warnings = [...manifestValidation.warnings, ...(selection.warnings ?? [])];

  return {
    status: errors.length === 0 ? "ok" : "error",
    errors,
    warnings,
    input: {
      profile: options.profile,
      target: options.target,
      with: options.with,
      without: options.without,
      dryRun: Boolean(options.dryRun),
      json: Boolean(options.json),
      config: options.config ?? null,
      targetRoot: options.targetRoot
    },
    summary: errors.length > 0
      ? null
      : {
          profile: selection.profile.id,
          target: selection.target,
          targetSupport: selection.targetSupport,
          componentCount: selection.selectedComponents.length,
          moduleCount: selection.selectedModules.length
        },
    selection: errors.length > 0 ? null : selection
  };
}

function formatPlan(plan) {
  if (plan.status === "error") {
    return [
      "Installer plan failed.",
      ...plan.errors.map((error) => `- ${error}`),
      ...plan.warnings.map((warning) => `- warning: ${warning}`)
    ].join("\n");
  }

  const selection = plan.selection;

  return [
    `Profile: ${selection.profile.id}`,
    `Target: ${selection.target} (${selection.targetSupport})`,
    `Selected components (${selection.selectedComponents.length}):`,
    ...selection.selectedComponents.map((component) => `- ${component.id}: ${component.description}`),
    `Selected modules (${selection.selectedModules.length}):`,
    ...selection.selectedModules.map((module) => `- ${module.id} [${module.targetSpec.status}]`),
    `Skipped components (${selection.skippedComponents.length}):`,
    ...(selection.skippedComponents.length > 0
      ? selection.skippedComponents.map((entry) => `- ${entry.id}: ${entry.reason}`)
      : ["- none"]),
    `Skipped modules (${selection.skippedModules.length}):`,
    ...(selection.skippedModules.length > 0
      ? selection.skippedModules.map((entry) => `- ${entry.id}: ${entry.reason}`)
      : ["- none"]),
    `Target paths (${selection.targetPaths.length}):`,
    ...selection.targetPaths.map((targetPath) => `- ${targetPath}`),
    `Prerequisites (${selection.requiredPrerequisites.length}):`,
    ...(selection.requiredPrerequisites.length > 0
      ? selection.requiredPrerequisites.map((note) => `- ${note}`)
      : ["- none"]),
    `Risk notes (${selection.riskNotes.length}):`,
    ...(selection.riskNotes.length > 0
      ? selection.riskNotes.map((note) => `- ${note}`)
      : ["- none"]),
    ...(plan.warnings.length > 0 ? ["Warnings:", ...plan.warnings.map((warning) => `- ${warning}`)] : [])
  ].join("\n");
}

function ensurePlanOk(plan) {
  if (plan.status === "error") {
    const error = new Error(`Installer command failed with ${plan.errors.length} error(s).`);
    error.plan = plan;
    throw error;
  }

  return plan;
}

function defaultStatePath(options) {
  return options.statePath ?? path.join(options.targetRoot, ".super-skills", "install-state", `${options.target}.json`);
}

function buildStatePayload(plan, options) {
  const selection = plan.selection;
  return {
    version: 1,
    installedAt: new Date().toISOString(),
    repoRoot,
    profile: selection.profile.id,
    target: selection.target,
    targetSupport: selection.targetSupport,
    selectedComponents: selection.selectedComponents.map((component) => component.id),
    selectedModules: selection.selectedModules.map((module) => module.id),
    targetPaths: selection.targetPaths,
    pendingOperations: selection.selectedModules.flatMap((module) =>
      module.targetSpec.operations.map((operation) => ({
        module: module.id,
        ...operation
      }))
    ),
    limitations: [
      "install-apply supports the currently modeled copy, generate, and state-write operations.",
      "Drift detection and merge-safe upgrades for authored target files remain limited."
    ],
    targetRoot: options.targetRoot
  };
}

function writeStateFile(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function formatValidationReport(report) {
  if (report.status === "error") {
    return [
      "Installer validation failed.",
      ...report.errors.map((error) => `- ${error}`),
      ...report.warnings.map((warning) => `- warning: ${warning}`)
    ].join("\n");
  }

  return [
    "Installer validation passed.",
    `- profile: ${report.selection.profile.id}`,
    `- target: ${report.selection.target}`,
    `- components: ${report.selection.selectedComponents.length}`,
    `- modules: ${report.selection.selectedModules.length}`,
    ...report.warnings.map((warning) => `- warning: ${warning}`)
  ].join("\n");
}

function buildListing(bundle) {
  return {
    targets: SUPPORTED_TARGETS,
    profiles: bundle.profiles.profiles.map((profile) => ({
      id: profile.id,
      description: profile.description,
      componentCount: profile.components.length
    })),
    components: bundle.components.components.map((component) => ({
      id: component.id,
      family: component.family,
      riskLevel: component.riskLevel,
      requiresExplicitOptIn: component.requiresExplicitOptIn,
      targets: component.targets
    })),
    modules: bundle.modules.modules.map((module) => ({
      id: module.id,
      kind: module.kind,
      riskLevel: module.riskLevel,
      targets: Object.keys(module.targets ?? {})
    }))
  };
}

function formatListing(listing) {
  return [
    "Targets:",
    ...listing.targets.map((target) => `- ${target}`),
    "Profiles:",
    ...listing.profiles.map((profile) => `- ${profile.id}: ${profile.description}`),
    "Components:",
    ...listing.components.map(
      (component) =>
        `- ${component.id} [${component.family}] risk=${component.riskLevel} opt-in=${component.requiresExplicitOptIn}`
    )
  ].join("\n");
}

function printJson(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export {
  buildListing,
  buildPlan,
  buildStatePayload,
  defaultStatePath,
  ensurePlanOk,
  formatListing,
  formatPlan,
  formatValidationReport,
  loadManifestBundle,
  parseArgs,
  printJson,
  writeStateFile
};
