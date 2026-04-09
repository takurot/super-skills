const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { collectDrift, formatDriftReport } = require("../scripts/check-drift");

function mktempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "super-skills-drift-"));
}

function writeFile(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeSkillFixture(root, { claudeSkillContent, agentsSkillContent, openaiYaml, sourceSkillContent }) {
  writeFile(root, "skills/demo/SKILL.md", sourceSkillContent);
  writeFile(root, ".agents/skills/demo/SKILL.md", agentsSkillContent);
  writeFile(root, ".agents/skills/demo/agents/openai.yaml", openaiYaml);
  writeFile(root, ".claude/skills/demo/SKILL.md", claudeSkillContent);
}

const sourceSkillContent = `---\nname: demo\ndescription: Use when comparing generated skill artifacts in build and drift checks.\norigin: unified\n---\n\n# Demo\n`;
const claudeSkillContent = `---\nname: demo\ndescription: Use when comparing generated skill artifacts in build and drift checks.\norigin: unified\nuser-invocable: true\n---\n\n# Demo\n`;
const openaiYaml = `interface:\n  display_name: "Demo"\n  short_description: "Use when comparing generated skill artifacts in build and drift checks."\n  default_prompt: "Use Demo for this task."\npolicy:\n  allow_implicit_invocation: true\n`;

test("collectDrift reports no drift for matching artifacts", () => {
  const root = mktempRoot();
  makeSkillFixture(root, {
    sourceSkillContent,
    claudeSkillContent,
    openaiYaml,
    agentsSkillContent: sourceSkillContent,
  });

  const report = collectDrift(root);

  assert.deepEqual(report.drifted, []);
  assert.deepEqual(report.ok, ["demo"]);
  assert.equal(formatDriftReport(report), "OK     demo");
});

test("collectDrift reports Claude drift and JSON output", () => {
  const root = mktempRoot();
  makeSkillFixture(root, {
    sourceSkillContent,
    claudeSkillContent: sourceSkillContent,
    openaiYaml,
    agentsSkillContent: sourceSkillContent,
  });

  const report = collectDrift(root);
  const json = JSON.parse(formatDriftReport(report, { json: true }));

  assert.deepEqual(report.ok, []);
  assert.equal(json.ok.length, 0);
  assert.equal(json.drifted.length, 1);
  assert.equal(json.drifted[0].skill, "demo");
  assert.equal(json.drifted[0].artifact, ".claude/skills/demo/SKILL.md");
  assert.equal(json.drifted[0].reason, "stale");
});

test("collectDrift reports OpenAI YAML drift in text output", () => {
  const root = mktempRoot();
  makeSkillFixture(root, {
    sourceSkillContent,
    claudeSkillContent,
    openaiYaml: openaiYaml.replace(
      "Use when comparing generated skill artifacts in build and drift checks.",
      "Use when comparing generated skill artifacts in build and drift checks, but with a different prompt.",
    ),
    agentsSkillContent: sourceSkillContent,
  });

  const report = collectDrift(root);
  const text = formatDriftReport(report);

  assert.deepEqual(report.ok, []);
  assert.match(text, /^DRIFT\s+demo\s+\.agents\/skills\/demo\/agents\/openai\.yaml \(stale\)$/);
});
