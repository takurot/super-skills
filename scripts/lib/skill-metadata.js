const SOURCE_FRONTMATTER_KEYS = ["name", "description", "origin"];

const HOST_SPECIFIC_FRONTMATTER_KEYS = [
  "agent",
  "allowed-tools",
  "argument-hint",
  "background",
  "color",
  "context",
  "disable-model-invocation",
  "disallowedTools",
  "effort",
  "hooks",
  "initialPrompt",
  "isolation",
  "maxTurns",
  "mcpServers",
  "memory",
  "model",
  "paths",
  "permissionMode",
  "shell",
  "skills",
  "tools",
  "user-invocable",
];

const DESCRIPTION_TRIGGER_PATTERNS = [
  /\buse after\b/i,
  /\buse before\b/i,
  /\buse during\b/i,
  /\buse when\b/i,
  /\buse for\b/i,
  /\buse to\b/i,
  /\btriggers?\b/i,
];

function extractFrontmatter(content) {
  if (!content.startsWith("---\n")) {
    throw new Error("missing frontmatter");
  }

  const end = content.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error("unterminated frontmatter");
  }

  const raw = content.slice(4, end);
  const body = content.slice(end + 5);
  const lines = raw.split("\n");
  const data = {};

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;

    const blockMatch = line.match(/^([A-Za-z0-9_-]+):\s*\|\s*$/);
    if (blockMatch) {
      const key = blockMatch[1];
      const block = [];
      for (i += 1; i < lines.length; i += 1) {
        const next = lines[i];
        if (/^\S/.test(next)) {
          i -= 1;
          break;
        }
        block.push(next.replace(/^  /, ""));
      }
      data[key] = block.join("\n").trim();
      continue;
    }

    const inlineMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.+?)\s*$/);
    if (inlineMatch) {
      data[inlineMatch[1]] = inlineMatch[2];
    }
  }

  return { data, body, raw };
}

function normalizeDescription(description) {
  return String(description || "").replace(/\s+/g, " ").trim();
}

function validateSourceSkillMetadata({ dirName, data }) {
  const errors = [];
  const warnings = [];
  const keys = Object.keys(data);

  for (const key of keys) {
    if (SOURCE_FRONTMATTER_KEYS.includes(key)) continue;

    if (HOST_SPECIFIC_FRONTMATTER_KEYS.includes(key)) {
      errors.push(
        `skills/${dirName}/SKILL.md uses host-specific frontmatter '${key}'. Keep source skills host-neutral and add host metadata in generated artifacts instead.`,
      );
      continue;
    }

    errors.push(
      `skills/${dirName}/SKILL.md uses unsupported frontmatter '${key}'. Allowed source keys: ${SOURCE_FRONTMATTER_KEYS.join(", ")}.`,
    );
  }

  if (!data.name) {
    errors.push(`skills/${dirName}/SKILL.md missing name`);
  } else if (data.name !== dirName) {
    errors.push(`skills/${dirName}/SKILL.md name must match directory name '${dirName}'`);
  }

  if (!data.description) {
    errors.push(`skills/${dirName}/SKILL.md missing description`);
  } else {
    const description = normalizeDescription(data.description);
    if (description.length < 40) {
      errors.push(`skills/${dirName}/SKILL.md description is too short; write it as a trigger-oriented sentence`);
    }
    if (!DESCRIPTION_TRIGGER_PATTERNS.some((pattern) => pattern.test(description))) {
      warnings.push(
        `skills/${dirName}/SKILL.md description should read like an invocation trigger and usually include phrasing like 'Use when', 'Use for', or 'Use to'.`,
      );
    }
  }

  if (!data.origin) {
    errors.push(`skills/${dirName}/SKILL.md missing origin`);
  }

  return { errors, warnings };
}

module.exports = {
  DESCRIPTION_TRIGGER_PATTERNS,
  HOST_SPECIFIC_FRONTMATTER_KEYS,
  SOURCE_FRONTMATTER_KEYS,
  extractFrontmatter,
  normalizeDescription,
  validateSourceSkillMetadata,
};
