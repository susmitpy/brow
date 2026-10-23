#!/usr/bin/env tsx
/**
 * update-browser-macros-skill — regenerate the macro catalogs.
 *
 * Two scopes, two catalogs:
 *   - generic: `SKILL.template.md` + `macros/*.json` -> `SKILL.md`.
 *   - local:   `macros/local/*.json` -> `LOCAL.md`.
 *
 * Neither catalog is committed. `SKILL.template.md` — the hand-written prose plus
 * the BEGIN/END markers — is the committed source; `SKILL.md` is rebuilt from it
 * on install (`postinstall`) and on `git pull` (a `post-merge` hook). Committing a file that every
 * teammate regenerates only produced merge conflicts in a derived artifact.
 *
 * The split exists so the committed skill stays a small catalog of reusable
 * workflows: a macro recorded to reproduce one ticket's bug is real knowledge but
 * dead weight in every teammate's context once that ticket ships.
 *
 * Contract:
 *   - The macro JSON and `SKILL.template.md` are the sources of truth; the
 *     catalogs are derived and git-ignored.
 *   - Only the region between the BEGIN/END markers is rewritten. Everything the
 *     humans wrote outside that region is preserved byte-for-byte — so prose
 *     edits go in `SKILL.template.md`, never in the generated `SKILL.md`.
 *   - Generation is idempotent: rendering twice from the same macros produces the
 *     same bytes, and the file is only written when the content actually changes.
 *
 *   pnpm skills:refresh
 *   pnpm skills:refresh --check   # exit 1 if a catalog is stale (for CI/hooks)
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SKILL_DIR = join(REPO_ROOT, '.claude/skills/browser-macros');

/**
 * The two macro scopes. `template` names the committed file whose non-generated
 * bytes the catalog is rebuilt from; without one (local) the catalog seeds itself
 * from a stub and thereafter carries its own prose.
 */
export const SCOPES = {
    generic: {
        macroDir: join(SKILL_DIR, 'macros'),
        catalogPath: join(SKILL_DIR, 'SKILL.md'),
        templatePath: join(SKILL_DIR, 'SKILL.template.md'),
        relDir: 'macros/',
    },
    local: {
        macroDir: join(SKILL_DIR, 'macros/local'),
        catalogPath: join(SKILL_DIR, 'LOCAL.md'),
        relDir: 'macros/local/',
    },
} as const;

export type Scope = keyof typeof SCOPES;

/**
 * LOCAL.md is git-ignored, so a fresh checkout has none. Seed it rather than
 * failing: a missing catalog must not block a macro write.
 */
const LOCAL_CATALOG_STUB = [
    '# Browser Macros — ticket-specific (local only)',
    '',
    'Generated from `macros/local/*.json`. Git-ignored: these macros were recorded to',
    'reproduce or validate one ticket and are not shared with the team. The reusable',
    'catalog is `SKILL.md`.',
    '',
    '<!-- BEGIN GENERATED MACROS -->',
    '<!-- END GENERATED MACROS -->',
    '',
].join('\n');

export const BEGIN_MARKER = '<!-- BEGIN GENERATED MACROS -->';
export const END_MARKER = '<!-- END GENERATED MACROS -->';

interface MacroParameter {
    name: string;
    type?: string;
    required?: boolean;
    example?: unknown;
    note?: string;
}

interface MacroStep {
    tool: string;
    args?: Record<string, unknown>;
    note?: string;
    optional?: boolean;
    assert?: string;
}

interface Macro {
    name: string;
    purpose?: string;
    parameters?: MacroParameter[];
    steps?: MacroStep[];
    returns?: string;
    replacesCalls?: number;
    reuseRationale?: string;
    verified?: { date?: string; environment?: string; url?: string };
    notes?: string[];
}

export interface RefreshResult {
    changed: boolean;
    macroCount: number;
    skillPath: string;
    content: string;
}

function loadMacros(dir: string): Macro[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort() // deterministic order -> deterministic output
        .map((f) => {
            const path = join(dir, f);
            try {
                return JSON.parse(readFileSync(path, 'utf8')) as Macro;
            } catch (err) {
                throw new Error(`${relative(REPO_ROOT, path)}: invalid JSON — ${(err as Error).message}`);
            }
        });
}

function escapeCell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

function formatParameter(p: MacroParameter): string {
    const optional = p.required === false;
    const type = p.type ? `: ${p.type}` : '';
    return optional ? `[${p.name}${type}]` : `${p.name}${type}`;
}

