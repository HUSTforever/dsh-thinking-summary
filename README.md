# dsh-thinking-summary

English | [中文](README.zh.md)

[Source](https://github.com/HUSTforever/dsh-thinking-summary) · MIT · Node.js 22.19+ or 24+

Codex-style per-step reasoning summaries inside DeepSeek Harness's native thinking disclosure. A short action title replaces the raw preview; expanding shows 1–2 sentences and a switch to the original thinking. Answers, tools, images, grouping and disclosure behavior continue to use the native renderer.

Version 0.2 replaces the old end-of-turn card beneath the final answer. It updates during each model step and completes the final snapshot when the step settles. It summarizes high-level actions and findings without reproducing private deliberation or claiming planned actions have succeeded.

Version 0.3 packages the plugin as an installable DSH bundle: a release tarball and Git tag can be installed from the Plugins page or `dsh plugin`, without copying files into the profile. Summary behavior is unchanged from 0.2.

This approximates Codex's presentation. DeepSeek still requires an auxiliary model request, so latency and generation behavior differ from OpenAI's native reasoning-summary stream. See [reasoning summaries](https://developers.openai.com/api/docs/guides/reasoning) and [streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events).

## Behavior

- First live update after approximately 1.2 seconds, with at least 40 source characters; the host additionally enforces `minReasoningChars`.
- Further live updates require 8 seconds and 600 new characters. A settled step requests its final snapshot.
- Auxiliary calls are serialized per page and identical requests are coalesced.
- The summary is also rendered as a visible process card beneath the reasoning row, so the body is readable without expanding the disclosure; the disclosure keeps the short title and can still switch to the original thinking.
- Historical rows backfill automatically once they enter or approach the viewport; scrolling fills them lazily instead of starting a whole-session batch.
- Failed summaries can be retried. Original thinking remains accessible through the official reasoning body slot, including other body presentation plugins.
- Summaries follow the DSH locale by default. Open **Plugins → Installed plugins → dsh-thinking-summary** to choose the summary model; set the language to `auto` to follow DSH or enter a tag such as `zh`, `en`, or `zh-CN`. The prompt asks for Codex's `**action heading** + 1–2 sentences` format, grounded in the user request, tool activity/results, and answer rather than only the private trace.
- No session events or model-visible messages are modified. The browser creates display-only copies of reasoning blocks.
- Cache identity includes provider, model, locale and exact text; host cache also includes prompt version and output settings. Old retrospective summaries are not reused for the new format.

## Install

The plugin installs as a DSH bundle: its manifest points at `cordis.patch.yml`,
so the plugin manager downloads the package, adds it to the profile's bundle
list, and applies the defaults. No file copying and no manual profile edit are
required.

Tested with Harness desktop `0.2.1-rc.2`; the package declares
`engines.dsh: ">=0.2.1-rc.2"`.

### From the Plugins page (desktop and Web)

1. Open **Plugins** in the sidebar.
2. Choose **Add plugin**, then **Install a third-party plugin**.
3. Paste one of these specs:
   - Release tarball:
     `https://github.com/HUSTforever/dsh-thinking-summary/releases/download/v0.3.0/dsh-thinking-summary-0.3.0.tgz`
   - Git tag: `github:HUSTforever/dsh-thinking-summary#v0.3.0`
4. Install, then choose **Enable now** if the dialog offers it.
5. Open **Plugins → Installed plugins → dsh-thinking-summary** to pick the
   summary model and language.

The bundle supplies the defaults (`language: auto`, `thinking: off`,
`maxChars: 600`), so nothing needs to be added to the profile's
`cordis.patch.yml`.

### From the CLI (web, TUI and headless profiles)

```powershell
dsh plugin --profile <profile> add <spec>
```

Pass the same tarball URL or Git spec as above. The desktop profile is owned by
the desktop app, so install there through the Plugins page instead.

### Manual installation (development only)

To test local changes without installing the bundle, copy `package.json`,
`cordis.patch.yml`, `lib/` and the README/CHANGELOG/LICENSE files into:

```text
%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-thinking-summary
```

and add the insert entry from [cordis.patch.yml](cordis.patch.yml) to the
profile's `cordis.patch.yml`. Do not do this on a profile where the bundle is
already installed — the entry would be inserted twice.

### Updating

Third-party bundles upgrade by removing the installed copy and installing the
newer spec; the Plugins page offers this as uninstall followed by install. Tags
give every release a stable spec, for example
`github:HUSTforever/dsh-thinking-summary#v0.3.0`.

Profile configuration can reload live. After replacing already-imported
JavaScript, refresh the page (and restart Harness if the host half changed) to
load both halves. The local port may change; check
`/dsh-thinking-summary/health` on the current port.

## Plugin settings

Open **Plugins → Installed plugins → dsh-thinking-summary**, then use the **Thinking summary** section on the plugin's detail page to choose the summary provider/model (or follow the conversation route) and the language (`auto` follows DSH; `zh`, `en`, `zh-CN`, etc. override it). Settings are saved to `~/.dsh/thinking-summary/settings.json` and apply immediately.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `provider`, `model` | empty | Use the route recorded for the step; configure both as a host fallback if needed. |
| `language` | `auto` | Follow the DSH locale; overridable in the plugin settings. |
| `thinking` | `off` | Disable thinking for the auxiliary request, falling back if unsupported. |
| `maxChars` | `600` | Combined title/body character budget. |
| `maxOutputTokens` | `220` | Auxiliary output token cap. |
| `minReasoningChars` | `120` | Shorter sources skip generation. |
| `maxInputChars` | `24000` | Keep the head and tail of longer inputs. |
| `timeoutMs` | `45000` | Per-generation deadline. |
| `cacheSize` | `400` | Host cache entries; `0` disables caching. |

Durable cache: `~/.dsh/thinking-summary/cache.json`; plugin settings: `~/.dsh/thinking-summary/settings.json`. Clearing the cache does not alter sessions.

## Version management

`package.json` is the single source of the version; the health route reads it when the host half loads, so a release bump never edits two places. Work lands on `main`, and every release is a semver tag:

```powershell
npm version patch --message "release: v%s"   # or minor / major
git push --follow-tags
```

`npm version` updates `package.json`, commits and creates the annotated `vX.Y.Z` tag. Push it with `git push --follow-tags`; the Release workflow then runs the checks, packs `dsh-thinking-summary-X.Y.Z.tgz` and creates the GitHub release with that tarball attached. Every release is installable from its asset URL or its Git tag. CI runs `npm run check` and `npm test` on every push and pull request.

## Development

No build step or dependencies are required. The browser bundle only imports the baseline `react` module and receives Harness services through the plugin context.

```powershell
npm test
npm run check
```