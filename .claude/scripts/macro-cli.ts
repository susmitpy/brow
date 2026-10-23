#!/usr/bin/env tsx
/**
 * macro-cli — manage browser macros stored under `.claude/skills/browser-macros/`.
 *
 * Two scopes:
 *   - generic (`macros/`)       committed, shared with the team, catalogued in SKILL.md
 *                              (itself generated from SKILL.template.md, git-ignored)
 *   - local   (`macros/local/`) git-ignored, this machine only, catalogued in LOCAL.md
 *
 * A macro is generic when any teammate could replay it on any environment — log in, open a
 * list page, run a report. It is local when it only makes sense for one ticket: a
 * keystroke probe for a specific input bug, an import of one customer's file layout.
 * Create with `--local` when in doubt; promoting later is a `git mv`.
 *
 * The JSON files are the source of truth. This CLI never edits a catalog by hand; it
 * regenerates both through `update-browser-macros-skill.ts` after any mutation.
 *
 *   pnpm macro list [--json]
 *   pnpm macro show <name> [--json]
 *   pnpm macro run <name> --param k=v ... [--json] [--artifact-dir <d>]
 *   pnpm macro create <name> (--from <file|-> | --template) [--local]
 *   pnpm macro update <name> (--from <file|-> | --set k=v ... |
 *                                                               --add-note "..." | --replace-note <i> "..." |
 *                                                               --drop-note <i>)
 *   pnpm macro delete <name> --yes
 */

import { readdirSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile, type MacroParams } from './macro-compile.ts';
import { refreshSkillCatalog, SCOPES, type Scope } from './update-browser-macros-skill.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MACRO_DIR = SCOPES.generic.macroDir;
const LOCAL_MACRO_DIR = SCOPES.local.macroDir;

export interface MacroParameter {
    name: string;
    type: string;
    required?: boolean;
    example?: unknown;
    note?: string;
}

export interface MacroStep {
    tool: string;
    args?: Record<string, unknown>;
    note?: string;
    /**
     * A step that is allowed to fail without aborting the run — e.g. clicking "Expand
     * sidebar" when the sidebar is already expanded and the selector therefore matches
     * nothing. The runner records it as `skipped` and carries on. Use sparingly: a step
     * marked optional can never prove anything.
     */
    optional?: boolean;
    /**
     * JS expression asserted after the step, with the step's `result` in scope. This is how
     * a macro enforces its own `returns` contract instead of trusting the caller to check
     * it, e.g. `!result.url.includes('/login')`.
     */
    assert?: string;
}

export interface Macro {
    name: string;
    purpose: string;
    parameters: MacroParameter[];
    steps: MacroStep[];
    returns?: string;
    replacesCalls?: number;
    reuseRationale?: string;
    verified?: { date: string; environment?: string; url?: string };
    notes?: string[];
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Read every macro in one directory, sorted by name. Throws on unparseable JSON. */
export function readMacros(dir: string = MACRO_DIR): Macro[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => {
            const path = join(dir, f);
            try {
                return JSON.parse(readFileSync(path, 'utf8')) as Macro;
            } catch (err) {
                throw new Error(`${path}: invalid JSON — ${(err as Error).message}`);
            }
        });
}

/** Structural validation. Returns the list of problems; empty means valid. */
export function validate(macro: Macro, expectedName?: string): string[] {
    const problems: string[] = [];
    if (!macro.name || !NAME_RE.test(macro.name)) {
        problems.push(`"name" must be kebab-case (got ${JSON.stringify(macro.name)})`);
    }
    if (expectedName && macro.name !== expectedName) {
        problems.push(`"name" (${macro.name}) must match the file name (${expectedName})`);
    }
    if (!macro.purpose?.trim()) problems.push('"purpose" is required');
    if (!Array.isArray(macro.parameters)) problems.push('"parameters" must be an array');
    if (!Array.isArray(macro.steps) || macro.steps.length === 0) {
        problems.push('"steps" must be a non-empty array');
    }

    for (const [i, step] of (macro.steps ?? []).entries()) {
        if (!step?.tool) problems.push(`steps[${i}]: "tool" is required`);
        else if (!step.tool.startsWith('browser_')) {
            problems.push(`steps[${i}]: "${step.tool}" is not a Playwright MCP browser_* tool`);
        }
        if (step?.optional !== undefined && typeof step.optional !== 'boolean') {
            problems.push(`steps[${i}]: "optional" must be a boolean`);
        }
        if (step?.assert !== undefined && typeof step.assert !== 'string') {
            problems.push(`steps[${i}]: "assert" must be a string JS expression`);
        }
    }

    // Every {{placeholder}} used in steps must be a declared parameter.
    const declared = new Set((macro.parameters ?? []).map((p) => p.name));
    const used = new Set<string>();
    for (const m of JSON.stringify(macro.steps ?? []).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
        used.add(m[1]);
    }
    for (const p of used) {
        if (!declared.has(p))
            problems.push(`step uses {{${p}}} but it is not declared in "parameters"`);
    }
    for (const p of declared) {
        if (!used.has(p)) problems.push(`parameter "${p}" is declared but never used in "steps"`);
    }
    return problems;
}

