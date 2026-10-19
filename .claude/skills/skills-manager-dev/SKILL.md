---
name: skills-manager-dev
description: Working rules for the AI Skills Manager extension (this repo) — security, verified provider docs, readable code, tests and the finish-a-block checklist. Use for any change, fix, refactor, review or release in this repository.
---

# AI Skills Manager — how we work

A VS Code / Cursor extension that shows which agent (Claude Code, Cursor, Codex, GitHub Copilot) loads each Agent Skill, flags duplicates and invalid skills, edits each agent's config, and installs skills from GitHub safely. The value is **multi-agent visibility + diagnosis + safe install**, not a big catalog.

Talk to the user in Spanish. README is in English; `docs/ANALISIS.md` and `CHANGELOG.md` are in Spanish.

## 1. Never claim what a provider does without its docs

- Before relying on where or how an agent loads something (skills, rules, MCP, settings), read the agent's official documentation.
- Cite the URL and the date you checked it, in `src/core/providers/index.ts` (or the module that uses it) and in `docs/ANALISIS.md`.
- Mark every claim: ✅ verified · ⚠️ partial / observed on disk only · ❓ not verified yet.
- If the docs and their own examples disagree (it happens), follow the documented table, say so in a comment, and pick the form that works for both.

## 2. Security is not negotiable

- Never execute code from a repository or a skill. Never run `npx`, scripts or MCP servers.
- New files: `safeJoin` for any untrusted path, written with flag `wx` and mode `0o644` (`NEW_FILE` in `core/safeWrite.ts`). Never follow remote symlinks.
- Replacing a file: backup first, then temp file + rename (`replaceWithBackup` / `writeAtomically`). Restore the previous state if anything fails.
- Every write the user didn't type themselves goes behind a native **modal** that shows the exact file and change.
- GitHub tokens live only in memory and are only sent to GitHub hosts. Nothing sensitive reaches the webview: no absolute paths it doesn't need, no tokens, no MCP env/header values (names only).
- Respect Workspace Trust: no writes to project files in Restricted Mode.
- Files other tools own are read-only for us: `~/.claude.json` (use `claude mcp`), claude.ai synced folders, plugin folders, JSON files with comments.

## 3. Architecture

- `src/core` must not import `vscode`: everything there runs in plain Node and is unit-testable.
- `src/ui` is the extension host (modals, pickers, commands). `src/webview` is plain TypeScript + DOM — **no React, no Vite** — and inserts host values with `textContent`, never `innerHTML`.
- The webview and host talk through the typed messages in `src/shared/protocol.ts`.
- Zero runtime dependencies. esbuild builds `dist/extension.js` and `dist/webview.js`.

## 4. Readable code

- Descriptive names: no one-letter variables (`skill`, `location`, `error`, not `s`, `l`, `e`).
- Named constants instead of magic values: limits, regexes, repeated strings (`MAX_SKILL_MD_BYTES`, `SYNC_BUCKET_NAME`). Write invisible Unicode as `\u…` escapes.
- No dense one-liners: split long conditions into named booleans and long functions into small named helpers. Avoid nested ternaries and comma-operator handlers (`() => ((a = b), save(), render())`); use `changeView()` in the webview.
- Reuse what exists before writing it again: `safeWrite.ts`, `concurrency.ts`, `service.agentNames()`, `changeView()`.
- Comments explain *why*, never narrate *what* the next line does.

## 5. Tests

- Every new function gets unit tests. If it touches disk or network, also an integration test with `FakeGitHub` (`test/helpers/fakeGitHub.ts`) and temporary directories (`test/helpers/fsFixture.ts`).
- UI flows: a smoke test in `test/smoke/flows.test.mjs` (bundled extension, simulated `vscode`, modals answered) and webview checks in `test/smoke/webview.test.mjs` (jsdom).
- jsdom has no layout. For visual bugs (scroll, overflow), reproduce in real Chromium first (Playwright from a scratch folder), then add a jsdom test that emulates the browser behaviour and **fails without the fix**.
- Refactors must not change behaviour: besides the tests, compare the old build's output with the new one on real data (bundle `git archive HEAD` and the working tree with esbuild, run both, diff the JSON).

## 6. Finishing a block of work

Small, verifiable changes. At the end of each block:

1. `npm run typecheck && npm test && npm run test:smoke`
2. When it touches the host or the webview: `npm run test:e2e` (VS Code) and `node test/e2e/run.mjs /Applications/Cursor.app/Contents/MacOS/Cursor`
3. Update `CHANGELOG.md`, the roadmap and the status section (C.9) of `docs/ANALISIS.md`; README limitations if they changed.
4. Commit (never push unless asked). Don't commit `.agents/` or `.vscode/`.
5. Reinstall: `npm run package:offline`, then `code --install-extension ai-skills-manager-0.3.0.vsix --force` and the same with `cursor`.
6. **Always remind the user to reload the window** (Developer: Reload Window). A new webview talking to an old host caused "bugs" that weren't.

## 7. The final answer

Always separate three things:

- **Implementado** — what changed and where (link the files).
- **Probado** — what ran and passed: tests, e2e, checks on real data. Say plainly if something failed.
- **Pendiente** — what is left, what is only observed (⚠️), and what needs a manual check in the editor.

## Useful facts

- Skill locations per agent, plugins, monorepos and their verification dates: `src/core/providers/index.ts`, `src/core/plugins.ts`, `docs/ANALISIS.md` (C.8, C.9).
- claude.ai synced skills live one level deeper than documented: `~/.claude/skills/synced/<org>_<account>/<skill>/` (⚠️ observed). Only the signed-in account's folder is loaded.
- Re-rendering the webview replaces the DOM: elements with `data-scroll-key` keep their scroll; partial refills must save and restore `scrollTop` (Chromium resets it when a container is emptied).
