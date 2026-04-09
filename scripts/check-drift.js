#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { buildOpenAIYaml } = require("./build-skills");
const {
  extractFrontmatter,
  injectClaudeFrontmatter,
  validateSourceSkillMetadata,
} = require("./lib/skill-metadata");

const ROOT = path.resolve(__dirname, "..");
const SKILLS_DIR = path.join(ROOT, "skills");
const AGENTS_SKILLS_DIR = path.join(ROOT, ".agents", "skills");
const CLAUDE_SKILLS_DIR = path.join(ROOT, ".claude", "skills");

function readDirNames(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];

  function visit(currentDir, prefix) {
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

  visit(dir, "");
  return files.sort();
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function compareFile(drift, targetPath, expected, skillName, label) {
  if (!fs.existsSync(targetPath)) {
    drift.push({
      kind: "missing",
      label,
      skill: skillName,
      targetPath,
      message: `${label} is missing`,
    });
    return;
  }

  const actualText = readText(targetPath);
  if (actualText !== expected) {
    drift.push({
      kind: "mismatch",
      label,
      skill: skillName,
      targetPath,
      message: `${label} content drift`,
      expected,
      actual: actualText,
    });
  }
}

function compareAgentsPackage(rootDir, skillName, sourceContent, sourceData, drift) {
  const packageRoot = path.join(rootDir, ".agents", "skills", skillName);
  const expectedFiles = new Map([
    [path.join(packageRoot, "SKILL.md"), sourceContent],
    [path.join(packageRoot, "agents", "openai.yaml"), buildOpenAIYaml(sourceData.name, sourceData.description)],
  ]);

  for (const [targetPath, expected] of expectedFiles) {
    compareFile(drift, targetPath, expected, skillName, path.relative(rootDir, targetPath));
  }

  for (const relativePath of readFilesRecursive(packageRoot)) {
    if (relativePath === "SKILL.md" || relativePath === path.join("agents", "openai.yaml")) {
      continue;
    }
    drift.push({
      kind: "unexpected",
      label: ".agents",
      skill: skillName,
      targetPath: path.join(packageRoot, relativePath),
      message: `unexpected generated file '${path.join(".agents/skills", skillName, relativePath)}'`,
    });
  }
}

function compareClaudePackage(rootDir, skillName, sourceContent, drift) {
  const sourceRoot = path.join(rootDir, "skills", skillName);
  const packageRoot = path.join(rootDir, ".claude", "skills", skillName);
  const expectedFiles = new Map();

  for (const relativePath of readFilesRecursive(sourceRoot)) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const targetPath = path.join(packageRoot, relativePath);
    const sourceText = readText(sourcePath);
    expectedFiles.set(targetPath, relativePath === "SKILL.md" ? injectClaudeFrontmatter(sourceText) : sourceText);
  }

  for (const [targetPath, expected] of expectedFiles) {
    compareFile(drift, targetPath, expected, skillName, path.relative(rootDir, targetPath));
  }

  for (const relativePath of readFilesRecursive(packageRoot)) {
    if (expectedFiles.has(path.join(packageRoot, relativePath))) {
      continue;
    }
    drift.push({
      kind: "unexpected",
      label: ".claude",
      skill: skillName,
      targetPath: path.join(packageRoot, relativePath),
      message: `unexpected generated file '${path.join(".claude/skills", skillName, relativePath)}'`,
    });
  }
}

function collectDrift(rootDir = ROOT) {
  const skillsDir = path.join(rootDir, "skills");
  const agentsSkillsDir = path.join(rootDir, ".agents", "skills");
  const claudeSkillsDir = path.join(rootDir, ".claude", "skills");
  const drift = [];

  const sourceSkills = readDirNames(skillsDir);
  const agentSkills = readDirNames(agentsSkillsDir);
  const claudeSkills = readDirNames(claudeSkillsDir);

  for (const skillName of agentSkills) {
    if (!sourceSkills.includes(skillName)) {
      drift.push({
        kind: "unexpected",
        label: ".agents",
        skill: skillName,
        targetPath: path.join(agentsSkillsDir, skillName),
        message: `unexpected generated skill '.agents/skills/${skillName}'`,
      });
    }
  }

  for (const skillName of claudeSkills) {
    if (!sourceSkills.includes(skillName)) {
      drift.push({
        kind: "unexpected",
        label: ".claude",
        skill: skillName,
        targetPath: path.join(claudeSkillsDir, skillName),
        message: `unexpected generated skill '.claude/skills/${skillName}'`,
      });
    }
  }

  for (const skillName of sourceSkills) {
    const sourcePath = path.join(skillsDir, skillName, "SKILL.md");
    if (!fs.existsSync(sourcePath)) {
      drift.push({
        kind: "missing",
        label: "source",
        skill: skillName,
        targetPath: sourcePath,
        message: `source skill '${skillName}' is missing SKILL.md`,
      });
      continue;
    }

    const sourceContent = readText(sourcePath);
    let sourceFrontmatter;
    try {
      ({ data: sourceFrontmatter } = extractFrontmatter(sourceContent));
    } catch (error) {
      drift.push({
        kind: "invalid-source",
        label: "source",
        skill: skillName,
        targetPath: sourcePath,
        message: error.message,
      });
      continue;
    }

    const validation = validateSourceSkillMetadata({
      dirName: skillName,
      data: sourceFrontmatter,
    });
    if (validation.errors.length > 0) {
      for (const message of validation.errors) {
        drift.push({
          kind: "invalid-source",
          label: "source",
          skill: skillName,
          targetPath: sourcePath,
          message,
        });
      }
      continue;
    }

    compareClaudePackage(rootDir, skillName, sourceContent, drift);
    compareAgentsPackage(rootDir, skillName, sourceContent, sourceFrontmatter, drift);
  }

  return {
    ok: drift.length === 0,
    summary: {
      sourceSkills: sourceSkills.length,
      agentsSkills: agentSkills.length,
      claudeSkills: claudeSkills.length,
      driftCount: drift.length,
    },
    drift,
  };
}

function formatDriftReport(report, options = {}) {
  if (options.json) {
    return JSON.stringify(report, null, 2);
  }

  if (report.ok) {
    return `No drift detected across ${report.summary.sourceSkills} source skill(s).`;
  }

  const lines = [`Drift detected in ${report.summary.driftCount} place(s) across ${report.summary.sourceSkills} source skill(s).`];
  for (const entry of report.drift) {
    lines.push(`- ${path.relative(ROOT, entry.targetPath)}: ${entry.message}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = collectDrift(ROOT);
  const output = formatDriftReport(report, options);
  process.stdout.write(`${output}\n`);
  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  collectDrift,
  formatDriftReport,
  main,
  readFilesRecursive,
  readDirNames,
};
