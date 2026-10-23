---
name: browser-macros
description: Registry of deterministic, parameterized Playwright MCP browser workflows (macros) for web app validation — login, list-page and row-dialog inspection, sort/pagination integrity, route discovery — plus the learned invariants each one encodes. Use before starting browser work to replay a recorded workflow instead of rediscovering selectors.
---

# Browser Macros

## Purpose

A **browser macro** is a deterministic, parameterized Playwright MCP workflow stored as one JSON file
under `macros/`. Macros exist so that recurring browser validation — log in, open a
list page, open a row dialog, sweep sort/pagination, read a definition — is replayed from a recorded
sequence instead of rediscovered call by call in every worktree.

Each macro carries two things, and the second is usually worth more than the first:

1. **`steps`** — the tool calls to replay, with `{{placeholder}}` parameters.
2. **`notes`** — the learned invariants that cost calls to discover (cert bypass must happen inside
   the first navigation; nav items are buttons, not links; a list is infinite-scroll with no
   paginator; checkbox state is invisible to accessibility snapshots).

Macros are a knowledge store with an executable skeleton attached. Treat the notes as first-class.

## Two scopes: generic vs ticket-specific

|                 | Generic                                     | Ticket-specific                                             |
| --------------- | ------------------------------------------- | ----------------------------------------------------------- |
| Lives in        | `macros/`                                   | `macros/local/`                                             |
| Catalogued in   | this file (`SKILL.md`)                      | `LOCAL.md`                                                  |
| In git?         | **yes** — shared with the team              | **no** — git-ignored, stays on the machine that recorded it |
| Catalog in git? | **no** — generated from `SKILL.template.md` | **no**                                                      |
| Create with     | `pnpm macro create <name> --from ...`       | `pnpm macro create <name> --from ... --local`               |

**A macro is generic when any teammate could replay it on any environment** without knowing which ticket
you were on: log in, open a list page, open a row dialog, sweep sort and pagination, run a report,
find a route. Its parameters name UI concepts (`route`, `rowText`, `status`), not one ticket's data.

**A macro is ticket-specific when it only makes sense inside one piece of work**: a keystroke probe
for one input's bug, an import of one customer's file layout, a repro of one race condition. These are
worth keeping — the invariants they encode are real, and re-running them across a ticket's phases is
exactly what they are for — but once the ticket ships they are dead weight in every teammate's
context, so they never enter the shared catalog.

When unsure, create it `--local`. Promoting later is a `git mv` into `macros/` plus
`pnpm skills:refresh`; demoting a macro teammates already pulled is not.

Both scopes obey the same rules below. `pnpm macro list`, `show`, `run`, `update` and `delete`
resolve a name in either scope, so nothing about running a macro changes with its scope.

## Usage guidance

**Never hand-replay a macro.** Do not read a macro's JSON and reissue what you remember of its
steps: that drifts (retyped argument values) and truncates (the verification tail gets dropped, and
then success is claimed without evidence). Compile it and execute the result.

```bash
pnpm macro run <name> --param key=value --param key2=value2 --out .playwright-mcp/macros
```

`run` binds your parameters into the recorded steps and prints one or more **segments**:

- A `code` segment is a complete `async (page) => {...}` script. With `--out` it is written to a
  file and `run` prints the exact call to make — `browser_run_code_unsafe { "filename": "..." }` —
  so the script never passes through you as text and cannot be edited or truncated in transit.
  Prefer this. (`--out` must point inside the MCP server's allowed roots, i.e. under your session
  cwd, or the tool refuses to read the file.) Without `--out` the script is printed instead; pass it
  **verbatim** as the `code` argument of a single call. Every step runs or the script throws with the
  step index and the results completed so far, so a partial run cannot be mistaken for a whole one.
