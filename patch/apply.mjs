#!/usr/bin/env node
/**
 * Add TorBox support to a checkout of rivenmedia/riven.
 *
 *     node patch/apply.mjs [path-to-upstream-checkout]   (default: cwd)
 *
 * WHY THIS EXISTS. Upstream Riven ships exactly three debrid providers --
 * realdebrid, debridlink, alldebrid -- and TorBox is not among them. An
 * account that only has TorBox therefore has NO usable downloader: Riven
 * indexes and scrapes normally and then can never fetch anything. Worse, a
 * settings.json carrying a `torbox` block (from an older build, or written by
 * hand) is accepted and silently ignored, so the setup looks configured and
 * simply never downloads. Found exactly that way on a live install.
 *
 * DESIGN RULE: every edit is anchored to text that must already be present,
 * and a missing anchor is a hard failure. Publishing an image whose TorBox
 * support silently did not apply would reproduce the very bug this fixes.
 *
 * Idempotent: applying twice is a no-op.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Defaults to the current directory, matching how CI invokes this from
// inside the checkout. See riven-frontend-jellyfin for the same convention.
const upstream = resolve(process.argv[2] ?? process.cwd());

if (!existsSync(upstream)) {
    console.error(`no such checkout: ${upstream}`);
    process.exit(1);
}

function fail(message) {
    console.error(`\npatch/apply.mjs: ${message}\n`);
    console.error("Upstream's layout changed. Re-read the file and move the anchor;");
    console.error("do NOT relax this into a silent skip -- a quietly unapplied");
    console.error("TorBox patch is exactly the failure this repo exists to fix.\n");
    process.exit(1);
}

function edit(relative, describe, transform) {
    const path = join(upstream, relative);

    if (!existsSync(path)) fail(`expected ${relative} to exist in the checkout`);

    const before = readFileSync(path, "utf8");
    const after = transform(before, (m) => fail(`${relative}: ${m}`));

    if (after === null) {
        console.log(`  skipped ${relative} (already patched)`);
        return;
    }

    writeFileSync(path, after);
    console.log(`  patched ${relative} -- ${describe}`);
}

// --- 1. the provider itself ------------------------------------------------

for (const name of ["torbox.py", "uncached.py"]) {
    const target = join(upstream, "src/program/services/downloaders", name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(here, "files/src/program/services/downloaders", name), target);
    console.log(`  copied src/program/services/downloaders/${name}`);
}

// --- 2. settings -----------------------------------------------------------

edit("src/program/settings/models.py", "added TorBoxModel and the torbox field", (source, bad) => {
    if (source.includes("class TorBoxModel")) return null;

    const modelAnchor = "class DownloadersModel(Observable):";

    if (!source.includes(modelAnchor)) bad("could not find DownloadersModel");

    source = source.replace(
        modelAnchor,
        `class TorBoxModel(Observable):
    enabled: bool = Field(default=False, description="Enable TorBox")
    api_key: str = Field(default="", description="TorBox API key")


${modelAnchor}`
    );

    // Placed beside the other providers so the settings form groups it with
    // them; the frontend renders this section straight from the schema, so no
    // separate frontend change is needed for it to appear.
    const fieldAnchor = /(\n\s+all_debrid: AllDebridModel = Field\([\s\S]*?\n\s+\)\n)/;
    const match = source.match(fieldAnchor);

    if (!match) bad("could not find the all_debrid field on DownloadersModel");

    return source.replace(
        match[1],
        `${match[1]}    torbox: TorBoxModel = Field(
        default_factory=lambda: TorBoxModel(), description="TorBox configuration"
    )
    download_uncached: bool = Field(
        default=False,
        description=(
            "Ask the debrid provider to fetch a release it has not cached, "
            "instead of skipping it. Off by default: it holds an item open "
            "across several runs and is only worth it for content that is "
            "rarely cached."
        ),
    )
    uncached_poll_minutes: int = Field(
        default=10, ge=1, description="How long to wait before re-checking an uncached request"
    )
    uncached_max_wait_hours: int = Field(
        default=24, ge=1, description="How long to keep waiting before giving up on an uncached release"
    )
`
    );
});

// --- 3. let UserInfo name TorBox ------------------------------------------

edit("src/program/services/downloaders/models.py", 'added "torbox" to the UserInfo service literal', (source, bad) => {
    if (source.includes('"alldebrid", "torbox"')) return null;

    /*
        A RUNTIME failure, invisible to any static check.

        `UserInfo.service` is a pydantic Literal of the three providers
        upstream ships. TorBox returning "torbox" fails validation, so
        get_user_info raises, _validate_premium fails, the provider never
        initialises, and Riven reports "No Downloader service initialized" --
        with the real cause buried in a pydantic error several lines earlier.

        Found only by deploying: py_compile and an import check both pass,
        because the literal is only enforced when a UserInfo is constructed.
    */
    const anchor = 'service: Literal["realdebrid", "debridlink", "alldebrid"]';

    if (!source.includes(anchor)) bad("could not find the UserInfo service literal");

    return source.replace(anchor, 'service: Literal["realdebrid", "debridlink", "alldebrid", "torbox"]');
});

