# AI Skills Manager

**See which AI agent actually loads each Agent Skill, catch duplicates and broken skills, and install skills from GitHub with a security review.** Works in VS Code and compatible editors such as Cursor.

Claude Code, Cursor, Codex and GitHub Copilot read skills (`SKILL.md`) from overlapping folders, but no single folder reaches all four. This extension shows the whole picture in one place.

Screenshots are in `docs/images/`.

## What it does (v0.3)

- **Multi-agent inventory:** scans the global and workspace folders that each agent reads according to its official documentation, plus any extra folders you configure.
  - **Monorepos:** also scans parent folders up to the repository root (Claude Code, Codex) and nested skills folders (Claude Code, Cursor).
  - Includes skills synced from claude.ai (`~/.claude/skills/synced`, read-only).
- **Visibility matrix:** which agent loads which folder, and therefore each skill.
- **Map tab:** a skill × agent coverage table that says why an agent can't use a skill and copies it to the folder that closes the gap, plus an interactive agent → folder → skill diagram.
- **Knows your setup:** recognizes whether it runs in Cursor or VS Code and highlights that editor's agent. It also detects which of the four agents are installed (from files only: CLI on PATH, app, config file or editor extension; nothing is executed) and hides the ones it can't find, with a toggle to show all.
- **Diagnostics:**
  - duplicate names that one agent sees in two different folders;
  - frontmatter that breaks the [agentskills.io](https://agentskills.io/specification) spec (`name` ≠ folder name, missing `description`, length limits);
  - `skill.md` with the wrong casing;
  - broken symlinks;
  - folders without a `SKILL.md`.
- **Merge suggestions for duplicates:** when the same skill sits in several folders of the same scope, it suggests the smallest set of copies that still reaches every installed agent. *Merge* moves the redundant copies to the backup folder, *Use this version* makes differing copies identical, and *Compare* opens a file-by-file diff.
- **One-click fixes:** *Fix…* next to each fixable problem (or *Fix all*): set `name` to the folder name or rename the folder, add a missing `name`/`description`/frontmatter, rename `skill.md` to `SKILL.md`, remove a broken link. The exact change is shown first, SKILL.md edits are minimal one-line edits, and a backup is kept.
- **Install from GitHub** (repository, folder, `…/blob/…/SKILL.md` or `owner/repo`):
  1. Analyzes the repository and rejects anything that isn't a skill, with a hint when it looks like a plugin or an MCP server.
  2. Lets you choose which skills to install.
  3. Downloads the **exact commit** to a staging area and reviews all of its content.
  4. Shows which agents will see the skill in the destination you pick.
  5. Asks for confirmation before writing anything.
- **Safe uninstall:** the folder is moved to a recoverable backup. If it's a symlink, only the link is removed.
- **Provenance:** records the repository, ref, commit and tree SHA of everything it installs. It also reads the provenance that `gh skill install` writes into `SKILL.md`.
- **Updates:** *Check for Updates* compares the installed tree SHA with the remote one (2 API calls per repository and branch). *Update…* first shows the added, modified and removed files, your local edits and the security review, then replaces the folder and keeps a backup.
- **Add to project:** one click copies a global skill into the open project's skills folder that reaches the most installed agents.
- **Copy or move** between folders (global ↔ workspace, `.claude/skills` ↔ `.agents/skills`): before writing, shows which agents gain and lose the skill.
- Side bar, dashboard, light/dark/high-contrast themes, Workspace Trust.

## Security model

- **Never executes** anything from a repository. Files are written **without execute permission**.
- Automatic (heuristic) review of every file:
  - invisible or bidirectional Unicode;
  - text that tries to override the agent's instructions;
  - `curl … | sh` and `base64 -d | sh`;
  - sending variables such as `*_TOKEN` elsewhere;
  - credential paths (`~/.ssh`, `~/.aws`);
  - binaries, scripts and hidden HTML comments.

  High-risk findings require a **second confirmation**. *Heuristics don't guarantee safety: only install from sources you trust.*
- Path-traversal protection (absolute paths, `..`, names that are invalid on Windows). Symlinks and submodules in the repository are skipped.
- Never overwrites without consent. Anything replaced goes to a backup, and a failure triggers an automatic rollback.
- The GitHub token (optional, from the editor's sign-in) lives only in memory, is sent only to `api.github.com` and `raw.githubusercontent.com`, and never reaches the webview.
- In **Restricted Mode**, workspace folders are read-only.
- The webview uses a strict CSP (no `unsafe-inline`), and all content is inserted as text.

## Usage

- **AI Skills** icon in the activity bar → tree by scope (Workspace / Global / Admin) → folder → skill. Click a skill to see its details; right-click for Open, Reveal, Copy Path, Copy or Move to…, Update… and Remove.
- Side bar buttons: **Open Dashboard**, **Install from GitHub…**, **Refresh**.
- Command palette: `AI Skills: …`

### Settings

| Setting | Purpose |
|---|---|
| `skillsManager.providers` | Agents to scan (remove the ones you don't use) |
| `skillsManager.extraLocations` | Extra folders, e.g. `{ "path": "~/.codeium/windsurf/skills", "readers": ["windsurf"] }` |
| `skillsManager.showEmptyLocations` | Show existing folders that contain no skills |
| `skillsManager.scanParentFolders` | Parent folders up to the repository root (default: on) |
| `skillsManager.scanNestedFolders` | Skills folders nested inside the workspace (default: on; max depth 6, skips `node_modules` and build folders) |
| `skillsManager.checkForUpdatesOnStartup` | Check for updates on startup, at most every 12 hours (default: off) |

## Development

Requirements: Node 18+ and VS Code 1.90+.

```bash
npm install
npm run build        # esbuild → dist/
npm test             # 57 unit + integration tests (Node test runner, simulated GitHub)
npm run test:smoke   # loads dist/extension.js against a simulated vscode API
npm run test:e2e     # runs the extension inside real VS Code (temporary profile, local proxy, real GitHub)
node test/e2e/run.mjs /Applications/Cursor.app/Contents/MacOS/Cursor   # same, in Cursor
npm run typecheck    # tsc with @types/vscode
```

### Run in VS Code

1. Open this folder in VS Code.
2. Press **F5** (*Run Extension*) to open an *Extension Development Host* window with the extension loaded. *Run Extension (clean profile)* starts it without your other extensions.
3. To see some data, create a test skill:
   ```bash
   mkdir -p ~/.agents/skills/hello && printf -- '---\nname: hello\ndescription: Says hello. Use it for testing.\n---\nSay hello.\n' > ~/.agents/skills/hello/SKILL.md
   ```
4. Try a real install with `https://github.com/anthropics/skills`.

### Build the VSIX

```bash
npm run build -- --production
npm run package             # official: @vscode/vsce → ai-skills-manager-0.3.0.vsix
# without npm/vsce access:
npm run package:offline     # dependency-free packager (scripts/package-vsix.mjs)
```

Install: `code --install-extension ai-skills-manager-0.3.0.vsix`, or **Extensions: Install from VSIX…** in the command palette.

Publishing to the Marketplace requires `vsce publish` with a real publisher (change `publisher` in `package.json`). For Open VSX (which Cursor uses): `npx ovsx publish ai-skills-manager-0.3.0.vsix -p <token>`.

### Test in Cursor

1. Install the VSIX: command palette → **Extensions: Install from VSIX…**, or `cursor --install-extension ai-skills-manager-0.3.0.vsix`.
2. Checklist:
   - [ ] The **AI Skills** icon appears in the side bar.
   - [ ] The matrix shows `~/.cursor/skills`, `~/.agents/skills`, `~/.claude/skills` and `~/.codex/skills` as read by Cursor.
   - [ ] Install a skill into `~/.cursor/skills` and check that it appears in **Cursor Settings → Rules & Skills** (or by typing `/` in the chat).
   - [x] Cursor 3.25.9 provides the `github` auth provider (verified with `test:e2e`). Without signing in, the extension keeps working (limit of 60 requests/hour).
   - [ ] Remove the skill and check that Cursor no longer sees it.

## Known limitations (v0.3)

- Doesn't show skills from plugins (Claude/Cursor), Claude Code's enterprise path, or skills contributed by VS Code extensions.
- Cursor walks each skills folder recursively (`skills/<group>/<skill>/SKILL.md`); this extension only reads the first level.
- GitHub only (no GitLab or Bitbucket). In huge repositories the file tree may come back truncated.
- The install, update, copy/move and uninstall dialogs have no automated test in the real editor (they need clicks): see *Pendiente de prueba manual* in `docs/ANALISIS.md`.
- The proxy was verified with `http.proxy` in VS Code 1.140 and Cursor 3.25.9 (based on VS Code 1.128). In older VS Code versions, `fetch` may not honor it.
- No enable/disable yet, and no management of MCP servers, agents or rules: see the roadmap in `docs/ANALISIS.md`.

Full market, product and architecture analysis (in Spanish): `docs/ANALISIS.md`.

## License

MIT. The dashboard bundles [Codicons](https://github.com/microsoft/vscode-codicons) (icon font © Microsoft, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)).
