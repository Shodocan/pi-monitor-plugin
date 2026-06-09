# Pi Skill + Package Authoring Research Report

Sources (all under `<pi-install>/node_modules/@earendil-works/pi-coding-agent/`):
`docs/skills.md`, `docs/packages.md`, `docs/settings.md`, `docs/extensions.md`, `examples/extensions/` (notify.ts, with-deps/, subagent/, file-trigger.ts, README.md).

---

## 1. Exact SKILL.md format

Pi implements the **Agent Skills standard** (agentskills.io), "warning about most violations but remaining lenient" (skills.md:7).

### Frontmatter fields (skills.md:137-149)

| Field | Required | Rules |
|-------|----------|-------|
| `name` | Yes | Max 64 chars; lowercase a-z, 0-9, hyphens; no leading/trailing/consecutive hyphens (skills.md:143, 151-157). Pi does NOT require name to match parent directory (deliberate deviation from the standard, skills.md:7, 143). |
| `description` | Yes | Max 1024 chars. "What the skill does and when to use it." (skills.md:144). **A skill with a missing description is not loaded at all** (skills.md:186). |
| `license` | No | License name or reference to bundled file (skills.md:145). |
| `compatibility` | No | Max 500 chars, environment requirements (skills.md:146). |
| `metadata` | No | Arbitrary key-value map (skills.md:147). |
| `allowed-tools` | No | Space-delimited pre-approved tools — **experimental** (skills.md:148). |
| `disable-model-invocation` | No | `true` hides skill from system prompt; only `/skill:name` invokes it (skills.md:149). |

Unknown frontmatter fields are ignored (skills.md:184). Name collisions warn and keep the first skill found (skills.md:188).

### Discovery rules (skills.md:24-41, packages.md:161)

- Global: `~/.pi/agent/skills/`, `~/.agents/skills/`; Project (after trust): `.pi/skills/`, `.agents/skills/` in cwd + ancestors; Packages: `skills/` dirs or `pi.skills` in package.json; Settings `skills` array; CLI `--skill <path>` (skills.md:26-34).
- **Directories containing `SKILL.md` are discovered recursively in all skill locations** (skills.md:38).
- Direct root `.md` files count as individual skills only in `~/.pi/agent/skills/` and `.pi/skills/` (skills.md:37); ignored in `.agents/skills/` (skills.md:39).
- In packages: "`skills/` recursively finds `SKILL.md` folders and loads top-level `.md` files as skills" (packages.md:161).

### How skills surface / load timing (skills.md:64-71) — progressive disclosure, NOT eager

1. At startup pi scans locations and extracts **names and descriptions only** (skills.md:66).
2. System prompt includes available skills in XML per the spec (skills.md:67).
3. When a task matches, the agent uses `read` to load the full SKILL.md on demand — "models don't always do this; use prompting or `/skill:name` to force it" (skills.md:68).
4. Agent follows instructions "using relative paths to reference scripts and assets" (skills.md:70).

Every skill also auto-registers as a `/skill:name` command (default on, `enableSkillCommands: true`, skills.md:75-90, settings.md:218); arguments are appended as `User: <args>` (skills.md:82).

No built-in skills ship in the package: `dist/core/skills` does not exist and no `SKILL.md` files exist in the install tree.

## 2. Skill-authoring best practices

- **Description is the trigger.** "The description determines when the agent loads the skill. Be specific." (skills.md:164). Good example given: `Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.` Poor: `Helps with PDFs.` (skills.md:166-174). Pattern: capabilities sentence + explicit "Use when ..." clause. Hard cap 1024 chars.
- **Supporting files are first-class — yes, ship the watcher script next to SKILL.md.** "A skill is a directory with a `SKILL.md` file. Everything else is freeform." with suggested `scripts/`, `references/`, `assets/` subdirs (skills.md:92-105). The canonical example is exactly our shape — executable scripts the agent invokes: `brave-search/` with `search.js` and `content.js`, invoked as `./search.js "query"` (skills.md:190-226). Reference files with relative links: `See [the reference guide](references/REFERENCE.md)` (skills.md:131-135).
- **Document Setup vs Usage sections** with copy-pasteable bash blocks (skills.md:109-129) — e.g. a one-time `npm install` setup step, then usage commands.
- Length guidance is implicit in the design: only the description lives in context permanently (skills.md:71), so keep SKILL.md instructions focused and push detail to `references/` loaded on demand.
- Security note worth echoing in our README: "Skills can instruct the model to perform any action and may include executable code the model invokes." (skills.md:22).

## 3. Package layout recommendation

**Recommendation: use both — convention directories (`extensions/`, `skills/`) AND an explicit `pi` manifest.** Convention dirs alone work ("If no `pi` manifest is present, pi auto-discovers resources from these directories: `extensions/` loads `.ts` and `.js` files; `skills/` recursively finds `SKILL.md` folders", packages.md:158-163), but the explicit manifest (packages.md:116-131) is self-documenting, glob-filterable, and is what the docs' own "Creating a Pi Package" example shows. Keeping the directory names conventional means the manifest is redundant-but-harmless and the repo stays legible either way.

### package.json

```json
{
  "name": "@YOUR_SCOPE/pi-background-jobs",
  "version": "0.1.0",
  "description": "Background/monitor/loop/scheduled jobs for pi with external notifications, plus a skill for watching GitHub PRs.",
  "type": "module",
  "keywords": ["pi-package", "pi", "background-jobs", "notifications", "github"],
  "files": ["extensions", "skills", "src", "README.md", "LICENSE"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  },
  "dependencies": {}
}
```