/** Render the catalog body (without markers). Pure function of the macros. */
export function renderCatalog(macros: Macro[], relDir = 'macros/'): string {
    if (macros.length === 0) {
        return ['', '_No macros registered yet. Add one with `macro-cli create`._', ''].join('\n');
    }

    const lines: string[] = [''];
    lines.push(
        `${macros.length} macro${macros.length === 1 ? '' : 's'} registered in \`.claude/skills/browser-macros/${relDir}\`.`,
    );
    lines.push('');
    lines.push('| Macro | Purpose | Parameters | Steps | ~Calls saved | Verified |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const m of macros) {
        const params = (m.parameters ?? []).map(formatParameter).join(', ') || '—';
        const verified = m.verified?.date
            ? `${m.verified.date}${m.verified.environment ? ` (${m.verified.environment})` : ''}`
            : 'never';
        lines.push(
            `| \`${m.name}\` | ${escapeCell(m.purpose ?? '')} | ${escapeCell(params)} | ${m.steps?.length ?? 0} | ${m.replacesCalls ?? '?'} | ${escapeCell(verified)} |`,
        );
    }
    lines.push('');

    for (const m of macros) {
        lines.push(`### \`${m.name}\``);
        lines.push('');
        if (m.purpose) lines.push(m.purpose);
        lines.push('');
        if (m.parameters?.length) {
            lines.push('**Parameters**');
            lines.push('');
            for (const p of m.parameters) {
                const bits = [
                    `\`${p.name}\``,
                    p.type ? `(${p.type}${p.required === false ? ', optional' : ''})` : '',
                    p.example !== undefined ? `e.g. \`${String(p.example)}\`` : '',
                    p.note ?? '',
                ].filter(Boolean);
                lines.push(`- ${bits.join(' — ')}`);
            }
            lines.push('');
        }
        if (m.steps?.length) {
            lines.push(
                `**Steps** (${m.steps.length}): ${m.steps
                    .map(
                        (s) => `\`${s.tool}\`${s.optional ? '(optional)' : ''}${s.assert ? '(asserted)' : ''}`,
                    )
                    .join(' → ')}`,
            );
            lines.push('');
        }
        if (m.returns) {
            lines.push(`**Returns**: ${m.returns}`);
            lines.push('');
        }
        if (m.reuseRationale) {
            lines.push(`**Why it recurs**: ${m.reuseRationale}`);
            lines.push('');
        }
        if (m.notes?.length) {
            lines.push('**Learned invariants**');
            lines.push('');
            for (const n of m.notes) lines.push(`- ${n}`);
            lines.push('');
        }
    }

    return lines.join('\n');
}

/** Splice the rendered catalog between the markers, leaving all other bytes intact. */
export function spliceCatalog(existing: string, catalog: string, catalogPath = ''): string {
    const label = catalogPath ? relative(REPO_ROOT, catalogPath) : 'catalog';
    const begin = existing.indexOf(BEGIN_MARKER);
    const end = existing.indexOf(END_MARKER);
    if (begin === -1 || end === -1) {
        throw new Error(`${label} is missing the ${BEGIN_MARKER} / ${END_MARKER} markers`);
    }
    if (end < begin) {
        throw new Error(`${label}: END marker appears before BEGIN marker`);
    }
    const head = existing.slice(0, begin + BEGIN_MARKER.length);
    const tail = existing.slice(end);
    return `${head}\n${catalog}\n${tail}`;
}

/**
 * Format the generated fragment with Prettier so the catalog matches what a
 * formatter would produce (Prettier pads markdown table cells). Only the fragment is
 * formatted — hand-written regions of the skill file are never reflowed. Falls
 * back to the raw fragment if Prettier is unavailable.
 */
async function formatFragment(fragment: string, catalogPath: string): Promise<string> {
    try {
        const prettier = await import('prettier');
        const config = await prettier.resolveConfig(catalogPath);
        const formatted = await prettier.format(fragment, {
            ...config,
            filepath: catalogPath,
            parser: 'markdown',
        });
        return `\n${formatted.trim()}\n`;
    } catch {
        return fragment;
    }
}

/** Regenerate one scope's catalog. */
export async function refreshScope(
    scope: Scope,
    { check = false }: { check?: boolean } = {},
): Promise<RefreshResult> {
    const config = SCOPES[scope];
    const { macroDir, catalogPath, relDir } = config;
    const templatePath = 'templatePath' in config ? config.templatePath : undefined;
    const macros = loadMacros(macroDir);

    // The generated catalog is rebuilt from its committed template every time, so a
    // missing SKILL.md is the normal state of a fresh checkout, not an error. A
    // missing template is the real error — nothing else holds the prose.
    if (templatePath && !existsSync(templatePath)) {
        throw new Error(`${relative(REPO_ROOT, templatePath)} does not exist`);
    }

    if (!templatePath && !existsSync(catalogPath) && macros.length === 0) {
        return {
            changed: false,
            macroCount: 0,
            skillPath: relative(REPO_ROOT, catalogPath),
            content: '',
        };
    }

    const source = templatePath ?? catalogPath;
    const existing = existsSync(source) ? readFileSync(source, 'utf8') : LOCAL_CATALOG_STUB;
    const fragment = await formatFragment(renderCatalog(macros, relDir), catalogPath);
    const next = spliceCatalog(existing, fragment, catalogPath);
    const current = existsSync(catalogPath) ? readFileSync(catalogPath, 'utf8') : '';
    const changed = next !== current;
    if (changed && !check) writeFileSync(catalogPath, next, 'utf8');
    return {
        changed,
        macroCount: macros.length,
        skillPath: relative(REPO_ROOT, catalogPath),
        content: next,
    };
}

/** Regenerate both catalogs. Reported as one result so callers stay simple. */
export async function refreshSkillCatalog({ check = false }: { check?: boolean } = {}): Promise<
    RefreshResult & { scopes: Record<Scope, RefreshResult> }
> {
    const generic = await refreshScope('generic', { check });
    const local = await refreshScope('local', { check });
    return {
        changed: generic.changed || local.changed,
        macroCount: generic.macroCount + local.macroCount,
        skillPath: generic.skillPath,
        content: generic.content,
        scopes: { generic, local },
    };
}

function isDirectRun(): boolean {
    const entry = process.argv[1] ? resolve(process.argv[1]) : '';
    return entry === resolve(fileURLToPath(import.meta.url));
}

if (isDirectRun()) {
    const check = process.argv.includes('--check');
    try {
        const result = await refreshSkillCatalog({ check });
        for (const [scope, r] of Object.entries(result.scopes)) {
            const state = check
                ? r.changed
                    ? 'stale'
                    : 'current'
                : r.changed
                    ? 'updated'
                    : 'already current';
            console.log(`${scope}: ${state} — ${r.skillPath} (${r.macroCount} macros)`);
        }
        if (check) process.exit(result.changed ? 1 : 0);
    } catch (err) {
        console.error(`update-browser-macros-skill: ${(err as Error).message}`);
        process.exit(1);
    }
}
