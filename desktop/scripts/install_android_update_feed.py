#!/usr/bin/env python3
"""Install or refresh the external Android update feed for the current Mac user."""

import argparse
import os
import plistlib
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

from android_update_feed import APK_NAME, MANIFEST_NAME, load_release


LABEL = "com.codexmonitor.android-update-feed"


def atomic_copy(source, destination, mode=None):
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.tmp")
    shutil.copyfile(source, temporary)
    if mode is not None:
        temporary.chmod(mode)
    os.replace(temporary, destination)


def install(apk, manifest):
    apk = Path(apk).resolve()
    manifest = Path(manifest).resolve()
    source_script = Path(__file__).resolve().with_name("android_update_feed.py")

    # Validate the candidate pair before changing the live feed.
    with tempfile.TemporaryDirectory(prefix="codex-monitor-update-feed-") as directory:
        staging = Path(directory)
        shutil.copyfile(manifest, staging / MANIFEST_NAME)
        shutil.copyfile(apk, staging / APK_NAME)
        load_release(staging)

    home = Path.home()
    support = home / "Library/Application Support/codex-monitor-update-feed"
    launch_agents = home / "Library/LaunchAgents"
    live_script = support / "android_update_feed.py"
    live_manifest = support / MANIFEST_NAME
    live_apk = support / APK_NAME
    plist_path = launch_agents / f"{LABEL}.plist"

    atomic_copy(source_script, live_script, 0o755)
    atomic_copy(apk, live_apk, 0o644)
    atomic_copy(manifest, live_manifest, 0o644)
    load_release(support)

    plist = {
        "Label": LABEL,
        "ProgramArguments": [
            "/usr/bin/python3",
            str(live_script),
            "--root",
            str(support),
            "--host",
            "0.0.0.0",
            "--port",
            "43118",
        ],
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 1,
        "ProcessType": "Background",
        "StandardOutPath": str(support / "feed.stdout.log"),
        "StandardErrorPath": str(support / "feed.stderr.log"),
    }
    launch_agents.mkdir(parents=True, exist_ok=True)
    temporary_plist = plist_path.with_name(f".{plist_path.name}.tmp")
    with temporary_plist.open("wb") as output:
        plistlib.dump(plist, output)
    os.replace(temporary_plist, plist_path)

    domain = f"gui/{os.getuid()}"
    subprocess.run(
        ["/bin/launchctl", "bootout", domain, str(plist_path)],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(["/bin/launchctl", "bootstrap", domain, str(plist_path)], check=True)
    local_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 5
    while True:
        try:
            with local_opener.open("http://127.0.0.1:43118/health", timeout=0.5) as response:
                if response.status == 200:
                    break
        except Exception:
            if time.monotonic() >= deadline:
                raise RuntimeError("update feed did not become healthy on port 43118")
            time.sleep(0.1)
    return support, plist_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apk", required=True)
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args()
    support, plist_path = install(args.apk, args.manifest)
    print(f"Installed feed in {support}")
    print(f"LaunchAgent: {plist_path}")


if __name__ == "__main__":
    main()
