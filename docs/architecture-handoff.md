# Architecture handoff → implementation lead (Codex Sol)

Date: 2026-10-17. Orca parent task `task_4572bb183e60` / dispatch `ctx_96d4e7a09052`.

## Receipts (actual)
| Role | Agent / model | Orca ids | Outcome |
|---|---|---|---|
| Architecture lead | Claude Code, `claude-opus-5-5` (this session) | task_4572bb183e60, ctx_96d4e7a09052 | wrote `docs/ARCHITECTURE.md` and this file |
| Scaffold worker | Claude Code agent `claude`. Launched with `--model claude-sonnet-5-5`. Orca's worker projection records `provider.model: null`, so the model is *requested* rather than confirmed by Orca. | run_39f55765537a, task_57531ad54fcd, ctx_a5ba09f13ff3, term_bd09beee… | succeeded and settled. Terminal release was requested via `worker-release`. |
| Codex research sub-workers | none launched (optional; not needed) | — | — |

No live YouGile HTTP calls were made. The spec was not re-downloaded. Its local SHA-256 is `6b1424ac…a941`, which matches `research/raw/yougile-openapi-v2.provenance.txt`.

## Validation I performed on the scaffold
- `npm run check` (tsc --noEmit + eslint + vitest): **pass**, 3 tests.
- `npm run build`: **pass**. `YOUGILE_API_KEY=x node dist/index.js` starts on stdio and exits cleanly on stdin EOF.
- The layout matches ARCHITECTURE §4 (`src/http/*`, `src/tools/*` ×12, `src/format/project.ts`, `test/helpers/fakeFetch.ts`). Dependencies: `@modelcontextprotocol/sdk ^1.32.1` and `zod ^3.25.76`. The lockfile is present.
- ARCHITECTURE.md survived an accidental prettier run by the scaffolder, which restored it. `docs/` is now in `.prettierignore`.
- Post-review fixes, applied after root's review notes:
  - ARCHITECTURE: `WebhookFilters` is `{name, value: string[]}`; group chat `users` is `Record<id,{notified}>` with role maps; chat subscribers body is `{content: id[]}`; local `node dist/index.js` is the canonical launch; added the rule "spec wins over the catalogue".
  - README: removed the `npx` section, since the package is not published.

## Tasks for Sol (in order; details in `docs/IMPLEMENTATION.md`)
1. Preflight: re-hash the spec. **Cross-check every DTO in §6 against the saved OpenAPI**: checklists (`CheckList.items` is declared `allOf` a single item, so treat it as an array as in the example), sticker state id shapes, group chat roles, webhook filters, `UpdateDeadline` required `blockedPoints`/`links`. Where they differ, the spec wins, and you fix ARCHITECTURE.md in the same change.
2. Foundations: `config.ts`, `http/errors.ts`, `http/rateLimiter.ts`, `http/retry.ts`, `http/client.ts` (with paginate), `format/project.ts`, `tools/_shared.ts`, each with unit tests (§5, §8).
3. Tool groups (§6), in this order: users/company → projects/roles/departments → boards/columns → tasks → stickers → chats → webhooks. Gating per §7. The total must be exactly 66 (25 R / 29 W / 12 D).
4. Cross-cutting tests: gating sets, table-driven request assertions, a stdout-hygiene test.
5. Optional live check in a sandbox company (`npm run inspect`) for §10 risks 1–4. Until that is done, the `/companies` path, the ms timestamps, the error/429 shape and the claim that a task id works as a chat id stay **unverified**. Do not claim them as validated.

## Boundaries
- No generic HTTP tool and no endpoints outside the spec. The runtime never uses a password or `auth/*`.
- File upload is deferred (§6.10). Timer, stopwatch, deal, apiData and extensionData are not exposed.
- Ownership: Sol owns `src/**`, `test/**`, and IMPLEMENTATION.md checkboxes. ARCHITECTURE.md changes only to fix spec mismatches, and each fix must be noted in its commit message.
- Nothing has been committed yet: the repo has no commits. Root decides on the initial commit.
