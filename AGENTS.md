# riven-jellyfin — agent notes

Upstream `rivenmedia/riven` with TorBox support (and a couple of fixes it
needs to actually play) added as a **patch**, built from each upstream release.
`README.md` explains why. This file is about working on it.

Several Claude Code sessions work across these repos at once. Before changing
anything: `git log --oneline -10`.

## There is no fork here

`patch/apply.mjs` plus `patch/files/`. Nothing in this repo is a copy of
upstream, and that is deliberate — a fork would have to be re-merged by hand
on every release, forever.

Two consequences worth internalising before editing:

- **Every edit is anchored to text that must already exist upstream, and a
  missing anchor is a hard failure.** Never relax an anchor into a silent skip.
  An image whose TorBox patch quietly did not apply reproduces exactly the bug
  this repo exists to fix: Riven indexes and scrapes normally and then never
  downloads anything, with no error to show for it.
- **The patch must stay idempotent.** CI applies it to several refs, and
  applying twice has to be a no-op. When adding an edit, add its
  already-applied guard at the same time, and key that guard on what the edit
  *inserts* — a guard matching something upstream already contains passes on a
  wholly unpatched checkout.

Run it by hand against a checkout: `node patch/apply.mjs ../riven-upstream`.

## Testing and CI

- `python3 test/test_uncached.py` — runs against the patch's own module with
  upstream stubbed, so it needs no checkout. It covers the thing a diff cannot
  show by eye: that the uncached-fetch feature is genuinely inert when off.
- `verify-patch.yml` applies the patch to both the current release and
  upstream's default branch, on every push and nightly. **This is the early
  warning** for upstream moving an anchor — it fails here days before it would
  fail on build day.
- `build-upstream-releases.yml` polls for new upstream tags at 06:00 and
  publishes `ghcr.io/gauravsuman007/riven-jellyfin:<tag>` and `:latest`.
  Editing anything under `patch/` also triggers a build.
- **CI follows upstream *tags*, not its latest release.** Upstream's newest
  release could not be built at all; that is why. Do not "fix" this back.

## Deployment

Deployed as the container `riven` (not `riven-tpdb` — a different app entirely,
in a different stack):

    ssh 192.168.2.100 'cd /home/hellonfire/Server/riven && \
      docker compose pull riven riven-frontend && \
      docker compose up -d riven riven-frontend'

Its frontend is `riven-frontend`, built from `riven-frontend-jellyfin`. Name
services explicitly: a bare `up -d` also recreates `riven-upstream-db`, which
an app deploy has no reason to touch.

The compose file lives only on the server (this repo ships a patch, not a
deployment). One thing in it is easy to lose on a rewrite:
`RIVEN_FILESYSTEM_CACHE_DIR=/riven/cache` with a matching `./cache` bind. The
default is `/dev/shm/riven-cache` — a tmpfs, so every cached chunk is resident
RAM charged to the container, measured at 491 MiB of `riven`'s 672 MiB, on a
host whose swap was fully consumed. It is also capped by `shm_size` at 1 GiB
while `cache_max_size_mb` is 10 GiB, so the cache believes it has ten times the
room it has. Pin the path from the environment rather than the UI, or the
setting and the mount can drift apart.

## Traps that have cost time

- **`UserInfo` must accept `"torbox"`.** Upstream types the provider as a
  pydantic `Literal` of its own three; without widening it the provider never
  initialises and the failure looks like a config problem.
- **A bare `assert` in upstream's download path blacklists every stream.**
  Scraping looks perfectly healthy and nothing ever downloads. If a fresh
  upstream release starts producing "nothing downloads", check for this first.
- **Provider links expire, and the stored URL is never refreshed.**
  `MediaEntry.url` is minted once at download time and kept forever. TorBox
  answers a spent link with **400**, not 404 or 410, so it does not look like
  an expiry at all — it surfaces as a 502 from the stream endpoint. Section 6
  of the patch routes `stream_file` through `playback_url.resolve(item_id)`
  with one retry on 4xx using `force=True`; the HLS call sites use
  `resolve(item_id, check=True).url`. A working file answers a ranged GET with
  **206**, so that is the check worth making.
- **The API key rides inside the TorBox media URL.** Redact exception text,
  not just the URL, or the key lands in the logs.
- **`resolve_media_item` expunges the item.** Mutating it after that commits
  nothing, silently.

## Related repos

`riven-frontend-jellyfin` (this one's frontend),
`jellyfin-client-multiplexer` (fronts it for the Jellyfin clients),
`riven-tpdb` / `riven-tpdb-frontend` (the separate adult-catalogue stack).
Each has its own `AGENTS.md`.
