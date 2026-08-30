# riven-jellyfin

[rivenmedia/riven](https://github.com/rivenmedia/riven) with **TorBox support**
added back, built as multi-arch images from each upstream release.

```
ghcr.io/<owner>/riven-jellyfin:<upstream-tag>
ghcr.io/<owner>/riven-jellyfin:latest
```

## Why this exists

Upstream Riven ships exactly three debrid providers — `realdebrid`,
`debridlink`, `alldebrid`. **TorBox is not among them.**

An account that only has TorBox therefore has *no usable downloader*: Riven
indexes and scrapes normally and can never fetch anything. The failure is
quiet, which is what makes it expensive — a `settings.json` carrying a
`torbox` block (from an older build, or written by hand) is **accepted and
silently ignored**, so the install looks fully configured and simply never
downloads. Found exactly that way on a live server whose `torbox` was
`enabled: true` with a valid key, while `real_debrid` and `all_debrid` sat
disabled and empty.

## What the patch does

Three edits, ten lines, plus one new file:

| File | Change |
| --- | --- |
| `services/downloaders/torbox.py` | the provider (new file) |
| `settings/models.py` | `TorBoxModel` + a `torbox` field on `DownloadersModel` |
| `services/downloaders/models.py` | `"torbox"` added to the `UserInfo.service` literal |
| `services/downloaders/__init__.py` | import and register `TorBoxDownloader` |

That third edit is the one that is easy to miss and impossible to catch
statically. `UserInfo.service` is a pydantic `Literal` of upstream's three
providers; TorBox returning `"torbox"` fails validation, so `get_user_info`
raises, `_validate_premium` fails, the provider never initialises, and Riven
reports **"No Downloader service initialized"** with the real cause buried in a
pydantic error several lines earlier. `py_compile` and an import check both
pass, because a `Literal` is only enforced when the model is constructed. CI
now asserts it explicitly.

Every edit is anchored to text that must already exist, and a missing anchor
**fails the build**. Publishing an image whose TorBox support silently did not
apply would reproduce the very bug this repo fixes.

### No frontend change is needed

Riven's settings page is fully schema-driven: it fetches
`/api/v1/settings/schema` from the backend and renders it with `sjsf`. Adding
`torbox` to `DownloadersModel` therefore makes it appear in the settings UI on
its own — and `getServiceDisplayName` in the frontend already maps `torbox` to
"TorBox", left over from when Riven shipped it. Verified in the frontend source
rather than assumed.

## Known limitation: cached content only

TorBox reports an uncached torrent as *queued*, which this provider raises as
`TorBoxQueued`. Upstream's downloader loop has no concept of waiting for a
provider to finish caching, so such a stream is treated as failed on TorBox and
the next candidate is tried.

That is the right behaviour for mainstream media, where cached is the common
case. It is **not** enough for libraries whose releases are rarely cached —
porting the wait-and-poll machinery means real surgery on upstream's downloader
loop, which an anchored patch cannot do safely. Tracked, not hidden.

## Maintenance

Upstream is never forked. Each build checks out an upstream tag, applies
`patch/apply.mjs`, and builds. `verify-patch.yml` runs daily against **both**
the current release and the default branch, so an upstream change that breaks
an anchor surfaces before it reaches a release. It also asserts the patch is
idempotent and that `torbox` is a real field on `DownloadersModel` — a class
sitting unreferenced in the file would leave the provider unconfigurable while
every other check passed.

## Related

- [`riven-frontend-jellyfin`](https://github.com/gauravsuman007/riven-frontend-jellyfin) — Jellyfin client integration for Riven's frontend
- [`stremio-jellyfin`](https://github.com/gauravsuman007/stremio-jellyfin) — the same integration for Stremio
