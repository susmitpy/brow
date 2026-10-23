#!/usr/bin/env tsx
/**
 * macro-compile — turn a stored browser macro plus caller parameters into something
 * that *executes as a unit* instead of being retyped call by call.
 *
 * Why this exists: the macro registry used to be replayed by hand — an agent read the
 * JSON and issued what it remembered of the steps. That drifts (retyped arg values) and
 * truncates (the verification tail gets dropped, then success is claimed anyway).
 *
 * The Playwright MCP browser is launched with `--remote-debugging-pipe`, so there is no
 * CDP port for a CLI to attach to; we cannot drive the live session from Node. Instead we
 * compile the macro's steps into ONE self-contained `async (page) => {...}` script, which
 * the caller runs with a single `browser_run_code_unsafe` call. Every step runs or the
 * script throws — a prefix cannot be passed off as a whole run.
 *
 * A step whose tool has no faithful `page` equivalent (`browser_snapshot` returns the MCP
 * server's own accessibility format) is emitted as its own literal MCP segment, so those
 * macros stay runnable instead of being rejected wholesale.
 */

import type { Macro, MacroStep } from './macro-cli.ts';

/** A parameter binding supplied by the caller. */
export type MacroParams = Record<string, string | number | boolean>;

/** One unit of work the caller must perform, in order. */
export type Segment =
    | { kind: 'code'; code: string; steps: number[] }
    | { kind: 'mcp'; tool: string; args: Record<string, unknown>; steps: number[]; why: string };

export interface CompileResult {
    macro: string;
    segments: Segment[];
    /** Non-fatal observations worth showing the caller (ignored args, seconds-vs-ms, ...). */
    warnings: string[];
}

/** Tools compiled into the Playwright script. Anything else becomes an `mcp` segment. */
const COMPILED_TOOLS = new Set([
    'browser_navigate',
    'browser_wait_for',
    'browser_click',
    'browser_fill_form',
    'browser_type',
    'browser_press_key',
    'browser_find',
    'browser_evaluate',
    'browser_run_code_unsafe',
    'browser_take_screenshot',
    'browser_console_messages',
    'browser_network_requests',
    'browser_hover',
    'browser_select_option',
]);

/** Tools that genuinely cannot be reproduced through the `page` API. */
const MCP_ONLY: Record<string, string> = {
    browser_snapshot: "returns the MCP server's own accessibility snapshot format",
    browser_tabs: 'operates on the MCP server tab registry',
    browser_handle_dialog: 'needs the MCP dialog interception hook',
    browser_close: 'tears down the MCP-owned browser context',
};

/**
 * Args that change MCP behaviour but have no compiled equivalent, so the caller should know
 * they were dropped. `element` is deliberately absent: it is MCP's required human-readable
 * description of the target, not a behavioural argument, and warning on every click is noise.
 */
const IGNORED_ARGS: Record<string, string[]> = {
    browser_evaluate: ['filename'],
    browser_console_messages: ['all'],
    browser_network_requests: ['static'],
};

const PLACEHOLDER_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Substitute `{{placeholder}}` bindings through a parsed args tree.
 *
 * Walking the tree rather than string-replacing the serialised JSON keeps a value
 * containing a quote or backslash from corrupting the surrounding structure. A string that
 * is *exactly* one placeholder adopts the binding's own type, so `{{settleMs}}` with 2
 * yields the number 2 rather than "2".
 */
export function bind(value: unknown, params: MacroParams, missing: Set<string>): unknown {
    if (typeof value === 'string') {
        const whole = value.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
        if (whole) {
            if (!(whole[1] in params)) {
                missing.add(whole[1]);
                return value;
            }
            return params[whole[1]];
        }
        return value.replace(PLACEHOLDER_RE, (match, name: string) => {
            if (!(name in params)) {
                missing.add(name);
                return match;
            }
            return String(params[name]);
        });
    }
    if (Array.isArray(value)) return value.map((v) => bind(v, params, missing));
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([k, v]) => [
                k,
                bind(v, params, missing),
            ]),
        );
    }
    return value;
}

/** JSON literal safe to paste into generated JS. */
function lit(value: unknown): string {
    return JSON.stringify(value ?? null);
}

/** Default timeout (ms) for locator waits inside a compiled macro. */
const STEP_TIMEOUT = 15000;

/**
 * Optional steps use a much shorter wait. The expected outcome of an optional step is
 * often "the element is not there", and blocking the full STEP_TIMEOUT on that costs the
 * whole run 15s for a step whose absence is normal.
 */
