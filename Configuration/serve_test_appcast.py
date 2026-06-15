#!/usr/bin/env python3
"""Preview the Sparkle update window against a local appcast.

The shipping app is always at the latest version, so Sparkle never shows an
update dialog in a normal run. This script generates a *test* appcast whose top
item is bumped to a high version (so a debug build sees it as an available
update) while keeping the embedded release notes, then serves it over
http://localhost so a debug build can fetch it.

Pair it with the DEBUG-only feed override in UpdaterService.swift, which points
Sparkle at http://localhost:8000/appcast-test.xml (override via the
X3FUSE_TEST_FEED_URL environment variable). The bundled Info.plist allows the
loopback http feed via NSAllowsLocalNetworking.

Usage (from the repo root):
    python3 Configuration/serve_test_appcast.py
    # then run a Debug build of X3Fuse and choose "Check for Updates"

    python3 Configuration/serve_test_appcast.py --version 99.0.0 --port 8000

Note: the generated docs/Support/appcast-test.xml is gitignored. If you click
"Skip This Version" while testing, Sparkle remembers it; re-run with a higher
--version (or clear the app's SUSkippedVersion default) to see the dialog again.
"""

import argparse
import functools
import http.server
import re
from pathlib import Path

SUPPORT_DIR = Path("docs/Support")
SOURCE = SUPPORT_DIR / "appcast.xml"
TEST = SUPPORT_DIR / "appcast-test.xml"


def make_test_appcast(version, build):
    """Clone the newest item, bumping its version so it reads as an update."""
    xml = SOURCE.read_text(encoding="utf-8")
    first = re.search(r"<item>.*?</item>", xml, flags=re.S)
    if not first:
        raise SystemExit(
            "no <item> found in %s; run inject_release_notes.py first" % SOURCE
        )
    item = first.group(0)
    item = re.sub(
        r"<title>[^<]*</title>",
        "<title>%s (local test)</title>" % version,
        item,
        count=1,
    )
    item = re.sub(
        r"<sparkle:shortVersionString>[^<]*</sparkle:shortVersionString>",
        "<sparkle:shortVersionString>%s</sparkle:shortVersionString>" % version,
        item,
        count=1,
    )
    item = re.sub(
        r"<sparkle:version>[^<]*</sparkle:version>",
        "<sparkle:version>%s</sparkle:version>" % build,
        item,
        count=1,
    )
    result = xml[: first.start()] + item + xml[first.end():]
    TEST.write_text(result, encoding="utf-8")
    print("wrote %s (top item -> v%s, build %s)" % (TEST, version, build))


def serve(port):
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=str(SUPPORT_DIR)
    )
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        url = "http://localhost:%d/%s" % (port, TEST.name)
        print("serving %s at %s" % (SUPPORT_DIR, url))
        print("Run a Debug build of X3Fuse and choose 'Check for Updates'.")
        print("Press Ctrl-C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--version", default="99.0.0", help="shortVersionString for the test item"
    )
    parser.add_argument(
        "--build", default="9999", help="sparkle:version (build) for the test item"
    )
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    if not SOURCE.exists():
        raise SystemExit("%s not found; run from the repo root" % SOURCE)
    make_test_appcast(args.version, args.build)
    serve(args.port)


if __name__ == "__main__":
    main()
