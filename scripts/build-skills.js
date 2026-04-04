#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  extractFrontmatter,
  normalizeDescription,
  validateSourceSkillMetadata,
} = require("./lib/skill-metadata");

const ROOT = path.resolve(__dirname, "..");
const SKILLS_DIR = path.join(ROOT, "skills");
const AGENTS_SKILLS_DIR = path.join(ROOT, ".agents", "skills");

function readDirSafe(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true });
}

function sentenceCaseToDisplayName(value) {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function shortDescription(description) {
  const collapsed = normalizeDescription(description);
  if (collapsed.length <= 120) return collapsed;
  const slice = collapsed.slice(0, 117);
  const lastSpace = slice.lastIndexOf(" ");
  return `${slice.slice(0, lastSpace > 40 ? lastSpace : 117)}...`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function removeDirContents(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function buildOpenAIYaml(name, description) {
  const displayName = sentenceCaseToDisplayName(name);
  const short = shortDescription(description);
  return `interface:\n  display_name: ${JSON.stringify(displayName)}\n  short_description: ${JSON.stringify(short)}\n  default_prompt: ${JSON.stringify(`Use ${displayName} for this task.`)}\npolicy:\n  allow_implicit_invocation: true\n`;
}

function main() {
  ensureDir(AGENTS_SKILLS_DIR);
  removeDirContents(AGENTS_SKILLS_DIR);

  const skillDirs = readDirSafe(SKILLS_DIR)
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const dirName of skillDirs) {
    const skillPath = path.join(SKILLS_DIR, dirName, "SKILL.md");
    if (!fs.existsSync(skillPath)) {
      throw new Error(`Missing SKILL.md in skills/${dirName}`);
    }

    const source = fs.readFileSync(skillPath, "utf8");
    const { data } = extractFrontmatter(source);
    const { errors, warnings } = validateSourceSkillMetadata({
      dirName,
      data,
    });

    if (errors.length > 0) {
      throw new Error(errors.join("\n"));
    }

    for (const warning of warnings) {
      console.warn(`WARN: ${warning}`);
    }

    const outDir = path.join(AGENTS_SKILLS_DIR, dirName);
    const metaDir = path.join(outDir, "agents");
    ensureDir(metaDir);

    fs.writeFileSync(path.join(outDir, "SKILL.md"), source);
    fs.writeFileSync(path.join(metaDir, "openai.yaml"), buildOpenAIYaml(data.name, data.description));
  }

  console.log(`Generated ${skillDirs.length} skill packages in .agents/skills`);
}

main();