const OPTIONAL_STEP_TIMEOUT = 3000;

/**
 * Compile one step's body. `args` are already bound. Returned code runs with `page`,
 * `__console` and `__network` in scope and must assign to `result`.
 */
function compileStep(
    step: MacroStep,
    index: number,
    args: Record<string, unknown>,
    warnings: string[],
): string {
    const timeout = step.optional ? OPTIONAL_STEP_TIMEOUT : STEP_TIMEOUT;
    switch (step.tool) {
        case 'browser_navigate':
            return `result = await page.goto(${lit(args.url)}, { waitUntil: 'domcontentloaded', timeout: ${timeout} }).then((r) => ({ url: page.url(), status: r && r.status() }));`;

        case 'browser_wait_for': {
            if (args.time !== undefined) {
                const seconds = Number(args.time);
                if (!Number.isFinite(seconds)) {
                    throw new Error(`browser_wait_for: "time" must be a number (got ${lit(args.time)})`);
                }
                if (seconds > 60) {
                    warnings.push(
                        `browser_wait_for time=${seconds} is interpreted as SECONDS (MCP semantics), i.e. ${seconds}s — if milliseconds were meant, fix the macro.`,
                    );
                }
                return `await page.waitForTimeout(${seconds * 1000}); result = { waited: ${seconds} };`;
            }
            if (args.textGone !== undefined) {
                return `await page.getByText(${lit(args.textGone)}, { exact: false }).first().waitFor({ state: 'hidden', timeout: ${timeout} }); result = { textGone: ${lit(args.textGone)} };`;
            }
            if (args.text === undefined)
                throw new Error('browser_wait_for needs "text", "textGone" or "time"');
            return `await page.getByText(${lit(args.text)}, { exact: false }).first().waitFor({ state: 'visible', timeout: ${timeout} }); result = { sawText: ${lit(args.text)} };`;
        }

        case 'browser_click': {
            const target = requireTarget(step, args);
            const clickOpts = args.doubleClick ? '.dblclick' : '.click';
            return `await page.locator(${lit(target)}).first()${clickOpts}({ timeout: ${timeout} }); result = { clicked: ${lit(target)} };`;
        }

        case 'browser_hover':
            return `await page.locator(${lit(requireTarget(step, args))}).first().hover({ timeout: ${timeout} }); result = { hovered: ${lit(args.target)} };`;

        case 'browser_type': {
            const target = requireTarget(step, args);
            const body = args.slowly
                ? `await l.pressSequentially(${lit(args.text)}, { delay: 40 });`
                : `await l.fill(${lit(args.text)});`;
            const submit = args.submit ? `await l.press('Enter');` : '';
            return `{ const l = page.locator(${lit(target)}).first(); await l.waitFor({ state: 'visible', timeout: ${timeout} }); ${body} ${submit} result = { typedInto: ${lit(target)} }; }`;
        }

        case 'browser_press_key':
            return `await page.keyboard.press(${lit(args.key)}); result = { pressed: ${lit(args.key)} };`;

        case 'browser_select_option':
            return `result = await page.locator(${lit(requireTarget(step, args))}).first().selectOption(${lit(args.values)});`;

        case 'browser_find': {
            if (args.text === undefined) throw new Error('browser_find needs "text"');
            return `{ const l = page.getByText(${lit(args.text)}, { exact: false }); const n = await l.count(); result = { matches: n, texts: n ? (await l.allInnerTexts()).slice(0, 10) : [] }; if (!n) throw new Error('browser_find: no element matching ' + ${lit(args.text)}); }`;
        }

        case 'browser_fill_form': {
            const fields = args.fields;
            if (!Array.isArray(fields) || fields.length === 0) {
                throw new Error('browser_fill_form needs a non-empty "fields" array');
            }
            const parts = fields.map((f) => {
                const field = f as Record<string, unknown>;
                const target = field.target;
                if (!target) throw new Error(`browser_fill_form: field ${lit(field.name)} has no "target"`);
                const l = `page.locator(${lit(target)}).first()`;
                switch (field.type) {
                    case 'checkbox':
                    case 'radio':
                        return `await ${l}.setChecked(${Boolean(field.value)}, { timeout: ${timeout} });`;
                    case 'combobox':
                        return `await ${l}.selectOption(${lit(field.value)}, { timeout: ${timeout} });`;
                    default:
                        return `await ${l}.fill(String(${lit(field.value)}), { timeout: ${timeout} });`;
                }
            });
            const names = fields.map((f) => (f as Record<string, unknown>).name ?? null);
            return `${parts.join(' ')} result = { filled: ${lit(names)} };`;
        }

        case 'browser_evaluate': {
            if (args.function === undefined) throw new Error('browser_evaluate needs "function"');
            const fn = `(${String(args.function)})`;
            return args.target
                ? `result = await page.locator(${lit(args.target)}).first().evaluate(${fn});`
                : `result = await page.evaluate(${fn});`;
        }

        case 'browser_run_code_unsafe': {
            if (args.code === undefined) throw new Error('browser_run_code_unsafe needs "code"');
            return `result = await (${String(args.code)})(page);`;
        }

        case 'browser_take_screenshot': {
            const file = (args.filename as string) ?? `${step.tool}-step-${index}.png`;
            // MCP's scale:'css' is its own viewport concept and has no page.screenshot analogue;
            // fullPage is honoured only when the macro asks for it explicitly.
            const fullPage = args.fullPage === true && !args.target ? ', fullPage: true' : '';
            const shotTarget = args.target ? `page.locator(${lit(args.target)}).first()` : 'page';
            return `{ const p = __artifact(${lit(file)}); await ${shotTarget}.screenshot({ path: p${fullPage} }); result = { screenshot: p }; }`;
        }

        case 'browser_console_messages': {
            const level = args.level ? String(args.level) : null;
            return level
                ? `result = { level: ${lit(level)}, messages: __console.filter((m) => m.type === ${lit(level)}), totalCaptured: __console.length };`
                : `result = { messages: __console.slice(), totalCaptured: __console.length };`;
        }

        case 'browser_network_requests':
            return `result = { requests: __network.slice(-100), totalCaptured: __network.length };`;

        default:
            throw new Error(`no compiler for tool "${step.tool}"`);
    }
}