// --- 4. register the downloader -------------------------------------------

edit("src/program/services/downloaders/__init__.py", "registered TorBoxDownloader", (source, bad) => {
    if (source.includes("TorBoxDownloader")) return null;

    const importAnchor = "from .alldebrid import AllDebridDownloader";

    if (!source.includes(importAnchor)) bad("could not find the AllDebridDownloader import");

    source = source.replace(importAnchor, `${importAnchor}\nfrom .torbox import TorBoxDownloader`);

    const registryAnchor = "AllDebridDownloader: AllDebridDownloader(),";

    if (!source.includes(registryAnchor)) bad("could not find the service registry entry for AllDebrid");

    return source.replace(
        registryAnchor,
        `${registryAnchor}\n            TorBoxDownloader: TorBoxDownloader(),`
    );
});

// --- 5. request uncached releases (opt-in) ---------------------------------

edit("src/program/services/downloaders/__init__.py", "wired the uncached-request path", (source, bad) => {
    if (source.includes("uncached_requests")) return null;

    /*
        EVERY insertion below is guarded on the setting, so with
        download_uncached off (the default) the loop executes exactly the
        instructions it did before. That is the whole contract of this edit:
        it adds a path, it does not alter one.
    */
    const importAnchor = "from .torbox import TorBoxDownloader";

    if (!source.includes(importAnchor)) bad("expected the TorBox import to be in place first");

    source = source.replace(importAnchor, `${importAnchor}\nfrom .uncached import uncached_requests`);

    // (a) Remember a stream the provider does not hold.
    const skipAnchor = `                        if not container:
                            logger.debug(
                                f"Stream {stream.infohash} not available on {service.key}"
                            )
                            continue`;

    if (!source.includes(skipAnchor)) bad("could not find the not-available skip");

    source = source.replace(
        skipAnchor,
        `                        if not container:
                            logger.debug(
                                f"Stream {stream.infohash} not available on {service.key}"
                            )

                            # Not cached is not the same as not usable, once
                            # the provider is allowed to go and fetch it.
                            if uncached_requests.enabled() and stream not in uncached_candidates:
                                uncached_candidates.append(stream)

                            continue`
    );

    // (b) Do not blacklist a stream we intend to ask for.
    const blacklistAnchor = `                        logger.debug(
                            f"Stream {stream.infohash} failed on all {len(available_services)} available service(s), blacklisting"
                        )
                        item.blacklist_stream(stream)`;

    if (!source.includes(blacklistAnchor)) bad("could not find the blacklist call");

    source = source.replace(
        blacklistAnchor,
        `                        # A merely-uncached stream must survive: blacklisting
                        # it here is exactly what leaves an item stuck at Scraped
                        # with every candidate discarded and nothing saying why.
                        if uncached_requests.enabled() and stream in uncached_candidates:
                            logger.debug(
                                f"Stream {stream.infohash} is uncached; keeping it as a fetch candidate"
                            )
                        else:
                            logger.debug(
                                f"Stream {stream.infohash} failed on all {len(available_services)} available service(s), blacklisting"
                            )
                            item.blacklist_stream(stream)`
    );

    // (c) Declare the accumulator next to the loop's other counters.
    const counterAnchor = "            tried_streams = 0\n\n            for stream in sorted_streams:";

    if (!source.includes(counterAnchor)) bad("could not find the tried_streams counter");

    source = source.replace(
        counterAnchor,
        `            tried_streams = 0
            # Streams no provider holds yet. Only ever populated when
            # download_uncached is on.
            uncached_candidates: list[Stream] = []

            for stream in sorted_streams:`
    );

    // (d) Ask for one, and come back later.
    const failAnchor = `                logger.debug(
                    f"Failed to download any streams for {item.log_string} ({item.id})"
                )`;

    if (!source.includes(failAnchor)) bad("could not find the failure log");

    return source.replace(
        failAnchor,
        `                # Nothing cached anywhere. Ask a provider to fetch the
                # best candidate and look again shortly; providers cache
                # asynchronously, so the next run finds it through the ordinary
                # availability check with no special handling.
                retry_at = uncached_requests.request(
                    item, uncached_candidates, available_services
                )

                if retry_at is not None:
                    yield RunnerResult(media_items=[item], run_at=retry_at)
                    return

                logger.debug(
                    f"Failed to download any streams for {item.log_string} ({item.id})"
                )`
    );
});

console.log("\npatch applied.\n");
