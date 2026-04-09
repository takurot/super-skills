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

function makeDriftEntry(rootDir, skillName, targetPath, reason) {
  return {
    skill: skillName,
    artifact: path.relative(rootDir, targetPath),
    reason,
  };
}

function compareFile(drifted, rootDir, targetPath, expected, skillName) {
  if (!fs.existsSync(targetPath)) {
    drifted.push(makeDriftEntry(rootDir, skillName, targetPath, "missing"));
    return;
  }

  const actualText = readText(targetPath);
  if (actualText !== expected) {
    drifted.push(makeDriftEntry(rootDir, skillName, targetPath, "stale"));
  }
}

function compareAgentsPackage(rootDir, skillName, sourceContent, sourceData, drifted) {
  const packageRoot = path.join(rootDir, ".agents", "skills", skillName);
  const expectedFiles = new Map([
    [path.join(packageRoot, "SKILL.md"), sourceContent],
    [path.join(packageRoot, "agents", "openai.yaml"), buildOpenAIYaml(sourceData.name, sourceData.description)],
  ]);

  for (const [targetPath, expected] of expectedFiles) {
    compareFile(drifted, rootDir, targetPath, expected, skillName);
  }

  for (const relativePath of readFilesRecursive(packageRoot)) {
    if (relativePath === "SKILL.md" || relativePath === path.join("agents", "openai.yaml")) {
      continue;
    }
    drifted.push(makeDriftEntry(rootDir, skillName, path.join(packageRoot, relativePath), "unexpected"));
  }
}

function compareClaudePackage(rootDir, skillName, sourceContent, drifted) {
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
    compareFile(drifted, rootDir, targetPath, expected, skillName);
  }

  for (const relativePath of readFilesRecursive(packageRoot)) {
    if (expectedFiles.has(path.join(packageRoot, relativePath))) {
      continue;
    }
    drifted.push(makeDriftEntry(rootDir, skillName, path.join(packageRoot, relativePath), "unexpected"));
  }
}

function collectDrift(rootDir = ROOT) {
  const skillsDir = path.join(rootDir, "skills");
  const agentsSkillsDir = path.join(rootDir, ".agents", "skills");
  const claudeSkillsDir = path.join(rootDir, ".claude", "skills");
  const drifted = [];
  const ok = [];

  const sourceSkills = readDirNames(skillsDir);
  const agentSkills = readDirNames(agentsSkillsDir);
  const claudeSkills = readDirNames(claudeSkillsDir);

  for (const skillName of agentSkills) {
    if (!sourceSkills.includes(skillName)) {
      drifted.push(makeDriftEntry(rootDir, skillName, path.join(agentsSkillsDir, skillName), "unexpected"));
    }
  }

  for (const skillName of claudeSkills) {
    if (!sourceSkills.includes(skillName)) {
      drifted.push(makeDriftEntry(rootDir, skillName, path.join(claudeSkillsDir, skillName), "unexpected"));
    }
  }

  for (const skillName of sourceSkills) {
    const sourcePath = path.join(skillsDir, skillName, "SKILL.md");
    const driftCountBefore = drifted.length;
    if (!fs.existsSync(sourcePath)) {
      drifted.push(makeDriftEntry(rootDir, skillName, sourcePath, "missing"));
      continue;
    }

    const sourceContent = readText(sourcePath);
    let sourceFrontmatter;
    try {
      ({ data: sourceFrontmatter } = extractFrontmatter(sourceContent));
    } catch (error) {
      drifted.push(makeDriftEntry(rootDir, skillName, sourcePath, "invalid"));
      continue;
    }

    const validation = validateSourceSkillMetadata({
      dirName: skillName,
      data: sourceFrontmatter,
    });
    if (validation.errors.length > 0) {
      for (const _message of validation.errors) {
        drifted.push(makeDriftEntry(rootDir, skillName, sourcePath, "invalid"));
      }
      continue;
    }

    compareClaudePackage(rootDir, skillName, sourceContent, drifted);
    compareAgentsPackage(rootDir, skillName, sourceContent, sourceFrontmatter, drifted);
    if (drifted.length === driftCountBefore) {
      ok.push(skillName);
    }
  }

  return {
    drifted,
    ok,
  };
}

function formatDriftReport(report, options = {}) {
  if (options.json) {
    return JSON.stringify(report, null, 2);
  }

  const skillNames = [...new Set([...report.drifted.map((entry) => entry.skill), ...report.ok])].sort();
  const width = skillNames.reduce((max, skill) => Math.max(max, skill.length), 0);
  const lines = [];

  for (const skillName of skillNames) {
    const entries = report.drifted.filter((entry) => entry.skill === skillName);
    if (entries.length === 0) {
      lines.push(`OK     ${skillName}`);
      continue;
    }
    for (const entry of entries) {
      lines.push(`DRIFT  ${skillName.padEnd(width)}   ${entry.artifact} (${entry.reason})`);
    }
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
  process.exit(report.drifted.length === 0 ? 0 : 1);
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
