"""The uncached-request path, and above all that it is INERT when disabled.

The contract this repo makes is that turning download_uncached off leaves the
downloader behaving exactly as upstream does. That is not something a reader
can check by eye across a guarded diff, so it is asserted here.

Run without upstream present: `program.settings` is stubbed, because the module
under test only ever reads settings through it.

    python3 test/test_uncached.py
"""

import sys
import types
from datetime import datetime, timedelta
from pathlib import Path

# --- stub the two upstream modules uncached.py imports --------------------

settings_obj = types.SimpleNamespace(
    downloaders=types.SimpleNamespace(
        download_uncached=False,
        uncached_poll_minutes=10,
        uncached_max_wait_hours=24,
    )
)

program = types.ModuleType("program")
settings_mod = types.ModuleType("program.settings")
settings_mod.settings_manager = types.SimpleNamespace(settings=settings_obj)
sys.modules["program"] = program
sys.modules["program.settings"] = settings_mod

loguru = types.ModuleType("loguru")


class _Logger:
    def __getattr__(self, _name):
        return lambda *a, **k: None


loguru.logger = _Logger()
sys.modules["loguru"] = loguru

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "patch/files/src/program/services/downloaders"))
import uncached  # noqa: E402

PASS, FAIL = [], []


def check(name, ok):
    (PASS if ok else FAIL).append(name)
    print(f"{'PASS' if ok else 'FAIL'}  {name}")


class FakeService:
    key = "fake"

    def __init__(self, accept=True):
        self.accept = accept
        self.added = []

    def add_torrent(self, infohash):
        self.added.append(infohash)
        if not self.accept:
            raise RuntimeError("nope")
        return 1


class FakeStream:
    def __init__(self, h):
        self.infohash = h
        self.raw_title = "Some Release"


class FakeItem:
    id = 1
    log_string = "Some Item"


def reset(**kw):
    settings_obj.downloaders.download_uncached = kw.get("enabled", False)
    settings_obj.downloaders.uncached_poll_minutes = kw.get("poll", 10)
    settings_obj.downloaders.uncached_max_wait_hours = kw.get("max_wait", 24)
    return uncached.UncachedRequests()


# --- DISABLED: the path must not exist ------------------------------------

u = reset(enabled=False)
svc = FakeService()
check("disabled: enabled() is False", u.enabled() is False)
check("disabled: request() returns None", u.request(FakeItem(), [FakeStream("a" * 40)], [svc]) is None)
check("disabled: provider is never contacted", svc.added == [])

# --- ENABLED --------------------------------------------------------------

u = reset(enabled=True)
svc = FakeService()
run_at = u.request(FakeItem(), [FakeStream("b" * 40)], [svc])
check("enabled: returns a retry time", isinstance(run_at, datetime))
check("enabled: asked the provider to fetch it", svc.added == ["b" * 40])
check("enabled: retry is ~poll_minutes out", timedelta(minutes=9) < (run_at - datetime.now()) < timedelta(minutes=11))

# --- ENABLED but nothing to do -------------------------------------------

u = reset(enabled=True)
check("enabled: no candidates -> None", u.request(FakeItem(), [], [FakeService()]) is None)
check("enabled: no services -> None", u.request(FakeItem(), [FakeStream("c" * 40)], []) is None)

u = reset(enabled=True)
refuser = FakeService(accept=False)
check("enabled: provider refusing -> None (caller falls through)", u.request(FakeItem(), [FakeStream("d" * 40)], [refuser]) is None)

# --- the deadline ---------------------------------------------------------

u = reset(enabled=True, max_wait=24)
svc = FakeService()
u.request(FakeItem(), [FakeStream("e" * 40)], [svc])
check("deadline: not passed immediately", u.give_up_deadline_passed(1) is False)

# Backdate the first-seen time past the limit.
u._requested[1] = ("e" * 40, datetime.now() - timedelta(hours=25))
check("deadline: passed after max_wait", u.give_up_deadline_passed(1) is True)
check("deadline: giving up returns None so it stops rescheduling",
      u.request(FakeItem(), [FakeStream("e" * 40)], [FakeService()]) is None)
check("deadline: record cleared after giving up", 1 not in u._requested)

# --- re-requesting keeps the original deadline ----------------------------

u = reset(enabled=True)
svc = FakeService()
u.request(FakeItem(), [FakeStream("f" * 40)], [svc])
first = u._requested[1][1]
u.request(FakeItem(), [FakeStream("f" * 40)], [svc])
check("re-request does not reset the deadline clock", u._requested[1][1] == first)

print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)
