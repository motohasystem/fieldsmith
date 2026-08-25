# Agent skills

Skills that teach a coding agent (Claude Code and friends) how to drive `fieldsmith`
safely — writing an AppSpec, validating it offline, and only then touching kintone.

The skill is the operational counterpart to [`docs/claude-code.md`](../docs/claude-code.md):
that document explains *why* an agent should write the AppSpec itself instead of calling
`plan` / `revise`; the skill is the procedure it follows.

| Skill | What it covers |
|---|---|
| [`kintone-appspec`](./kintone-appspec) | Author an AppSpec, validate with `deploy --dry-run`, create a new app (`deploy`), and update an existing one (`pull` → edit → `diff` → `update`) |

## Install

Skills are plain files. Copy the directory into your project (or your home config) and the
agent will pick it up:

```bash
# per project
mkdir -p .claude/skills
cp -r path/to/fieldsmith/skills/kintone-appspec .claude/skills/

# or for every project on this machine
mkdir -p ~/.claude/skills
cp -r path/to/fieldsmith/skills/kintone-appspec ~/.claude/skills/
```

Without a clone:

```bash
mkdir -p .claude/skills && cd .claude/skills
curl -L https://github.com/motohasystem/fieldsmith/archive/refs/heads/main.tar.gz \
  | tar xz --strip-components=2 fieldsmith-main/skills/kintone-appspec
```

Nothing else is required. `scripts/fieldsmith.sh` falls back to `npx -y fieldsmith`, so the
CLI does not have to be installed first.

## Configure kintone credentials

The skill reads them from a `.env` file. Either set one up as described in
[`docs/setup-password.md`](../docs/setup-password.md) (simplest — no `login` step) or
[`docs/setup-oauth.md`](../docs/setup-oauth.md), or export the variables directly.

```dotenv
KINTONE_BASE_URL=https://example.cybozu.com
KINTONE_USERNAME=...
KINTONE_PASSWORD=...
```

`fieldsmith` itself only reads `.env` from the current working directory, which is rarely
where an agent happens to be. The wrapper in `scripts/fieldsmith.sh` works around this by
searching, in order:

1. `$FIELDSMITH_ENV`
2. the nearest `.env` walking up from the working directory (stopping at `$HOME`)
3. `~/.config/fieldsmith/.env`

OAuth tokens live in `~/.config/fieldsmith/tokens.json` and are not affected by the working
directory.

Prefer **password auth** for agent use. OAuth needs an interactive `fieldsmith login` in a
browser, which stalls the agent mid-task.

## Permissions

Optional, but worth setting: let the read-only commands through and confirm the ones that
change kintone. Put this in `.claude/settings.json`.

Permission patterns match **the command string as it is actually run**. The skill invokes the
wrapper, not `fieldsmith` directly, so patterns written against `npx fieldsmith ...` will not
match anything — including a `deny` you were relying on.

```json
{
  "permissions": {
    "allow": [
      "Bash(bash *kintone-appspec/scripts/fieldsmith.sh schema*)",
      "Bash(bash *kintone-appspec/scripts/fieldsmith.sh pull *)",
      "Bash(bash *kintone-appspec/scripts/fieldsmith.sh diff *)",
      "Bash(bash *kintone-appspec/scripts/fieldsmith.sh status *)"
    ],
    "ask": [
      "Bash(bash *kintone-appspec/scripts/fieldsmith.sh deploy *)",
      "Bash(bash *kintone-appspec/scripts/fieldsmith.sh update *)"
    ],
    "deny": [
      "Bash(bash *kintone-appspec/scripts/fieldsmith.sh plan *)",
      "Bash(bash *kintone-appspec/scripts/fieldsmith.sh create *)",
      "Bash(bash *kintone-appspec/scripts/fieldsmith.sh revise *)"
    ]
  }
}
```

Rules are evaluated `deny` → `ask` → `allow`, first match wins. `deploy --dry-run` also matches
`deploy *` in `ask`, so it prompts — harmless, and erring toward a prompt is the safe side.

**Simpler alternative:** install the CLI globally (`npm i -g fieldsmith`). The wrapper prefers a
`fieldsmith` on `PATH`, but it still runs as `bash .../fieldsmith.sh <args>`, so the patterns
above are what you want either way. Only if you skip the wrapper entirely and let the agent call
`fieldsmith` directly do plain `Bash(fieldsmith deploy *)` patterns apply.

Whatever you write, verify it with `/permissions` in Claude Code rather than assuming — a rule
that silently matches nothing looks exactly like a rule that works.

## Safety properties the skill relies on

These are what make it reasonable to let an agent run the CLI at all:

- `deploy --dry-run` contacts **neither kintone nor any LLM**, so the write-validate-fix loop
  is free and side-effect-free. Credentials are not even required.
- `pull`, `diff` and `status` are **read-only** — safe to run unprompted.
- `update` stops at the **test environment** unless `--deploy` is passed, so production
  changes always take a second, explicit step.
- Removing a field from an AppSpec never deletes data: the field is moved to a
  `_削除候補` group and its records are preserved.

The skill additionally requires explicit human confirmation before `deploy` and before
`update --deploy`, and refuses to create an app until the destination space and thread are
known.

## Contributing a skill

Keep `SKILL.md` free of machine-specific paths, keep the frontmatter `description` rich in the
phrases a user would actually say (that is what triggers the skill), and prefer linking to
`docs/` over restating setup instructions.
