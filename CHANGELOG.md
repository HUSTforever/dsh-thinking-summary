# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-19

First release installable through the DSH plugin manager.

### Added

- DSH bundle metadata (`dsh.manifestVersion`, `engines.dsh`) so the Plugins
  page and `dsh plugin add` install and enable the package directly.
- Release workflow: every `v*` tag runs the checks, packs the npm tarball and
  attaches it to the GitHub release.
- `tests/manifest.mjs` guards the install contract: bundle patch, client
  export, shipped files and Node-only host imports.
- Install and update instructions for the Plugins page, the CLI, and manual
  development copies.

### Changed

- The README install section now leads with plugin-manager installation; the
  manual copy is documented as a development fallback.
- The package declares public npm access and its compatible DSH range.

### Unchanged

- Summary generation and presentation are the same as 0.2.0.

## [0.2.0] - 2026-10-19

Per-step progress summaries inside the native thinking disclosure, replacing
the end-of-turn card from 0.1.

### Added

- Codex-style short action title in the native thinking row, with the summary
  body shown as a visible process card and the original thinking one click away.
- Live updates while a step runs, throttled to roughly one request per 8
  seconds and 600 new characters, plus a final snapshot when the step settles.
- Lazy backfill for historical steps: rows are summarized as they approach the
  viewport instead of summarizing a whole session at once.
- Plugin settings page for the summary provider/model and language, persisted to
  `~/.dsh/thinking-summary/settings.json`.
- Durable content-addressed cache at `~/.dsh/thinking-summary/cache.json`,
  keyed by text, provider, model, locale, prompt version and output settings.
- Per-page request serialization, request coalescing and a rolling rate limit to
  bound auxiliary model calls.
- Structured model output with a plain-text fallback, retry on failure and
  graceful handling of providers that reject the `thinking: off` option.
- `npm test` smoke suite covering the host routes and the shipped browser bundle
  through a fake module loader.

### Changed

- Summaries now describe the current action and findings instead of restating
  the private trace, and follow the DSH locale by default.
- Nothing is written to session events or model-visible history; the browser
  decorates reasoning blocks with display-only state.

### Removed

- The extra end-of-turn summary card beneath the final answer.

## [0.1.0] - 2026-10-19

- Initial working version: one summary for the whole turn, rendered as an extra
  card below the final answer.
