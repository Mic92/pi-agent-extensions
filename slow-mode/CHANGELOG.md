# Slow Mode Extension - Changelog

## 2026-08-25 - Live Backend Switching

### Added
- **`b` cycles the diff backend during a review** — difft → delta → builtin, skipping anything not installed. Previously the backend was fixed at launch by `PI_SLOW_MODE_DIFF`, so noticing mid-review that difftastic had collapsed something you wanted to see meant rejecting the change and restarting pi. The choice persists for the session, and the header already names the active backend, so there is a live readout. With neither difft nor delta installed the cycle has a single member and the key is a no-op.

- **delta renders side-by-side.** `s` previously did nothing under delta. The cause was `--color-only`, which makes delta ignore `--side-by-side` — splitting into columns is a structural rewrite, and that flag exists to forbid exactly that. Columns now drop the flag and suppress delta's own file banner and boxed hunk markers instead, so its output does not duplicate the review header. Inline keeps `--color-only` as before.

### Fixed
- **`s` is withdrawn when the backend cannot do columns.** The built-in renderer only emits unified diffs, but the layout toggle was offered regardless — so on a terminal 140 columns or wider the header announced `side-by-side` above an inline diff, and `s` toggled nothing but the label. The key and its hint now appear only under difft and delta, and the built-in claims no layout at all. Reachable in two keystrokes now that `b` exists; previously it needed `PI_SLOW_MODE_DIFF=delta`.
- **Rendered diffs are cached per backend.** The body cache was keyed on `width:layout:context`, so a backend change would have silently reused the previous render.
- **Child processes get the current environment.** Every `spawnSync` now passes `env: process.env` explicitly. Bun snapshots the environment at startup and does not apply later `process.env` mutations to children — or to resolving the command on PATH — which meant a `difft`, `delta` or `$EDITOR` supplied by a direnv-managed shell was invisible, since the direnv extension works by mutating `process.env`.

## 2026-08-24 - Terminal Handover and Context-Aware Diffs

### Fixed
- **External tools now own the terminal.** The pager and editor were spawned with `stdio: "inherit"` while pi still held stdin in raw mode with its own data handler attached. The child appeared but never received a keystroke — arrow keys scrolled pi's transcript behind it instead. External processes now run inside `tui.stop()` / `tui.start()`, the same handover pi uses for its own Ctrl+G editor, followed by a forced full repaint.
- **Manual edits reached the tool.** After Ctrl+E the edited content was written to `input.newText`, which the edit tool ignores — it only reads `edits[]`. The hand-edited result is now folded back into `edits[]` as a single minimal replacement, verified to match the file exactly once.
- **Multi-edit diffs are no longer fabricated.** All `edits[]` entries were concatenated with `\n` and diffed blob-against-blob, which invented changes at the seams. Each fragment is now applied to the document in turn.
- **`$VISUAL`/`$EDITOR` with arguments.** `code --wait` was executed as a single binary name; the command is now split.
- **Delta's erase-in-line sequences are stripped.** `CSI K` tells the terminal to clear the rest of the physical line, which corrupted pi's differential renderer. Each rendered line also ends with a reset so background colours cannot bleed.

### Added
- **Full-file context.** Edits are reconstructed against the real file on disk, so hunk headers carry true line numbers and context lines come from the file rather than the fragment. The header states which mode is in use.
- **difftastic backend.** When `difft` is available it is preferred: a structural diff that compares parsed syntax trees, so reindentation and moved braces stop reading as changes and only the tokens that actually differ are highlighted. Falls back to delta, then to the built-in Myers diff. Override with `PI_SLOW_MODE_DIFF=difft|delta|builtin`.
- **Layout and context controls.** `s` toggles side-by-side/inline, `[` and `]` narrow and widen context. Side-by-side is chosen automatically when the viewport is wide enough. Starting context can be set with `PI_SLOW_MODE_CONTEXT`.
- **Overwrite review.** A `write` over an existing file now shows a diff instead of only the new content, so an accidental clobber is visible.
- **Ctrl+O opens a pager** on the same rendered diff, for unconstrained scrolling. `$PAGER` is deliberately ignored — it is commonly `bat --paging=always`, which re-decorates already-styled content.
- **Tests** (`bun test slow-mode`), pinned to the built-in backend so they do not depend on difftastic or delta being installed.

### Changed
- The inline window height now follows the terminal instead of a fixed 30 rows, and key hints wrap instead of truncating.
- The redundant `--- a/path` / `+++ b/path` banner is no longer shown; the review header already names the file.
- Ctrl+E is hidden when a manual edit could not be mapped back onto the tool call (multi-edit calls without file context).

## 2026-02-13 - Manual Editing Support

### Added
- **Manual editing of staged content**: When reviewing write/edit operations with Ctrl+O, you can now edit the staged files in your external editor
- **Content update tracking**: The extension tracks which tool calls had their content modified
- **Visual feedback**: 
  - Notification when edited content is detected: "Using edited content"
  - Note appended to tool results showing content was modified with line diff stats
  - UI hint changes from "view externally" to "edit externally" when editing is enabled
- **Live preview updates**: After editing in external editor, the review UI automatically reloads and displays the updated content/diff

### How It Works

1. **Review Phase**: Slow mode intercepts write/edit tool calls and stages content in `/tmp/pi-slow-mode-*/`
2. **External Editing**: Press Ctrl+O to open staged files in your `$EDITOR` or diff viewer
3. **Content Reload**: After saving and closing the editor, the UI reloads the modified content
4. **Approval**: Review the changes and press Enter to approve or Esc to reject
5. **Execution**: The actual write/edit operation uses your edited content, not the LLM's original proposal

### What Gets Updated

✅ **Actual file content**: The write/edit tool uses your edited content  
✅ **Tool result note**: Shows that content was modified with line count change  
✅ **Review UI**: Displays updated content/diff after external editing  
❌ **Collapsed snippet**: Still shows original LLM proposal (by design)

### Why the Snippet Shows Original Content

The collapsed snippet (what you see with "ctrl+o to expand") shows the LLM's original proposal, not your edited version. This is **intentional** because:
- It preserves a record of what the LLM proposed vs. what was actually applied
- The snippet is rendered before interception happens (technical limitation)
- You can see the actual content that was written by:
  - Reading the tool result note (shows modification happened)
  - Expanding the snippet to see the full original
  - Checking the actual file that was written
  - Looking at the review UI which shows updated content

### Example

```
LLM proposes: "Hello, World!" (shown in snippet)
              ↓
You edit to: "Hello, Universe!" (in external editor)
              ↓
File written: "Hello, Universe!" (actual content)
              ↓
Result shows: "Note: Content was modified in slow mode review before writing (+0 lines)."
```

### Technical Details

- **Tracking**: Uses a Map<toolCallId, {original, edited}> to track modifications
- **Content mutation**: Modifies the `input.content` / `input.newText` parameters directly
- **Event flow**: tool_call (intercept) → review → modify input → tool executes → tool_result (annotate)
- **Cleanup**: Edited call tracking is cleaned up immediately after tool result is processed
