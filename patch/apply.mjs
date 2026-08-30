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

for (const relative of [
    "src/program/services/downloaders/torbox.py",
    "src/program/services/downloaders/uncached.py",
    // Not a TorBox file, but the same kind of gap: see section 6.
    "src/program/services/streaming/playback_url.py"
]) {
    const target = join(upstream, relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(here, "files", relative), target);
    console.log(`  copied ${relative}`);
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

// --- 6. restore the add-torrent fallback ----------------------------------

/** Inserted verbatim, and used as this edit's idempotency guard. */
const ADD_TORRENT_MARKER = "riven-jellyfin: no torrent id on the container";

edit("src/program/services/downloaders/__init__.py", "restored the missing add_torrent fallback", (source, bad) => {
    // Guarded on a marker inserted verbatim below. The previous guard used a
    // different capitalisation from the comment it was checking for, so it
    // never matched: the edit re-ran on an already-patched file, failed to
    // find its anchor, and took CI down as "upstream changed".
    if (source.includes(ADD_TORRENT_MARKER)) return null;

    /*
        UPSTREAM BUG, and it breaks downloading entirely -- for every
        provider, not just TorBox.

        `download_cached_stream_on_service` takes the torrent id from
        `container.torrent_id`, which its own docstring says is populated
        "otherwise adds the torrent and/or fetches its info from the service".
        That fallback does not exist in the file. And NO provider sets
        `torrent_id` on the container -- not realdebrid, alldebrid,
        debridlink or torbox -- so `torrent_id` is always None and the bare
        `assert torrent_id` below fires.

        A bare assert raises AssertionError with an EMPTY message, which the
        download loop catches and logs as "Stream <hash> failed on <service>: "
        with nothing after the colon. Every cached stream is then blacklisted,
        the item ends with zero usable streams, and it sits at Indexed forever
        while the log shows a successful scrape. Observed exactly that way:
        7 streams found for a film, 7 blacklisted, 0 attached.

        Adding the torrent is what yields an id, and is what the docstring
        describes.
    */
    const anchor = `        torrent_id = None

        # Check if we already have a torrent_id from validation (Real-Debrid optimization)
        if container.torrent_id:
            torrent_id = container.torrent_id

            logger.debug(
                f"Reusing torrent_id {torrent_id} from validation for {stream.infohash}"
            )

        assert torrent_id`;

    if (!source.includes(anchor)) bad("could not find the torrent_id assert block");

    const replacement = `        torrent_id = None

        # Check if we already have a torrent_id from validation (Real-Debrid optimization)
        if container.torrent_id:
            torrent_id = container.torrent_id

            logger.debug(
                f"Reusing torrent_id {torrent_id} from validation for {stream.infohash}"
            )
        else:
            # riven-jellyfin: no torrent id on the container, which is the
            # normal case -- no provider sets one. Add the torrent to obtain
            # it, as this method's own docstring describes. Without this the
            # bare assert below fires with an empty message and every cached
            # stream is blacklisted.
            torrent_id = service.add_torrent(stream.infohash)

            logger.debug(
                f"Added {stream.infohash} to {service.key} as torrent {torrent_id}"
            )

        assert torrent_id`;

    return source.replace(anchor, replacement);
});


// --- 6. refresh the provider link before streaming -------------------------

edit("src/routers/secure/stream.py", "re-mint a spent provider link instead of 502ing", (source, bad) => {
    if (source.includes("playback_url")) return null;

    /*
        THE BUG, reproduced on a live install: playing a title that had been
        sitting in the library for a few hours returned a flat 502, and the
        log said

            Failed to connect to upstream: Client error '400 Bad Request'
            for url 'https://<cdn>/dld/<id>?token=<token>'

        `MediaEntry.url` is `unrestricted_url or download_url` -- a CDN link
        minted once, at download time, and never refreshed. Debrid links
        expire; TorBox in particular answers a spent one with 400. RivenVFS
        refreshes as it reads (MediaStream._refresh_download_url), so the
        mounted file keeps working and only the HTTP endpoints break, which
        is why this presents as "the player is broken" rather than "the
        library is broken".

        The fix is one retry against a freshly minted URL, which is what the
        VFS has always done. See program/services/streaming/playback_url.py
        for why it does not reuse VFSDatabase.refresh_unrestricted_url: that
        one blacklists the item when unrestricting fails, so a provider
        hiccup during PLAYBACK would silently un-complete a downloaded title.
    */
    const importAnchor = "from program.services.streaming.media_stream import PROXY_REQUIRED_PROVIDERS";

    if (!source.includes(importAnchor)) bad("could not find the media_stream import");

    source = source.replace(
        importAnchor,
        `${importAnchor}\nfrom program.services.streaming import playback_url`
    );

    const bodyAnchor = `    url, provider, filename = _get_media_info(item_id)

    client = _get_client(provider)
    forward_headers = _build_forward_headers(request)

    upstream_response: httpx.Response | None = None
    try:
        req = client.build_request("GET", url, headers=forward_headers)

        try:
            upstream_response = await client.send(req, stream=True)
        except Exception as e:
            logger.error(f"Failed to connect to upstream: {e}")
            raise HTTPException(status_code=502, detail="Upstream connection failed")

        if upstream_response.status_code >= 400:
            await _handle_upstream_error(upstream_response)

        response_headers = _extract_response_headers(upstream_response, filename)`;

    if (!source.includes(bodyAnchor)) bad("could not find stream_file's upstream request");

    source = source.replace(
        bodyAnchor,
        `    media = playback_url.resolve(item_id)
    forward_headers = _build_forward_headers(request)

    upstream_response: httpx.Response | None = None
    try:
        for attempt in (0, 1):
            client = _get_client(media.provider)
            req = client.build_request("GET", media.url, headers=forward_headers)

            try:
                upstream_response = await client.send(req, stream=True)
            except httpx.HTTPStatusError as e:
                # AsyncClient raises on 4xx/5xx through an event hook rather
                # than returning the response, so a rejection arrives here and
                # never reaches the status check below.
                status_code = e.response.status_code
                await e.response.aclose()
                upstream_response = None

                if attempt == 0 and status_code < 500:
                    # 400/401/403/404/410 from a debrid CDN all mean the same
                    # thing in practice: this link is spent. Mint a new one.
                    logger.debug(
                        f"Upstream rejected the stored link for item {item_id} "
                        f"({status_code}); re-minting"
                    )
                    media = playback_url.resolve(item_id, force=True)
                    continue

                raise HTTPException(
                    status_code=502, detail=f"Upstream error: {status_code}"
                )
            except Exception as e:
                # The message can embed the provider URL, token and all.
                logger.error(
                    f"Failed to connect to upstream "
                    f"{playback_url.redact(media.url)}: {playback_url.redact(str(e))}"
                )
                raise HTTPException(status_code=502, detail="Upstream connection failed")

            if upstream_response.status_code >= 400:
                # The same case again, for a client configured without the
                # raising hook.
                status_code = upstream_response.status_code

                if attempt == 0 and status_code < 500:
                    await upstream_response.aclose()
                    upstream_response = None
                    media = playback_url.resolve(item_id, force=True)
                    continue

                await _handle_upstream_error(upstream_response)

            break

        assert upstream_response is not None

        response_headers = _extract_response_headers(upstream_response, media.filename)`
    );

    /*
        The rest of the function still refers to the old locals. Only two
        remain, both in the MIME-type guess and neither ambiguous.
    */
    const mimeAnchor = "        guessed_type, _ = mimetypes.guess_type(filename)";

    if (!source.includes(mimeAnchor)) bad("could not find the MIME-type guess");

    source = source.replace(mimeAnchor, "        guessed_type, _ = mimetypes.guess_type(media.filename)");

    /*
        The two HLS routes hand the URL to ffmpeg, which gets exactly one
        attempt and cannot come back and ask for a fresh link -- so those
        verify the stored URL up front (one ranged GET of a single byte)
        instead of retrying. A spent link surfaced there as "Transcoding
        failed" with no indication that the cause was an expired token.
    */
    for (const call of [
        "    url, _provider, _filename = _get_media_info(item_id)",
        "    url, _, _ = _get_media_info(item_id)"
    ]) {
        if (!source.includes(call)) bad(`could not find the HLS call site: ${call.trim()}`);

        source = source.replace(call, "    url = playback_url.resolve(item_id, check=True).url");
    }

    return source;
});


console.log("\npatch applied.\n");