/**
 * Note hygiene. Notes are read by an agent before every run, so the registry pays for each
 * one twice: once in context and once in the reader's attention. Three failure modes have
 * actually happened here, so they are checked rather than merely documented:
 *   - appending a longer retelling of a note that already exists (the reader then has to
 *     diff two near-identical paragraphs to find which is current);
 *   - stacking a run log ("re-verified on <environment>, all steps ok") that carries no knowledge;
 *   - writing a multi-fact essay that cannot be amended in place later.
 * Amend the existing note instead: `--replace-note <index>`.
 */
const NOTE_SOFT_LIMIT = 600;
const NOTE_HARD_LIMIT = 900;
const RUN_LOG_RE =
    /^\s*(re-?)?(verified|confirmed|validated|browser-verified)\b[^.]*\b(all steps ok|\d+\/\d+ steps|steps ok|run ok|passed)\b/i;

/** Rough token overlap, enough to catch a retelling without pulling in a diff library. */
function noteSimilarity(a: string, b: string): number {
    const words = (s: string) =>
        new Set(
            s
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, ' ')
                .split(/\s+/)
                .filter((w) => w.length > 3),
        );
    const [wa, wb] = [words(a), words(b)];
    if (wa.size === 0 || wb.size === 0) return 0;
    let shared = 0;
    for (const w of wa) if (wb.has(w)) shared += 1;
    return shared / Math.min(wa.size, wb.size);
}

/** Longest shared opening, in characters — an exact retelling starts identically. */
function sharedPrefix(a: string, b: string): number {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    return i;
}

function checkNote(note: string, existing: string[], force: boolean): void {
    const complain = (msg: string, hint: string): void => {
        if (force) console.error(`warning: ${msg}`);
        else fail(`${msg}\n  ${hint}\n  Override with --force if this really is a new, distinct fact.`);
    };

    if (RUN_LOG_RE.test(note)) {
        complain(
            'this note is a run log, not knowledge',
            'A passing replay belongs in "verified" (--set verified=\'{"date":"...","environment":"..."}\'). ' +
            'A note earns its place only if it changes what the next caller does.',
        );
    }

    if (note.length > NOTE_HARD_LIMIT) {
        complain(
            `note is ${note.length} chars (limit ${NOTE_HARD_LIMIT})`,
            'Split it: one fact per note, so a later run can amend the one fact that drifted ' +
            'instead of re-appending the whole paragraph.',
        );
    } else if (note.length > NOTE_SOFT_LIMIT) {
        console.error(
            `warning: note is ${note.length} chars; notes over ${NOTE_SOFT_LIMIT} are usually two facts — consider splitting.`,
        );
    }

    existing.forEach((old, i) => {
        const prefix = sharedPrefix(old, note);
        const similarity = noteSimilarity(old, note);
        if (prefix >= 120 || similarity >= 0.6) {
            const why =
                prefix >= 120
                    ? `it repeats the first ${prefix} chars of note [${i}] verbatim`
                    : `it restates note [${i}] (${Math.round(similarity * 100)}% word overlap)`;
            complain(
                `refusing to append: ${why}`,
                `Amend in place — --replace-note ${i} "<the corrected, complete fact>" — or --drop-note ${i} ` +
                'if it is now wrong. Never stack a correction beside the note it corrects.',
            );
        }
    });
}

function noteIndex(raw: string, notes: string[]): number {
    const i = Number(raw);
    if (!Number.isInteger(i) || i < 0 || i >= notes.length) {
        fail(`note index ${raw} out of range (macro has ${notes.length} notes; see \`show\`)`);
    }
    return i;
}

function macroPath(name: string, scope: Scope): string {
    return join(SCOPES[scope].macroDir, `${name}.json`);
}

/**
 * Locate a macro by name across both scopes. Names are unique across scopes: a macro
 * that exists in both would silently diverge, so `create` refuses either way.
 */
function findMacro(name: string): { path: string; scope: Scope } | null {
    for (const scope of ['generic', 'local'] as Scope[]) {
        const path = macroPath(name, scope);
        if (existsSync(path)) return { path, scope };
    }
    return null;
}

