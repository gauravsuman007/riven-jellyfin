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

const target = join(upstream, "src/program/services/downloaders/torbox.py");
mkdirSync(dirname(target), { recursive: true });
copyFileSync(join(here, "files/src/program/services/downloaders/torbox.py"), target);
console.log("  copied src/program/services/downloaders/torbox.py");

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
`
    );
});

// --- 3. register the downloader -------------------------------------------

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

console.log("\npatch applied.\n");
