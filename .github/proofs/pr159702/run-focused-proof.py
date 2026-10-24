#!/usr/bin/env python3
"""Run only the pinned skill diagnostic owner tests in disposable secretless CI."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=("baseline", "after"))
parser.add_argument("--expect-sha", required=True)
parser.add_argument("--proof-dir", type=Path, required=True)
parser.add_argument("--evidence-dir", type=Path, required=True)
args = parser.parse_args()
assert re.fullmatch(r"[0-9a-f]{40}", args.expect_sha)
actual = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
assert actual == args.expect_sha
args.evidence_dir.mkdir(parents=True, exist_ok=True)
worker = "src/skills/runtime/discovery.integration.test.ts"
files = [worker] if args.mode == "baseline" else [
    worker,
    "src/skills/discovery/status-workspace.test.ts",
    "src/skills/loading/workspace-skill-remote.test.ts",
    "src/cli/skills-cli.test.ts",
]
if args.mode == "baseline":
    subprocess.run(["git", "apply", "--unidiff-zero", str(args.proof_dir / "regression.diff")], check=True)
# Retain runner/tool locations, not service or operator credentials.
allowed = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "CI", "GITHUB_ACTIONS", "RUNNER_OS", "RUNNER_TEMP", "GITHUB_WORKSPACE")
env = {key: os.environ[key] for key in allowed if key in os.environ}
env.update(CI="true", GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1", GIT_TERMINAL_PROMPT="0")
rows = []
try:
    for index, file in enumerate(files):
        command = ["pnpm", "test", file, "--maxWorkers=1"]
        if file == worker:
            command += ["-t", "publishes external skill and diagnostic edits without a periodic scan|discovers agent-plugin additions and rejected files during the passive worker pass"]
        started = time.monotonic()
        result = subprocess.run(command, capture_output=True, text=True, env=env)
        output = result.stdout + result.stderr
        name = Path(file).name
        (args.evidence_dir / (name + ".log")).write_text(output)
        row = {"mode": args.mode, "head": actual, "file": file, "exitCode": result.returncode,
               "wallSeconds": round(time.monotonic() - started, 3), "command": command}
        if args.mode == "baseline":
            row["expectedRed"] = (result.returncode != 0 and "AssertionError" in output
                and "expected undefined" in output and "description is required" in output)
        rows.append(row)
        (args.evidence_dir / "focused-results.json").write_text(json.dumps(rows, indent=2) + "\n")
        print(json.dumps(row), flush=True)
        print(output, flush=True)
finally:
    if args.mode == "baseline":
        subprocess.run(["git", "restore", "--source=HEAD", "--staged", "--worktree", worker], check=True)
if args.mode == "baseline":
    assert rows[0]["expectedRed"], "baseline must fail on missing diagnostics, not fixture setup"
else:
    assert all(row["exitCode"] == 0 for row in rows), "one or more focused owner files failed"