function loadOne(name: string): Macro & { __scope: Scope } {
    const found = findMacro(name);
    if (!found) {
        fail(`no macro named "${name}" (looked in ${MACRO_DIR} and ${LOCAL_MACRO_DIR})`);
    }
    return {
        ...(JSON.parse(readFileSync(found.path, 'utf8')) as Macro),
        __scope: found.scope,
    };
}

function writeOne(macro: Macro, scope: Scope): void {
    mkdirSync(SCOPES[scope].macroDir, { recursive: true });
    const { __scope: _drop, ...clean } = macro as Macro & { __scope?: Scope };
    writeFileSync(macroPath(macro.name, scope), `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
}

function fail(message: string): never {
    console.error(`macro-cli: ${message}`);
    process.exit(1);
}

function readInput(from: string): string {
    if (from === '-') return readFileSync(0, 'utf8');
    if (!existsSync(from)) fail(`--from file not found: ${from}`);
    return readFileSync(from, 'utf8');
}

function template(name: string): Macro {
    return {
        name,
        purpose: 'TODO: one line — what this macro accomplishes',
        parameters: [
            {
                name: 'baseUrl',
                type: 'string',
                required: true,
                example: 'https://localhost:3000',
            },
        ],
        steps: [{ tool: 'browser_navigate', args: { url: '{{baseUrl}}/' } }],
        returns: 'TODO: what the macro reports back to the caller',
        replacesCalls: 1,
        reuseRationale: 'TODO: why this recurs across tickets or worktrees',
        verified: { date: new Date().toISOString().slice(0, 10) },
        notes: [],
    };
}

interface Flags {
    positional: string[];
    from?: string;
    set: string[];
    param: string[];
    artifactDir?: string;
    addNote?: string;
    replaceNote?: [string, string];
    dropNote?: string;
    force: boolean;
    out?: string;
    json: boolean;
    template: boolean;
    local: boolean;
    yes: boolean;
}

function parseArgs(argv: string[]): Flags {
    const flags: Flags = {
        positional: [],
        set: [],
        param: [],
        json: false,
        template: false,
        local: false,
        yes: false,
        force: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--from') flags.from = argv[++i];
        else if (a === '--set') flags.set.push(argv[++i]);
        else if (a === '--param' || a === '-p') flags.param.push(argv[++i]);
        else if (a === '--artifact-dir') flags.artifactDir = argv[++i];
        else if (a === '--out') flags.out = argv[++i];
        else if (a === '--add-note') flags.addNote = argv[++i];
        else if (a === '--replace-note') flags.replaceNote = [argv[++i], argv[++i]];
        else if (a === '--drop-note') flags.dropNote = argv[++i];
        else if (a === '--force') flags.force = true;
        else if (a === '--json') flags.json = true;
        else if (a === '--template') flags.template = true;
        else if (a === '--local') flags.local = true;
        else if (a === '--yes') flags.yes = true;
        else if (a.startsWith('--')) fail(`unknown flag ${a}`);
        else flags.positional.push(a);
    }
    return flags;
}

async function afterMutation(action: string, name: string, scope: Scope): Promise<void> {
    const result = await refreshSkillCatalog();
    const r = result.scopes[scope];
    console.log(`${action} ${name} (${scope}: ${SCOPES[scope].relDir})`);
    console.log(
        r.changed
            ? `catalog updated: ${r.skillPath} (${r.macroCount} macros)`
            : `catalog already current (${r.macroCount} macros)`,
    );
}

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2);
    const flags = parseArgs(rest);
    const name = flags.positional[0];

    switch (command) {
        case 'list': {
            const scoped = (['generic', 'local'] as Scope[]).map((scope) => ({
                scope,
                macros: readMacros(SCOPES[scope].macroDir),
            }));
            if (flags.json) {
                console.log(
                    JSON.stringify(
                        scoped.flatMap(({ scope, macros }) => macros.map((m) => ({ ...m, scope }))),
                        null,
                        2,
                    ),
                );
                break;
            }
            let total = 0;
            for (const { scope, macros } of scoped) {
                total += macros.length;
                if (macros.length === 0) continue;
                console.log(
                    `## ${scope} — .claude/skills/browser-macros/${SCOPES[scope].relDir}${scope === 'local' ? ' (git-ignored, this machine only)' : ''}\n`,
                );
                for (const m of macros) {
                    const params = m.parameters
                        .map((p) => (p.required === false ? `[${p.name}]` : p.name))
                        .join(', ');
                    console.log(
                        `${m.name}\n  ${m.purpose}\n  params: ${params || '(none)'} | steps: ${m.steps.length} | replaces ~${m.replacesCalls ?? '?'} calls | verified: ${m.verified?.date ?? 'never'}`,
                    );
                }
                console.log('');
            }
            if (total === 0) {
                console.log('no macros registered under .claude/skills/browser-macros/');
                break;
            }
            console.log(`${total} macro(s)`);
            break;
        }

        case 'show': {
            if (!name) fail('usage: show <name>');
            const { __scope, ...macro } = loadOne(name);
            console.log(JSON.stringify({ ...macro, scope: __scope }, null, 2));
            break;
        }

        case 'run': {
            if (!name)
                fail('usage: run <name> --param k=v [--param ...] [--json] [--artifact-dir <dir>]');
            const macro = loadOne(name);
            const problems = validate(macro, name);
            if (problems.length) fail(`macro "${name}" is invalid:\n  - ${problems.join('\n  - ')}`);

            const params: MacroParams = {};
            for (const pair of flags.param) {
                const idx = pair.indexOf('=');
                if (idx === -1) fail(`--param expects key=value (got ${pair})`);
                const key = pair.slice(0, idx);
                const raw = pair.slice(idx + 1);
                // Numbers and booleans matter: a step's `time` must not become the string "4".
                params[key] = /^-?\d+(\.\d+)?$/.test(raw)
                    ? Number(raw)
                    : raw === 'true' || raw === 'false'
                        ? raw === 'true'
                        : raw;
            }

            let compiled;
            try {
                compiled = compile(macro, params, { artifactDir: flags.artifactDir });
            } catch (err) {
                fail(`cannot run "${name}" — ${(err as Error).message}`);
            }

            // --out writes each code segment to a file so the caller can hand it to
            // browser_run_code_unsafe by `filename`. That is the safest path: the script never
            // passes through the caller as text, so it cannot be edited or truncated in transit.
            // The directory must sit inside the MCP server's allowed roots (the session cwd),
            // or the tool refuses to read it.
            const written: (string | null)[] = [];
            if (flags.out) {
                mkdirSync(flags.out, { recursive: true });
                compiled.segments.forEach((seg, i) => {
                    if (seg.kind !== 'code') {
                        written.push(null);
                        return;
                    }
                    const file = join(flags.out as string, `${name}.seg${i + 1}.js`);
                    writeFileSync(file, `${seg.code}\n`, 'utf8');
                    written.push(resolve(file));
                });
            }

            if (flags.json) {
                console.log(JSON.stringify({ ...compiled, written }, null, 2));
                break;
            }

            for (const w of compiled.warnings) console.error(`warning: ${w}`);
            if (macro.notes?.length) {
                console.log(`# ${macro.name} — learned invariants (read before running)`);
                for (const n of macro.notes) console.log(`#   - ${n}`);
                console.log('');
            }
            const total = compiled.segments.length;
            compiled.segments.forEach((seg, i) => {
                const steps = seg.steps.join(',');
                if (seg.kind === 'mcp') {
                    console.log(
                        `# segment ${i + 1}/${total} — call the MCP tool ${seg.tool} directly (step ${steps}: ${seg.why})`,
                    );
                    console.log(`${seg.tool} ${JSON.stringify(seg.args)}`);
                } else if (written[i]) {
                    console.log(
                        `# segment ${i + 1}/${total} — steps ${steps}. Run it without retyping anything:`,
                    );
                    console.log(`browser_run_code_unsafe { "filename": ${JSON.stringify(written[i])} }`);
                } else {
                    console.log(
                        `# segment ${i + 1}/${total} — pass verbatim as the "code" arg of ONE browser_run_code_unsafe call (steps ${steps})`,
                    );
                    console.log(seg.code);
                }
                console.log('');
            });
            break;
        }

        case 'create': {
            if (!name) fail('usage: create <name> (--from <file|-> | --template)');
            if (!NAME_RE.test(name)) fail(`"${name}" is not kebab-case`);
            const existing = findMacro(name);
            if (existing) fail(`macro "${name}" already exists in ${existing.scope} — use update`);
            const scope: Scope = flags.local ? 'local' : 'generic';
            const macro: Macro = flags.from
                ? (JSON.parse(readInput(flags.from)) as Macro)
                : flags.template
                    ? template(name)
                    : fail('create needs --from <file|-> or --template');
            macro.name ??= name;
            const problems = validate(macro, name);
            if (problems.length && !flags.template)
                fail(`invalid macro:\n  - ${problems.join('\n  - ')}`);
            writeOne(macro, scope);
            await afterMutation('created', name, scope);
            break;
        }

        case 'update': {
            if (!name) fail('usage: update <name> (--from <file|-> | --set k=v | --add-note "...")');
            const { __scope: scope, ...current } = loadOne(name);
            let next: Macro = current;
            if (flags.from) {
                next = JSON.parse(readInput(flags.from)) as Macro;
                next.name ??= name;
                // A wholesale rewrite bypasses the per-note guards, so report rather than block.
                (next.notes ?? []).forEach((note, i) => {
                    (next.notes ?? []).slice(0, i).forEach((old, j) => {
                        if (sharedPrefix(old, note) >= 120 || noteSimilarity(old, note) >= 0.6) {
                            console.error(`warning: note [${i}] restates note [${j}] — merge them.`);
                        }
                    });
                    if (note.length > NOTE_HARD_LIMIT) {
                        console.error(
                            `warning: note [${i}] is ${note.length} chars — split it, one fact per note.`,
                        );
                    }
                    if (RUN_LOG_RE.test(note)) {
                        console.error(`warning: note [${i}] is a run log — it belongs in "verified".`);
                    }
                });
            }
            for (const pair of flags.set) {
                const idx = pair.indexOf('=');
                if (idx === -1) fail(`--set expects key=value (got ${pair})`);
                const key = pair.slice(0, idx);
                const raw = pair.slice(idx + 1);
                let value: unknown = raw;
                try {
                    value = JSON.parse(raw);
                } catch {
                    /* keep the raw string */
                }
                (next as unknown as Record<string, unknown>)[key] = value;
            }
            if (flags.addNote) {
                checkNote(flags.addNote, next.notes ?? [], flags.force);
                next.notes = [...(next.notes ?? []), flags.addNote];
            }
            if (flags.replaceNote) {
                const [rawIndex, replacement] = flags.replaceNote;
                if (replacement === undefined) fail('--replace-note takes <index> "<note>"');
                const notes = [...(next.notes ?? [])];
                const i = noteIndex(rawIndex, notes);
                // Checked against every OTHER note: a replacement is meant to look like the one it replaces.
                checkNote(
                    replacement,
                    notes.filter((_, j) => j !== i),
                    flags.force,
                );
                notes[i] = replacement;
                next.notes = notes;
            }
            if (flags.dropNote !== undefined) {
                const notes = [...(next.notes ?? [])];
                const i = noteIndex(flags.dropNote, notes);
                console.log(`dropping note [${i}]: ${notes[i].slice(0, 80)}...`);
                notes.splice(i, 1);
                next.notes = notes;
            }
            if (
                !flags.from &&
                flags.set.length === 0 &&
                !flags.addNote &&
                !flags.replaceNote &&
                flags.dropNote === undefined
            ) {
                fail('update needs --from, --set, --add-note, --replace-note or --drop-note');
            }
            const problems = validate(next, name);
            if (problems.length) fail(`invalid macro:\n  - ${problems.join('\n  - ')}`);
            writeOne(next, scope);
            await afterMutation('updated', name, scope);
            break;
        }

        case 'delete': {
            if (!name) fail('usage: delete <name> --yes');
            if (!flags.yes) fail(`refusing to delete "${name}" without --yes`);
            const found = findMacro(name);
            if (!found) fail(`no macro named "${name}"`);
            rmSync(found.path);
            await afterMutation('deleted', name, found.scope);
            break;
        }

        default:
            console.log(
                [
                    'usage: macro-cli <command>',
                    '',
                    '  list [--json]                              list registered macros',
                    '  show <name> [--json]                       print one macro',
                    '  run <name> --param k=v [--out <dir>]       compile a macro for execution',
                    '  create <name> (--from <file|-> | --template) [--local]',
                    '  update <name> (--from <file|-> | --set k=v | --add-note "..."',
                    '                  | --replace-note <index> "..." | --drop-note <index>) [--force]',
                    '  delete <name> --yes',
                    '',
                    'Macro JSON is the source of truth, in two scopes:',
                    '  macros/        generic, committed, shared    -> SKILL.md   (generated)',
                    '  macros/local/  ticket-specific, git-ignored  -> LOCAL.md   (generated)',
                    'Both catalogs are git-ignored; SKILL.md is rebuilt from SKILL.template.md.',
                    'A macro any teammate could replay on any environment is generic; one that only makes',
                    'sense for a single ticket goes in local (`create --local`).',
                    'Every mutation regenerates both catalogs.',
                ].join('\n'),
            );
            if (command) process.exit(1);
    }
}

await main();
