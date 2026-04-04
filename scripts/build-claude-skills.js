#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { extractFrontmatter, validateSourceSkillMetadata } = require("./lib/skill-metadata");

const ROOT = path.resolve(__dirname, "..");
const SKILLS_DIR = path.join(ROOT, "skills");
const CLAUDE_SKILLS_DIR = path.join(ROOT, ".claude", "skills");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function removeDirContents(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function copyRecursive(source, destination) {
  const stats = fs.statSync(source);
  if (stats.isDirectory()) {
    ensureDir(destination);
    for (const entry of fs.readdirSync(source)) {
      copyRecursive(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }

  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
}

function main() {
  ensureDir(CLAUDE_SKILLS_DIR);
  removeDirContents(CLAUDE_SKILLS_DIR);

  const skillDirs = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const skillName of skillDirs) {
    const sourceSkill = path.join(SKILLS_DIR, skillName, "SKILL.md");
    const content = fs.readFileSync(sourceSkill, "utf8");
    const { data } = extractFrontmatter(content);
    const { errors, warnings } = validateSourceSkillMetadata({
      dirName: skillName,
      data,
    });
    if (errors.length > 0) {
      throw new Error(errors.join("\n"));
    }
    for (const warning of warnings) {
      console.warn(`WARN: ${warning}`);
    }
    copyRecursive(path.join(SKILLS_DIR, skillName), path.join(CLAUDE_SKILLS_DIR, skillName));
  }

  console.log(`Generated ${skillDirs.length} Claude skill packages in .claude/skills`);
}

main();
