"""Asking a debrid provider to FETCH a release it does not already hold.

Upstream only ever downloads what a provider has already cached: a stream with
no container is skipped, and once every service has skipped it, blacklisted.
For well-seeded mainstream media that is almost always fine -- something in the
candidate list is usually cached already.

It is not fine for a library whose releases are rarely in anyone's cache. There
the item scrapes successfully, every candidate is uncached, all of them get
blacklisted, and the item sits at Scraped forever with nothing in the log
saying why.

WHAT THIS DOES. When `download_uncached` is on and a run finds nothing cached,
it asks the provider to start fetching the best candidate and reschedules the
item. Providers cache asynchronously, so the next run simply finds it cached
through the ordinary `get_instant_availability` path and downloads it with no
special handling -- which is why there is no progress-tracking or second
download path here.

OFF BY DEFAULT, and every call site is guarded. With the setting off, nothing
in this module runs and the downloader behaves exactly as upstream does.

State is kept in memory rather than on the MediaItem on purpose: persisting it
would mean a schema migration, and the cost of losing it on restart is one
redundant `add_torrent` for a hash the provider is already fetching, which
every provider treats as a no-op.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from loguru import logger

from program.settings import settings_manager


class UncachedRequests:
    """Tracks which items have been asked for, and for how long."""

    def __init__(self) -> None:
        # item id -> (infohash, when it was first requested)
        self._requested: dict[int, tuple[str, datetime]] = {}

    # -- settings ----------------------------------------------------------

    @property
    def _settings(self):
        return settings_manager.settings.downloaders

    def enabled(self) -> bool:
        """Whether to ask providers to fetch uncached releases at all."""

        return bool(getattr(self._settings, "download_uncached", False))

    def _poll_interval(self) -> timedelta:
        minutes = getattr(self._settings, "uncached_poll_minutes", 10) or 10
        return timedelta(minutes=max(1, int(minutes)))

    def _max_wait(self) -> timedelta:
        hours = getattr(self._settings, "uncached_max_wait_hours", 24) or 24
        return timedelta(hours=max(1, int(hours)))

    # -- lifecycle ---------------------------------------------------------

    def give_up_deadline_passed(self, item_id: int | None) -> bool:
        """Whether this item has been waiting longer than the configured limit.

        Without a deadline a permanently dead release -- no seeders, so the
        provider can never finish -- would reschedule forever, holding a slot
        and never surfacing as a failure.
        """

        if item_id is None:
            return False

        record = self._requested.get(item_id)

        if record is None:
            return False

        return datetime.now() - record[1] > self._max_wait()

    def forget(self, item_id: int | None) -> None:
        if item_id is not None:
            self._requested.pop(item_id, None)

    def request(self, item, streams, services) -> datetime | None:
        """Ask a provider to fetch the best uncached candidate.

        Returns when to look again, or None if nothing could be requested --
        in which case the caller should fall through to its normal
        "nothing downloaded" handling rather than rescheduling.
        """

        if not self.enabled() or not streams or not services:
            return None

        item_id = getattr(item, "id", None)

        if self.give_up_deadline_passed(item_id):
            logger.warning(
                f"Gave up waiting for an uncached release of {item.log_string}: "
                f"nothing cached after {self._max_wait()}"
            )
            self.forget(item_id)
            return None

        stream = streams[0]

        for service in services:
            try:
                service.add_torrent(stream.infohash)
            except Exception as exc:
                logger.debug(
                    f"{service.key} would not accept uncached {stream.infohash} "
                    f"for {item.log_string}: {exc}"
                )
                continue

            first_seen = self._requested.get(item_id, (None, datetime.now()))[1] if item_id is not None else datetime.now()

            if item_id is not None:
                self._requested[item_id] = (stream.infohash, first_seen)

            run_at = datetime.now() + self._poll_interval()

            logger.log(
                "DEBRID",
                f"Asked {service.key} to fetch uncached '{stream.raw_title}' "
                f"for {item.log_string}; re-checking at {run_at.strftime('%H:%M:%S')}",
            )

            return run_at

        return None


uncached_requests = UncachedRequests()