- `pi-package` keyword: "Include the `pi-package` keyword for discoverability." (packages.md:116) and it gates the gallery (packages.md:135).
- **peerDependencies — verbatim from packages.md:169:** "Pi bundles core packages for extensions and skills. If you import any of these, list them in `peerDependencies` with a `\"*\"` range and do not bundle them: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`." Only list the ones actually imported (likely `@earendil-works/pi-coding-agent` + `typebox` for tool schemas; add `@earendil-works/pi-tui` if doing custom rendering).
- Real third-party runtime deps go in `dependencies` — pi runs `npm install` (production, `--omit=dev`) on install (packages.md:167, extensions.md:149), so `devDependencies` are NOT available at runtime.
- `files` array is standard npm tarball hygiene (not pi-specific; packages.md doesn't mention it) — include `src/` since extensions ship as uncompiled TypeScript loaded by jiti (extensions.md:178).
- Manifest paths are relative to package root; arrays support globs and `!exclusions` (packages.md:131).

### Directory tree

```
pi-background-jobs/
├── package.json
├── README.md
├── LICENSE
├── extensions/
│   └── background-jobs.ts        # entry: registers tools/commands; imports from ../src
├── src/
│   ├── jobs.ts                   # job runner (background/monitor/loop/schedule)
│   └── notify.ts                 # external notification transports
└── skills/
    └── github-pr-watch/
        ├── SKILL.md
        ├── scripts/
        │   └── watch-prs.sh      # gh-based PR poller the agent invokes
        └── references/
            └── job-types.md      # optional deep docs, loaded on demand
```

Header-comment idiom (from examples/extensions/notify.ts:1-9, subagent/index.ts:1-13, file-trigger.ts:1-9): a top-of-file JSDoc block with extension name, one-paragraph behavior summary, and a `Usage:` / supported-modes section. Style: `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"`, default-export factory `export default function (pi: ExtensionAPI) { ... }`, `Type.Object(...)` from `typebox` for tool params (with-deps/index.ts:8-31).

## 4. Install/update UX

- `pi install npm:@scope/pkg` or `pi install npm:@scope/pkg@1.0.0`; also `git:github.com/user/repo@v1`, raw URLs, and local paths (packages.md:22-27). Writes to user settings `~/.pi/agent/settings.json` by default; user npm installs land in `~/.pi/agent/npm/` (packages.md:41, 63).
- **Trial without installing:** `pi -e npm:@scope/pkg` "installs to a temporary directory for the current run only" (packages.md:43-48).
- **Project-local:** `pi install -l npm:@scope/pkg` writes to `.pi/settings.json` (installs under `.pi/npm/`); "Project settings can be shared with your team, and pi installs any missing packages automatically on startup after the project is trusted." (packages.md:41, 64). Trust flow per settings.md:14: trusting a project allows loading `.pi/settings.json`, installing missing project packages, and executing project extensions.
- **Updates:** `pi update` updates pi + packages; `pi update --extensions` packages only; `pi update npm:@foo/bar` one package (packages.md:31-36). **Pinned versions are skipped:** "Versioned specs are pinned and skipped by package updates" (packages.md:61); git refs likewise pinned, only reconciled, move them with `pi install git:...@new-ref` (packages.md:88-89). So advise users to install unversioned (`npm:@scope/pkg`) to ride `pi update`.
- Users can filter resources per package in settings (object form with `extensions`/`skills` arrays, packages.md:188-214) and toggle via `pi config` (packages.md:218). Project entry wins over global for the same package; npm identity = package name (packages.md:220-227).

## 5. Gallery (pi.dev/packages)

"The package gallery displays packages tagged with `pi-package`." — the keyword alone is sufficient to be listed (packages.md:135). Optional preview via `pi.video` (MP4 only; autoplays on hover, click for fullscreen) and/or `pi.image` (PNG/JPEG/GIF/WebP static preview); video takes precedence if both set (packages.md:135-152). Recommended: add an `image` (screenshot of a notification firing) or short MP4 demo of the PR-watch flow.

## 6. Extension import constraints

- **TypeScript, no build step:** "Extensions are loaded via jiti, so TypeScript works without compilation." (extensions.md:178).
- **Relative imports within the package: yes**, including explicit `.ts` extensions — the shipped subagent example does `import { ... } from "./agents.ts"` (examples/extensions/subagent/index.ts:25). So `extensions/background-jobs.ts` importing from `../src/jobs.ts` is idiomatic; the docs' own multi-file layout shows `src/index.ts` as entry with a manifest pointing at it (extensions.md:240-264).
- **node_modules deps: yes.** "npm dependencies work too. Add a `package.json` next to your extension (or in a parent directory), run `npm install`, and imports from `node_modules/` are resolved automatically." (extensions.md:147). For distributed packages, pi runs `npm install --omit=dev` on install, so runtime deps must be in `dependencies`, not `devDependencies` (extensions.md:149; packages.md:167).
- **Pi core packages must be peerDeps, never bundled** (packages.md:169, quoted above). Importable surface: `@earendil-works/pi-coding-agent`, `typebox`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, plus Node built-ins (extensions.md:140-151).
- **Other pi packages as deps:** must be in `dependencies` + `bundledDependencies` and referenced via `node_modules/` paths in the manifest; "Pi loads packages with separate module roots, so separate installs do not collide or share modules." (packages.md:171-186).
- Useful prior art for our feature set: `examples/extensions/notify.ts` (terminal OSC notifications), `examples/extensions/file-trigger.ts` (fs.watch + `pi.sendMessage(..., { triggerTurn: true })` to inject external events into the session — exactly the mechanism for "notify the session about a new PR").
