#!/usr/bin/env python3
# Prototype. Not the change to merge.

from __future__ import annotations

import json
import re
import subprocess
import sys

AD_KEYS = (
    "profiles:",
    "levels:",
    "H264Profile",
    "H264Level",
    "resolutions",
    "AAC_ELD",
    "OPUS",
    "samplerate",
    "wifiSet",
    "hiresSet",
    "compatSet",
    "fourByThree",
    "[854",
    "[1280",
    "[1920",
    "[640",
    "[480",
    "[320",
)


def git_show(oid: str) -> str:
    return subprocess.check_output(
        ["git", "show", f"{oid}:src/homekit.ts"],
        text=True,
        stderr=subprocess.DEVNULL,
    )


def firmware(src: str) -> str:
    match = re.search(r'export const ARGUS_FIRMWARE_REVISION = "([^"]+)"', src)
    return match.group(1) if match else "?"


def advertisement(src: str) -> str:
    start = src.find("export function buildCameraControllerOptions")
    if start < 0:
        return "MISSING"
    end = src.find("\nexport ", start + 30)
    body = src[start:end]
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
    body = re.sub(r"//.*", "", body)
    lines: list[str] = []
    for line in body.splitlines():
        compact = " ".join(line.split())
        if any(key in compact for key in AD_KEYS):
            lines.append(compact)
    return "\n".join(lines)


def pull_commits() -> list[dict[str, str]]:
    raw = subprocess.check_output(
        [
            "gh",
            "api",
            "--paginate",
            "repos/point-labs-dev/argus/pulls/3/commits",
            "--jq",
            ".[] | {oid: .sha, headline: .commit.message}",
        ],
        text=True,
    )
    rows = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        headline = item["headline"].splitlines()[0]
        rows.append({"oid": item["oid"], "headline": headline})
    return rows


def classify(commits: list[dict[str, str]]) -> None:
    sequence: list[tuple[str, str, str, str]] = []
    for commit in commits:
        src = git_show(commit["oid"])
        sequence.append((commit["oid"], firmware(src), advertisement(src), commit["headline"]))

    groups: dict[str, list[tuple[str, str, str]]] = {}
    order: list[str] = []
    for oid, version, data, headline in sequence:
        if version not in groups:
            order.append(version)
            groups[version] = []
        groups[version].append((oid, data, headline))

    justified = 0
    churn = 0
    print(f"pr3_commits {len(sequence)}")
    print(f"pr3_versions {len(order)} from {order[0]} to {order[-1]}")
    for index, version in enumerate(order[:-1]):
        nxt = order[index + 1]
        accumulated_change = groups[version][0][1] != groups[nxt][0][1]
        tag = "JUSTIFIED" if accumulated_change else "CHURN"
        if accumulated_change:
            justified += 1
        else:
            churn += 1
        oid = groups[nxt][0][0]
        headline = groups[nxt][0][2]
        print(f"{tag} {version} -> {nxt} {oid} {headline}")
    print(f"pr3_justified {justified}")
    print(f"pr3_churn {churn}")


def main_history() -> None:
    raw = subprocess.check_output(
        ["git", "log", "-G", "export const ARGUS_FIRMWARE_REVISION", "--format=%H %s", "--", "src/homekit.ts"],
        text=True,
    )
    rows = [line.split(" ", 1) for line in raw.splitlines() if line.strip()]
    rows.reverse()
    print("main_firmware_commits")
    previous: tuple[str, str] | None = None
    for oid, subject in rows:
        src = git_show(oid)
        version = firmware(src)
        data = advertisement(src)
        if previous is None:
            relation = "first"
        elif data == previous[1]:
            relation = "AD_SAME"
        else:
            relation = "AD_CHANGED"
        print(f"{relation} {version} {oid} {subject}")
        previous = (version, data)


def main() -> None:
    classify(pull_commits())
    main_history()


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(error, file=sys.stderr)
        sys.exit(1)
