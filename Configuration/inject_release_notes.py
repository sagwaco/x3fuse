#!/usr/bin/env python3
"""Embed per-version release notes from Release_Notes.md into the Sparkle appcast.

Sparkle's standard update window renders each appcast <item>'s <description> in
its release-notes pane, next to the Install / Remind Me Later / Skip This Version
buttons. `generate_appcast` does not add descriptions, so without this step the
pane is blank and users have nothing to read before deciding whether to update.

This script post-processes docs/Support/appcast.xml, matching each <item> to its
version in Release_Notes.md and embedding the notes as inline HTML (CDATA). It is
idempotent: any existing <description> is replaced, so Release_Notes.md stays the
single source of truth. Run it after `generate_appcast` in CI, or by hand to
refresh the checked-in appcast.

Usage:
    python3 Configuration/inject_release_notes.py
    python3 Configuration/inject_release_notes.py --appcast path/to/appcast.xml --notes path/to/Release_Notes.md
"""

import argparse
import html
import re
import sys
from pathlib import Path

# "# 0.1.4 - Beta 1.1.4" -> version "0.1.4", title "Beta 1.1.4"
HEADER_RE = re.compile(r"^#\s+([0-9][0-9.]*)\s*-\s*(.*?)\s*$")
BULLET_RE = re.compile(r"^[-*]\s+(.*?)\s*$")

# Minimal styling so the notes read as native text in light and dark appearance.
STYLE = (
    "body{font:13px/1.5 -apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;"
    "color:#1d1d1f;margin:0;padding:2px}"
    "h3{font-size:13px;font-weight:600;margin:0 0 6px}"
    "ul{margin:0;padding-left:18px}li{margin:0 0 5px}"
    "code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;"
    "background:rgba(127,127,127,.15);padding:1px 4px;border-radius:3px}"
    "@media(prefers-color-scheme:dark){body{color:#f5f5f7}}"
)

# `inline code` -> <code>inline code</code>, applied after HTML escaping.
INLINE_CODE_RE = re.compile(r"`([^`]+)`")


def format_bullet(text):
    """Escape a bullet, then render Markdown inline code as <code>."""
    return INLINE_CODE_RE.sub(r"<code>\1</code>", html.escape(text))


def parse_notes(text):
    """Return {version: (title, [bullets])} parsed from Release_Notes.md."""
    sections = {}
    version = None
    for line in text.splitlines():
        header = HEADER_RE.match(line)
        if header:
            version = header.group(1)
            sections[version] = (header.group(2), [])
            continue
        if version is None:
            continue
        bullet = BULLET_RE.match(line)
        if bullet:
            sections[version][1].append(bullet.group(1))
    return sections


def render_html(title, bullets):
    """Build the HTML body for one version's release notes.

    Everything is HTML-escaped: the content lands inside CDATA but is consumed by
    Sparkle's WKWebView as HTML, so escaping both renders special characters as
    text and prevents a stray "]]>" from closing the CDATA section early.
    """
    heading = "<h3>%s</h3>" % html.escape(title) if title else ""
    items = "".join("<li>%s</li>" % format_bullet(b) for b in bullets)
    return "<style>%s</style>%s<ul>%s</ul>" % (STYLE, heading, items)


def inject(xml, sections):
    """Replace/insert a <description> in every <item> with a known version."""
    updated = []

    def replace_item(match):
        item = match.group(0)
        version_match = re.search(
            r"<sparkle:shortVersionString>([^<]+)</sparkle:shortVersionString>", item
        ) or re.search(r"<sparkle:version>([^<]+)</sparkle:version>", item)
        if not version_match:
            return item
        version = version_match.group(1).strip()
        if version not in sections:
            return item

        # Drop any existing description so Release_Notes.md remains canonical.
        item = re.sub(r"[ \t]*<description>.*?</description>\n?", "", item, flags=re.S)

        anchor = re.search(
            r"\n([ \t]*)<sparkle:shortVersionString>[^\n]*\n", item
        ) or re.search(r"\n([ \t]*)<title>[^\n]*\n", item)
        indent = anchor.group(1) if anchor else "            "
        title, bullets = sections[version]
        description = "%s<description><![CDATA[%s]]></description>\n" % (
            indent,
            render_html(title, bullets),
        )
        item = item[: anchor.end()] + description + item[anchor.end():]
        updated.append(version)
        return item

    result = re.sub(r"<item>.*?</item>", replace_item, xml, flags=re.S)
    return result, updated


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--appcast", default="docs/Support/appcast.xml")
    parser.add_argument("--notes", default="Release_Notes.md")
    args = parser.parse_args(argv)

    appcast_path = Path(args.appcast)
    notes_path = Path(args.notes)
    if not appcast_path.exists():
        sys.exit("appcast not found: %s" % appcast_path)
    if not notes_path.exists():
        sys.exit("release notes not found: %s" % notes_path)

    sections = parse_notes(notes_path.read_text(encoding="utf-8"))
    if not sections:
        sys.exit("no versioned sections parsed from %s" % notes_path)

    xml = appcast_path.read_text(encoding="utf-8")
    result, updated = inject(xml, sections)

    if result == xml:
        print("appcast already up to date; no changes written")
        return

    appcast_path.write_text(result, encoding="utf-8")
    print("embedded release notes for: %s" % ", ".join(updated))


if __name__ == "__main__":
    main()
