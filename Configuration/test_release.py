#!/usr/bin/env python3
"""Check that release extraction preserves every bullet in the newest release."""
import subprocess
import tempfile
from pathlib import Path

script = Path(__file__).with_name("release.sh").resolve()
with tempfile.TemporaryDirectory() as directory:
    Path(directory, "Release_Notes.md").write_text(
        "# 1.2.3 - Test release\n\n- First bullet.\n- Last bullet.\n\n"
        "# 1.2.2 - Previous release\n\n- Old bullet.\n"
    )
    output = subprocess.check_output(["bash", str(script)], cwd=directory, text=True)
    assert output == (
        "Latest Version: 1.2.3\nLatest Title: Test release\n"
        "Previous Version: 1.2.2\nRelease Notes:\n- First bullet.\n- Last bullet.\n"
    ), output
print("Release note extraction passed")