function requireTarget(step: MacroStep, args: Record<string, unknown>): string {
    if (!args.target) throw new Error(`${step.tool}: "target" is required to compile this step`);
    return String(args.target);
}

/** Preamble shared by every compiled segment: evidence collectors + artifact paths. */
function preamble(artifactDir: string): string {
    return [
        `const __console = []; const __network = [];`,
        `const __onConsole = (m) => { __console.push({ type: m.type(), text: m.text().slice(0, 500) }); };`,
        `const __onPageError = (e) => { __console.push({ type: 'error', text: 'pageerror: ' + String(e && e.message || e).slice(0, 500) }); };`,
        `const __onResponse = (r) => { const q = r.request(); __network.push({ method: q.method(), url: r.url().slice(0, 300), status: r.status() }); };`,
        `page.on('console', __onConsole); page.on('pageerror', __onPageError); page.on('response', __onResponse);`,
        `const __artifact = (f) => ${JSON.stringify(artifactDir)} + '/' + String(f).replace(/^\\/+/, '');`,
        `const __steps = [];`,
    ].join('\n  ');
}

/** Epilogue: detach listeners so repeated runs on the same page do not double-count. */
function epilogue(): string {
    return [
        `page.off('console', __onConsole); page.off('pageerror', __onPageError); page.off('response', __onResponse);`,
    ].join('\n    ');
}

/**
 * Compile a macro into ordered segments.
 *
 * Throws when a required parameter is unbound or a step cannot be compiled — a macro that
 * would half-run is not worth emitting.
 */