- An `mcp` segment names a tool that has no faithful `page` equivalent (`browser_snapshot` returns
  the MCP server's own accessibility format). Call that tool directly with the printed arguments,
  then continue with the next segment.

The script returns `{ macro, ok, steps: [{ step, tool, result }], url, title }` — that array is your
evidence. Quote it. A step marked `(optional)` in the catalog may come back as `{ skipped: "..." }`;
that is expected, not a failure — optional steps also use a short 3s wait, since their element is
often legitimately absent. A step marked `(asserted)` enforces the macro's own `returns` contract
inside the script, so the run fails loudly rather than leaving the check to you.

Console and network evidence are collected by listeners the script installs at its own start, so
`browser_console_messages` and `browser_network_requests` steps report what happened **during the
segment** — which is what you want, and differs from the MCP tools' since-page-load behaviour.

Before running:

1. List what exists — `pnpm macro list` — or read the catalog below.
2. Read the target macro's **notes** before you touch the browser; they are the learned invariants
   that cost calls to discover, and they are usually worth more than the steps.
3. Take the host **and port** from your task. Ports can vary per worktree or stack — never take
   them from a macro's example value.
4. Never bake a credential into a macro. Pass it with `--param`.

If `run` refuses, it is telling you something real: a missing required parameter, an unbound
placeholder, or a step whose tool has no compiler. Fix the cause; do not fall back to hand-replay.

If a step fails at execution time, do **not** silently work around it. Fall back to discovery,
finish the validation, then amend the macro (`--from` or `--add-note`) so the next run inherits the
fix. Selector drift is expected — a macro that is never amended rots.

## Registration guidance

The JSON files under `macros/` are the source of truth for the tables below, and
`SKILL.template.md` is the source of truth for this prose. Both catalogs are generated and
git-ignored, so never hand-edit `SKILL.md` or `LOCAL.md` — an edit there is lost on the next
`pnpm install` or `git pull`. Prose changes go in `SKILL.template.md`.

Register a macro — pick the scope deliberately (see **Two scopes** above):

```bash
# scaffold, then edit the JSON
pnpm macro create my-macro --template

# or register a macro you already composed
pnpm macro create my-macro --from /tmp/my-macro.json
cat /tmp/my-macro.json | pnpm macro create my-macro --from -

# ticket-specific: same commands plus --local
pnpm macro create ticket-123-probe --from /tmp/probe.json --local
```

Amend, inspect, remove:

```bash
pnpm macro show my-macro
pnpm macro update my-macro --add-note "Row checkboxes are native inputs; click force:true — the hover overlay eats the click"
pnpm macro update my-macro --replace-note 4 "<the corrected, complete fact>"
pnpm macro update my-macro --drop-note 4
pnpm macro update my-macro --set replacesCalls=9
pnpm macro update my-macro --from /tmp/my-macro.json
pnpm macro delete my-macro --yes
```

Every mutation regenerates both catalogs. To regenerate by hand after editing a JSON file directly:

```bash
pnpm skills:refresh            # rewrite the generated region
pnpm skills:refresh --check    # exit 1 if the catalog is stale (CI / pre-commit)
```

Rules enforced by the CLI:

- `name` must be kebab-case and match the file name.
- `purpose`, `parameters`, and a non-empty `steps` array are required.
- Every step tool must be a Playwright MCP `browser_*` tool.
- Every `{{placeholder}}` used in `steps` must be declared in `parameters`, and every declared
  parameter must be used.

Two optional step fields control how the runner executes a step:

- `"optional": true` — the step may fail without aborting the run; the runner records
  `{ skipped: "<reason>" }` and continues. Use it for genuinely conditional UI (a sidebar that may
  already be expanded). Never use it to paper over a flaky selector: an optional step proves nothing.
- `"assert": "<js expression>"` — evaluated after the step with the step's `result` in scope, e.g.
  `!result.url.includes('/login')`. This is how a macro enforces its own `returns` contract instead
  of trusting the caller to remember it. Put an assertion on the step that produces the evidence.

Skip semantics expressed only in a step's `note` are invisible to the runner. If a step is
conditional, mark it `optional`; if a note says "SKIP THIS STEP if...", that note is a bug report
against the macro.

Rules that are conventions, not enforced:

- **Amend over create.** If a macro nearly covers the flow, extend it instead of forking a near
  duplicate.
- **Execute before storing.** A macro must have been run end to end as written, through
  `pnpm macro run`; do not store a sequence you only believe would work.
- **Stamp `verified`** with the date and environment each time you replay it. That field is the run
  record — the catalog prints it as a column.
- **Notes carry knowledge, not run logs.** A note earns its place only if it changes what the next
  caller does: a selector that lies, a trap, a per-environment data fact, a defect that is not yours.
  Never add a note that only says a run passed; that belongs in `verified`.

## Writing a note

Every note is read by an agent before every run of its macro, so the registry pays for each one
twice — once in context, once in the reader's attention. Three rules, and the CLI now enforces all
three on `--add-note` (override with `--force` when you are sure):

**Amend, never append.** If a note already covers the ground, correct that note with
`--replace-note <index> "<the corrected, complete fact>"`, or delete it with `--drop-note <index>`
when it is simply wrong. `--add-note` is refused when the text repeats an existing note's opening or
restates it. Appending is the failure mode that damages a registry: a macro accumulates several generations of
the same note, each a longer retelling of the last, and a reader has to diff near-identical
paragraphs to learn which is current.

**One fact per note.** Notes are capped at 900 characters and warned over 600. A note is the unit of
amendment: if it carries five facts, the run that finds one of them stale cannot fix it in place and
will append instead. Split before you write.

**Say it once, concretely.** Lead with the invariant, not the history. Keep the selector, the number,
the trap and the workaround; drop the narration of how you found it, the commit hashes, and the
phase-by-phase account. Compress provenance to a `(TICKET, date environment)` suffix and only when the
fact is environment- or build-specific. A note that opens "X does not work; use Y instead" is worth five
that open "During phase 07 I attempted".

When a new run contradicts an old note, rewrite the old note. A correction stacked beside the thing
it corrects leaves the reader to guess, and both notes stay in context forever.

<!-- BEGIN GENERATED MACROS -->

<!-- END GENERATED MACROS -->

## Known route index

Hand-maintained, **not** generated. Record hard-to-find routes here as you discover them — the
page a user means versus where it actually lives, and the query or filter that reaches it — stamped
with the user and environment where it was confirmed, since visible navigation is often per-role.

| Looking for | Actual location | Notes |
| ----------- | --------------- | ----- |

## Notes for maintainers

- The generator only rewrites the region between the two markers above. Anything you write outside it
  is preserved.
- Layout follows the repo skill convention: `.claude/skills/browser-macros/SKILL.md` with
  `name`/`description` frontmatter, and the macro JSON bundled alongside it in `macros/`. Both
  scopes' paths live in one `SCOPES` table in `.claude/scripts/update-browser-macros-skill.ts` —
  update it if this folder ever moves.
- Both catalogs are git-ignored (see `.gitignore`). `package.json` runs the refresh as `postinstall`
  (so a fresh clone gets them); add `pnpm skills:refresh` to a `post-merge` git hook so a pull that
  lands new macros refreshes the tables. `SKILL.md` is spliced from the committed
  `SKILL.template.md` on every run, which is what keeps a generated table out of everyone's merge
  conflicts. `macros/local/` is git-ignored too; the generator seeds `LOCAL.md` the first time a
  local macro is written, and stays silent when there are none.
- The tooling lives in `.claude/scripts/` rather than inside the skill folder so `package.json` can
  expose it as `pnpm skills:refresh` / `pnpm macro`.
