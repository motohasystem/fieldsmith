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

### As a plugin (recommended)

This repository doubles as a Claude Code plugin marketplace, so two commands are enough:

```bash
claude plugin marketplace add motohasystem/fieldsmith
claude plugin install kintone-fieldsmith@fieldsmith
```

Restart the session to load it. `/plugin` inside Claude Code does the same thing through an
interactive menu. Later updates are `claude plugin update kintone-fieldsmith`.

The plugin is named `kintone-fieldsmith`; the skill it ships is `kintone-appspec`. Verify what
was installed with `claude plugin details kintone-fieldsmith`, which also reports the token
cost it adds to every session (~360 tokens always-on).

### By copying the files

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
