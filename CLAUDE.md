# CLAUDE.md

Read **[AGENTS.md](AGENTS.md)** — it is the canonical agent guide for this repo (ground
rules, secret policy, verification commands). Then read **[PLAN.md](PLAN.md)** before
implementing anything: it holds the architecture, locked-in design decisions, and
milestones, backed by the research reports in [docs/research/](docs/research/).

Quick facts:

- This is a **pi package** (extension + skill) for the pi coding agent — background,
  monitor, loop, and schedule jobs with idle-aware session notifications.
- No build step: pi loads `extensions/*.ts` directly via jiti. `npm run typecheck` and
  `npm test` must stay green.
- Tool schemas are TypeBox (not zod). Pi-bundled packages are `peerDependencies: "*"`.
- Public repo and future public npm package: **no secrets, no personal endpoints, no
  private org/repo names anywhere**, including docs and test fixtures.
