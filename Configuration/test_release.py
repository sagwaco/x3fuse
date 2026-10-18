#!/usr/bin/env python3
"""Check release notes, version updates, and updater metadata."""
import datetime
import json
import os
import re
import subprocess
import tempfile
import textwrap
from pathlib import Path

script = Path(__file__).with_name("release.sh").resolve()
with tempfile.TemporaryDirectory() as directory:
    Path(directory, "Release_Notes.md").write_bytes((
        "# 1.2.3 - Test release\n\n- First bullet.\n- Last bullet.\n\n"
        "# 1.2.2 - Previous release\n\n- Old bullet.\n"
    ).encode("utf-8"))
    output = subprocess.check_output(["bash", str(script)], cwd=directory, text=True)
    assert output == (
        "Latest Version: 1.2.3\nLatest Title: Test release\n"
        "Previous Version: 1.2.2\nRelease Notes:\n- First bullet.\n- Last bullet.\n"
    ), output
print("Release note extraction passed")

root = script.parent.parent
workflow = (root / ".github/workflows/release.yml").read_text(encoding="utf-8")


def release_step(name):
    step = workflow.split(f"      - name: {name}\n", 1)[1].split("\n      - ", 1)[0]
    return textwrap.dedent(step.split("        run: |\n", 1)[1])


with tempfile.TemporaryDirectory() as directory:
    workspace = Path(directory)
    (workspace / "new_version").write_bytes(b"1.2.3\n")
    remote = textwrap.dedent('''\
        git() {
          [ "$*" = 'ls-remote --tags origin refs/tags/v1.2.3' ] || return 99
          case "$TEST_REMOTE_STATE" in
            published) printf '%s\\n' 'abcdef refs/tags/v1.2.3' ;;
            unavailable) return 128 ;;
          esac
        }
        ''')
    for state, expected in [("absent", 0), ("published", 1), ("unavailable", 128)]:
        result = subprocess.run(
            ["bash", "-eo", "pipefail", "-c", remote + release_step("Reject published release versions")],
            cwd=workspace, env={**os.environ, "TEST_REMOTE_STATE": state}, capture_output=True,
        )
        assert result.returncode == expected, (state, result.returncode)
print("Published release guard passed")


with tempfile.TemporaryDirectory() as directory:
    workspace = Path(directory)
    files = (
        "package.json", "package-lock.json", "src-tauri/tauri.conf.json",
        "src-tauri/Cargo.toml", "src-tauri/Cargo.lock",
    )
    original = {name: (root / name).read_text(encoding="utf-8") for name in files}
    for name, content in original.items():
        path = workspace / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content.encode("utf-8"))

    version_step = release_step("Set release version")
    result = subprocess.run(
        ["bash", "-eo", "pipefail", "-c", version_step], cwd=workspace,
        env={**os.environ, "VERSION": "1.2.3\ninjected=true"}, capture_output=True,
    )
    assert result.returncode != 0
    assert all((workspace / name).read_text(encoding="utf-8") == content for name, content in original.items())
    subprocess.run(
        ["bash", "-eo", "pipefail", "-c", version_step], cwd=workspace,
        env={**os.environ, "VERSION": "1.2.3"}, check=True,
    )
    for name in files[:3]:
        assert json.loads((workspace / name).read_text(encoding="utf-8"))["version"] == "1.2.3", name
    lock = json.loads((workspace / "package-lock.json").read_text(encoding="utf-8"))
    assert lock["packages"][""]["version"] == "1.2.3"
    for filename, pattern in (
        ("Cargo.toml", r'\[package\]\s+name = "x3fuse"\s+version = "([^"]+)"'),
        ("Cargo.lock", r'name = "x3fuse"\s+version = "([^"]+)"'),
    ):
        assert re.findall(pattern, (workspace / "src-tauri" / filename).read_text(encoding="utf-8")) == ["1.2.3"], filename
print("Release version updates passed")

with tempfile.TemporaryDirectory() as directory:
    workspace = Path(directory)
    (workspace / "Release").mkdir()
    (workspace / "docs/Support").mkdir(parents=True)
    notes = '- Keep "quotes", backslashes \\, and Unicode: 사진.\n- Keep the last bullet.\n'
    (workspace / "latest_changes").write_bytes(notes.encode("utf-8"))
    (workspace / "Release/X3Fuse.app.tar.gz.sig").write_bytes(b"fake-signature\n")
    subprocess.run(
        ["bash", "-eo", "pipefail", "-c", release_step("Write Tauri updater metadata")],
        cwd=workspace, env={**os.environ, "VERSION": "1.2.3", "REPOSITORY": "test/x3fuse"},
        check=True,
    )
    output = workspace / "docs/Support/latest.json"
    subprocess.run(["python3", "-m", "json.tool", str(output)], check=True, stdout=subprocess.DEVNULL)
    metadata = json.loads(output.read_text(encoding="utf-8"))
    assert metadata["version"] == "1.2.3"
    assert metadata["notes"] == notes
    datetime.datetime.strptime(metadata["pub_date"], "%Y-%m-%dT%H:%M:%SZ")
    assert set(metadata["platforms"]) == {"darwin-universal", "darwin-aarch64", "darwin-x86_64"}
    assert all(platform == {
        "url": "https://github.com/test/x3fuse/releases/download/v1.2.3/X3Fuse.app.tar.gz",
        "signature": "fake-signature",
    } for platform in metadata["platforms"].values())
print("Tauri updater metadata passed")
