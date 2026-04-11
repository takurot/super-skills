const assert = require("assert/strict");
const test = require("node:test");

const { injectClaudeFrontmatter } = require("../scripts/lib/skill-metadata");

test("injectClaudeFrontmatter inserts user-invocable after source frontmatter", () => {
  const input = `---\nname: sample-skill\ndescription: Use when validating skill metadata.\norigin: unified\n---\n\n# Sample Skill\n`;

  const output = injectClaudeFrontmatter(input);

  assert.equal(
    output,
    `---\nname: sample-skill\ndescription: Use when validating skill metadata.\norigin: unified\nuser-invocable: true\n---\n\n# Sample Skill\n`,
  );
});

test("injectClaudeFrontmatter preserves multiline descriptions", () => {
  const input = `---\nname: sample-skill\ndescription: |\n  Use when validating skill metadata.\n  Keep the body formatting intact.\norigin: unified\n---\n\n# Sample Skill\n`;

  const output = injectClaudeFrontmatter(input);

  assert.equal(
    output,
    `---\nname: sample-skill\ndescription: |\n  Use when validating skill metadata.\n  Keep the body formatting intact.\norigin: unified\nuser-invocable: true\n---\n\n# Sample Skill\n`,
  );
});

test("injectClaudeFrontmatter rejects host-specific frontmatter", () => {
  const input = `---\nname: sample-skill\ndescription: Use when validating skill metadata.\norigin: unified\nuser-invocable: true\n---\n\n# Sample Skill\n`;

  assert.throws(() => injectClaudeFrontmatter(input), /host-specific frontmatter/i);
});
