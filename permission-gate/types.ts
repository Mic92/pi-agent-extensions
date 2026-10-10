/**
 * permission-gate — shared types.
 */

import type { deferredScripts, nestedScripts, pipelines, SHELLS, simpleCommands, unwrap, unwrapSteps } from "./shell.ts";
import type { anyCmd, hasFlag } from "./helpers.ts";

/**
 * Event names on pi's event bus. External callers (e.g. a Telegram bridge)
 * can observe prompts via `waiting`/`resolved` and answer them by emitting
 * `respond` — shared constants so the emitting and listening sides cannot
 * drift apart.
 */
export const EVENTS = {
	/** Emitted with `{ command, labels }` when a review prompt opens. */
	waiting: "permission-gate:waiting",
	/** Emitted when the prompt is answered (any outcome). */
	resolved: "permission-gate:resolved",
	/** Listened for while a prompt is open; payload `{ allow?, reason? }`. */
	respond: "permission-gate:respond",
	/** Emitted by shell extensions (e.g. nushell) with an `Analyze` as payload; replaces the POSIX parser. */
	analyzer: "permission-gate:analyzer",
} as const;

/** How a matched rule is handled. */
export type Action = "prompt" | "block";

/** Where a compiled rule came from (for /gate list and /gate rm). */
export type RuleSource = "built-in" | "user-code" | "user-json" | "project";

/** A pipeline as seen by argv rules: one string[] per command joined by |. */
export type ArgvPipeline = string[][];

/**
 * Rule as written in config. Exactly one of `pattern` / `test` must be set
 * (if both are, `test` wins and a warning is emitted). `pattern` matches
 * the raw command string; `test` receives tokenized
 * pipelines (see shell.ts) and is called once per pipeline, including those
 * inside $() / <() substitutions.
 *
 * Note for `test` authors: argv words may contain substitution placeholders
 * (`$(...)`, `<(...)`) where the tokenizer lifted out a nested script, and
 * wrapper programs (sudo, env, timeout, …) may precede the real command —
 * prefer `helpers.anyCmd` / `helpers.unwrapSteps` over raw `argv[0]`
 * checks, or wrappers will hide the program you are matching.
 */
export interface RuleEntry {
	label: string;
	/** Coarse category for bulk enable/disable (see README: privilege, files,
	 * device, vcs, exec, scan, guard). Optional for user rules. */
	group?: string;
	/** Regex on the raw command string. String is compiled with `flags` (default "i"). */
	pattern?: string | RegExp;
	flags?: string;
	/** Argv predicate on a tokenized pipeline. */
	test?: (pipeline: ArgvPipeline) => boolean;
	/** Default: "prompt". */
	action?: Action;
	/** Message returned to the model on block. Defaults to a generic one derived from `label`. */
	reason?: string;
}

/** Config file shape (rules.ts / rules.json / .pi/permission-gate.json). */
export interface GateConfig {
	/** Replace the built-in *prompt* defaults entirely. Block defaults are only removable via `disabledRules`. */
	rules?: RuleEntry[];
	/** Extra rules appended on top of defaults. */
	extraRules?: RuleEntry[];
	/** Disable rules (built-in or from an earlier layer) by label. */
	disabledRules?: string[];
	/** Disable whole rule groups by name — the coarse dial. `/gate off <group>` writes here. */
	disabledGroups?: string[];
}

/** Helpers passed to a rules.ts factory so it needs no cross-package imports. */
export interface GateHelpers {
	simpleCommands: typeof simpleCommands;
	pipelines: typeof pipelines;
	searchPaths: (argv: string[]) => string[];
	/** Strip wrapper programs (sudo, env, xargs, …) so argv[0] is the real command. */
	unwrap: typeof unwrap;
	/** Every argv seen while stripping wrappers, outermost first. Prefer this
	 * (or `anyCmd`) over `unwrap` when the program you match is itself a
	 * wrapper — `env sudo id` never shows sudo in the final unwrap result. */
	unwrapSteps: typeof unwrapSteps;
	/** Inline scripts a command executes (`sh -c '…'`, `eval …`). */
	nestedScripts: typeof nestedScripts;
	/** Shell code handed to another process to run later (`pueue add …`,
	 * `tmux new-session …`, `find -exec …`). */
	deferredScripts: typeof deferredScripts;
	/** Match any argv in a pipeline whose program is `cmd`, checking every
	 * unwrap step — the combinator the built-in argv rules are written with. */
	anyCmd: typeof anyCmd;
	/** True if a short-option cluster contains `letter`, or an arg equals `long`. */
	hasFlag: typeof hasFlag;
	/** Programs that execute shell code (sh, bash, zsh, …). */
	SHELLS: typeof SHELLS;
}

/** rules.ts default export: either a config object or a factory receiving helpers. */
export type GateConfigModule = GateConfig | ((helpers: GateHelpers) => GateConfig);

/** Rule after compilation. */
export type CompiledRule = {
	label: string;
	group?: string;
	action: Action;
	reason?: string;
	source: RuleSource;
} & (
	| { kind: "regex"; pattern: RegExp }
	| { kind: "argv"; test: (pipeline: ArgvPipeline) => boolean }
);

export type WarnFn = (msg: string) => void;

export type GateResult = { allow: true } | { allow: false; reason: string };
