#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { extractFrontmatter, validateSourceSkillMetadata } = require("./lib/skill-metadata");

const ROOT = path.resolve(__dirname, "..");
const SKILLS_DIR = path.join(ROOT, "skills");

function main() {
  if (!fs.existsSync(SKILLS_DIR)) {
    throw new Error("skills/ does not exist");
  }

  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const seenNames = new Map();
  let errors = 0;

  for (const entry of entries) {
    const skillFile = path.join(SKILLS_DIR, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) {
      console.error(`ERROR: skills/${entry.name}/SKILL.md is missing`);
      errors += 1;
      continue;
    }

    const content = fs.readFileSync(skillFile, "utf8");
    let frontmatter;
    try {
      ({ data: frontmatter } = extractFrontmatter(content));
    } catch (error) {
      console.error(`ERROR: skills/${entry.name}/SKILL.md has invalid frontmatter`);
      errors += 1;
      continue;
    }

    const result = validateSourceSkillMetadata({
      dirName: entry.name,
      data: frontmatter,
    });
    for (const message of result.errors) {
      console.error(`ERROR: ${message}`);
      errors += 1;
    }
    for (const message of result.warnings) {
      console.warn(`WARN: ${message}`);
    }

    const logicalName = frontmatter.name || entry.name;
    if (seenNames.has(logicalName)) {
      console.error(`ERROR: duplicate skill name '${logicalName}' in ${entry.name} and ${seenNames.get(logicalName)}`);
      errors += 1;
    } else {
      seenNames.set(logicalName, entry.name);
    }
  }

  if (errors > 0) {
    process.exit(1);
  }

  console.log(`Validated ${entries.length} source skills`);
}

main();
