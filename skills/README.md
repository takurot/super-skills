# Skills

This directory is the authored source of truth for unified skills.

Each skill directory should contain:

- `SKILL.md` required
- `references/` optional
- `scripts/` optional
- `assets/` optional

Source skills are host-neutral. Keep host-specific metadata out of `skills/` and put it in generated artifacts or host adapters instead.

Required `SKILL.md` frontmatter:

- `name`
- `description`
- `origin`

Additional source rules:

- `name` must match the directory name
- `description` should read like a trigger, typically `Use when ...` or `Use for ...`
- a `Gotchas` section is recommended for high-signal failure modes

Run `node scripts/build-skills.js` to generate Codex-facing metadata in `.agents/skills/`.

See [SKILL-AUTHORING.md](/Volumes/Storage/src/super-skills/docs/SKILL-AUTHORING.md) for the full contract.