export function compile(
    macro: Macro,
    params: MacroParams,
    opts: { artifactDir?: string } = {},
): CompileResult {
    const artifactDir = opts.artifactDir ?? '.playwright-mcp';
    const warnings: string[] = [];

    const required = macro.parameters.filter((p) => p.required !== false).map((p) => p.name);
    const absent = required.filter((n) => !(n in params));
    if (absent.length) {
        throw new Error(
            `missing required parameter(s): ${absent.join(', ')}\n` +
            macro.parameters
                .map(
                    (p) =>
                        `  --param ${p.name}=<${p.type}>${p.required === false ? ' (optional)' : ''}` +
                        (p.example === undefined ? '' : `   e.g. ${JSON.stringify(p.example)}`),
                )
                .join('\n'),
        );
    }
    for (const key of Object.keys(params)) {
        if (!macro.parameters.some((p) => p.name === key)) {
            warnings.push(`--param ${key} is not declared by this macro and was ignored`);
        }
    }

    // A declared-optional parameter the caller did not supply drops every step that refers
    // to it. Erroring instead would make `[settleMs]`-style parameters impossible to omit.
    const unsupplied = macro.parameters
        .filter((p) => p.required === false && !(p.name in params))
        .map((p) => p.name);
    const referencesUnsupplied = (step: MacroStep): string | null => {
        const text = JSON.stringify(step.args ?? {});
        for (const name of unsupplied) {
            if (new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`).test(text)) return name;
        }
        return null;
    };
    const live: number[] = [];
    macro.steps.forEach((step, i) => {
        const dropped = referencesUnsupplied(step);
        if (dropped) {
            warnings.push(
                `steps[${i}] (${step.tool}) dropped: optional parameter "${dropped}" was not supplied`,
            );
            return;
        }
        live.push(i);
    });
    if (live.length === 0) throw new Error('every step was dropped — supply at least one parameter');

    // Group consecutive compilable steps; MCP-only steps break the run into segments.
    const groups: { compiled: boolean; indices: number[] }[] = [];
    live.forEach((i) => {
        const step = macro.steps[i];
        const compiled = COMPILED_TOOLS.has(step.tool);
        if (!compiled && !(step.tool in MCP_ONLY)) {
            throw new Error(
                `steps[${i}]: "${step.tool}" is neither compilable nor a known MCP-only tool. ` +
                `Add it to COMPILED_TOOLS in macro-compile.ts, or to MCP_ONLY with a reason.`,
            );
        }
        const last = groups[groups.length - 1];
        if (last && last.compiled && compiled) last.indices.push(i);
        else groups.push({ compiled, indices: [i] });
    });

    const missing = new Set<string>();
    const segments: Segment[] = groups.map((group) => {
        if (!group.compiled) {
            const i = group.indices[0];
            const step = macro.steps[i];
            return {
                kind: 'mcp',
                tool: step.tool,
                args: bind(step.args ?? {}, params, missing) as Record<string, unknown>,
                steps: group.indices,
                why: MCP_ONLY[step.tool],
            };
        }

        const bodies = group.indices.map((i) => {
            const step = macro.steps[i];
            const args = bind(step.args ?? {}, params, missing) as Record<string, unknown>;
            for (const ignored of IGNORED_ARGS[step.tool] ?? []) {
                if (ignored in args) {
                    warnings.push(`steps[${i}] (${step.tool}): arg "${ignored}" has no compiled effect`);
                }
            }

            let body: string;
            try {
                body = compileStep(step, i, args, warnings);
            } catch (err) {
                throw new Error(`steps[${i}] (${step.tool}): ${(err as Error).message}`);
            }

            const label = `${i}:${step.tool}`;
            const assertion = step.assert
                ? `\n      if (!(${step.assert})) throw new Error(${lit(`assertion failed at step ${label}: ${step.assert}`)} + ' — got ' + JSON.stringify(result));`
                : '';
            const record = `\n      __steps.push({ step: ${i}, tool: ${lit(step.tool)}, result });`;

            // An optional step records its failure and continues; every other step aborts the run.
            if (step.optional) {
                return [
                    `  try {`,
                    `    let result;`,
                    `    ${body}${assertion}${record}`,
                    `  } catch (err) {`,
                    `    __steps.push({ step: ${i}, tool: ${lit(step.tool)}, skipped: String(err && err.message || err).split('\\n')[0] });`,
                    `  }`,
                ].join('\n');
            }
            return [
                `  {`,
                `    let result;`,
                `    try {`,
                `      ${body}${assertion}${record}`,
                `    } catch (err) {`,
                `      throw new Error(${lit(`macro ${macro.name} failed at step ${label}: `)} + String(err && err.message || err) + ' | completed: ' + JSON.stringify(__steps));`,
                `    }`,
                `  }`,
            ].join('\n');
        });

        const code = [
            `async (page) => {`,
            `  ${preamble(artifactDir)}`,
            `  try {`,
            bodies.join('\n'),
            `    return { macro: ${lit(macro.name)}, ok: true, steps: __steps, url: page.url(), title: await page.title() };`,
            `  } finally {`,
            `    ${epilogue()}`,
            `  }`,
            `}`,
        ].join('\n');

        return { kind: 'code', code, steps: group.indices };
    });

    if (missing.size) {
        throw new Error(
            `unbound placeholder(s) in steps: ${[...missing].join(', ')} — declare them in "parameters" and pass --param`,
        );
    }

    return { macro: macro.name, segments, warnings };
}
