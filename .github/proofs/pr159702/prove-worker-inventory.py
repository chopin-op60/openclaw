#!/usr/bin/env python3
"""Manual, secretless Linux proof; authoring this file does not execute OpenClaw.

Run from a clean, pinned checkout in disposable GitHub-hosted fork CI:
  python3 /path/to/prove-worker-inventory.py after --expect-sha FULL_COMMIT_SHA

Only Python's standard library, Git, installed matching pnpm, and supported Node
are required. Use the clean, exact-SHA checkout and prepared dependencies owned by this
disposable secretless CI job. Gateway state and sanitized evidence live in a
new task-owned sandbox. No Git writes, product edits, or existing credentials.
Only evidence/ is publishable. Never upload the sandbox's source or runtime tree.
"""

import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time


GOOD = "proof-good"
BAD = "proof-broken"
DESCRIPTION = "Valid sibling"
GOOD_BYTES = (
    f"---\nname: {GOOD}\ndescription: {DESCRIPTION}\n---\n\nSynthetic proof skill.\n"
).encode()
BAD_BYTES = f"---\nname: {BAD}\n---\n".encode()
CHANGED_BYTES = f"---\nname: {BAD}\ndescription: Still rejected\n".encode()
FIRST_ERROR = "description is required"
SECOND_ERROR = (
    "invalid frontmatter: UNTERMINATED_FRONTMATTER: missing closing --- delimiter"
)
WARNING_HEADING = "Skill load warnings:"
# Product timer stays untouched. These are manual observer/supervisor bounds,
# not RPC/test overrides. Each CLI retains the production 1,500 ms status budget.
PASSIVE_SECONDS = 60
PUBLICATION_GRACE_SECONDS = 2
CLI_PROCESS_SECONDS = 120
STARTUP_SECONDS = 240
SETUP_SECONDS = 1200
STOP_SECONDS = 45
ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


class ProofFailure(Exception):
    pass


def require(condition, message):
    if not condition:
        raise ProofFailure(message)


class Proof:
    def __init__(self, mode, sandbox):
        self.mode = mode
        self.sandbox = sandbox
        self.source = sandbox / "source"
        self.runtime = sandbox / "runtime"
        self.evidence = sandbox / "evidence"
        self.workspace = self.runtime / "workspace"
        self.good_file = self.workspace / "skills" / GOOD / "SKILL.md"
        self.bad_file = self.workspace / "skills" / BAD / "SKILL.md"
        self.token = secrets.token_urlsafe(36)
        self.started = time.monotonic()
        self.rows = []
        self.gateway = None
        self.pump = None
        self.log_line = threading.Event()
        self.pump_error = None
        self.ready_line_kind = None
        for directory in (
            self.evidence, self.source, self.runtime / "home", self.runtime / "state",
            self.runtime / "tmp", self.runtime / "empty-bundled",
            self.runtime / "xdg-config", self.runtime / "xdg-data",
            self.runtime / "xdg-cache", self.runtime / "xdg-state",
        ):
            directory.mkdir(parents=True, exist_ok=True)
        # Do not copy os.environ: provider/GitHub tokens, proxy credentials, user
        # config selectors, NODE_OPTIONS, and operator Gateway targets stay out.
        self.env = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": str(self.runtime / "home"),
            "TMPDIR": str(self.runtime / "tmp"),
            "TMP": str(self.runtime / "tmp"),
            "TEMP": str(self.runtime / "tmp"),
            "XDG_CONFIG_HOME": str(self.runtime / "xdg-config"),
            "XDG_DATA_HOME": str(self.runtime / "xdg-data"),
            "XDG_CACHE_HOME": str(self.runtime / "xdg-cache"),
            "XDG_STATE_HOME": str(self.runtime / "xdg-state"),
            "PNPM_HOME": str(self.runtime / "pnpm-home"),
            "npm_config_cache": str(self.runtime / "npm-cache"),
            "NPM_CONFIG_USERCONFIG": str(self.runtime / "empty-npmrc"),
            "NPM_CONFIG_GLOBALCONFIG": str(self.runtime / "empty-global-npmrc"),
            "npm_config_manage_package_manager_versions": "false",
            "COREPACK_ENABLE_PROJECT_SPEC": "0",
            "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_CEILING_DIRECTORIES": str(sandbox),
            "NODE_COMPILE_CACHE": str(self.runtime / "node-cache"),
            "CI": "true", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
            "TERM": "dumb", "NO_COLOR": "1", "COLUMNS": "240",
            "OPENCLAW_STATE_DIR": str(self.runtime / "state"),
            "OPENCLAW_CONFIG_PATH": str(self.runtime / "config.json"),
            "OPENCLAW_BUNDLED_SKILLS_DIR": str(self.runtime / "empty-bundled"),
            "OPENCLAW_DISABLE_BUNDLED_PLUGINS": "1",
            "OPENCLAW_SKIP_CHANNELS": "1", "OPENCLAW_SKIP_PROVIDERS": "1",
            "OPENCLAW_SKIP_GMAIL_WATCHER": "1", "OPENCLAW_SKIP_CRON": "1",
            "OPENCLAW_SKIP_CANVAS_HOST": "1",
            "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER": "1",
        }
        (self.runtime / "empty-npmrc").write_text("", encoding="utf-8")
        (self.runtime / "empty-global-npmrc").write_text("", encoding="utf-8")

    def sanitize(self, value):
        value = ANSI.sub("", str(value)).replace(self.token, "<test-token>")
        value = value.replace(str(self.sandbox), "<sandbox>")
        # Egress sanitization also covers a startup/error line containing a URL.
        value = re.sub(r"(?i)\b(?:https?|wss?|ssh)://[^\s\"'<>]+", "<endpoint>", value)
        value = re.sub(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?", "<ip>", value)
        value = re.sub(r"\[?[0-9a-fA-F]*::[0-9a-fA-F:]*\]?(?::\d+)?", "<ip>", value)
        value = re.sub(r"\blocalhost(?::\d+)?\b", "<loopback>", value)
        value = re.sub(r"(?m)(agent model: )[^\r\n]+", r"\1<model>", value)
        return value

    def save(self, name, content):
        sanitized = self.sanitize(content)
        (self.evidence / name).write_text(sanitized, encoding="utf-8")
        return hashlib.sha256(sanitized.encode()).hexdigest()

    def record(self, **row):
        row = {"elapsedSeconds": round(time.monotonic() - self.started, 3), **row}
        self.rows.append(row)
        self.save("results.json", json.dumps(self.rows, indent=2) + "\n")
        print(self.sanitize(json.dumps(row)), flush=True)

    @staticmethod
    def terminate(process):
        # The normal pnpm/OpenClaw wrappers own descendant teardown. Signal the
        # task-owned process group and allow that ownership to drain first.
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=STOP_SECONDS)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=10)
                raise ProofFailure("task-owned process did not drain after SIGTERM")

    def run(self, name, args, *, cwd=None, env=None, timeout=CLI_PROCESS_SECONDS):
        began = time.monotonic()
        process = subprocess.Popen(
            args, cwd=cwd or self.source, env=env or self.env,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", start_new_session=True,
        )
        expired = False
        cleanup_failure = None
        try:
            try:
                out, err = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                expired = True
                try:
                    self.terminate(process)
                except ProofFailure as error:
                    cleanup_failure = str(error)
                finally:
                    out, err = process.communicate(timeout=10)
        finally:
            if process.poll() is None:
                self.terminate(process)
        stdout_hash = self.save(name + ".stdout", out)
        stderr_hash = self.save(name + ".stderr", err)
        self.record(
            phase="command", capture=name, exit=process.returncode,
            wallSeconds=round(time.monotonic() - began, 3), timedOut=expired,
            stdoutSha256=stdout_hash, stderrSha256=stderr_hash,
        )
        require(cleanup_failure is None, f"{name}: {cleanup_failure}")
        require(not expired, f"{name}: supervisor deadline expired; see saved terminal output")
        return process.returncode, ANSI.sub("", out), ANSI.sub("", err)

    def prepare_source(self, checkout, expected_sha):
        for binary in ("git", "node", "pnpm"):
            require(shutil.which(binary, path=self.env["PATH"]), f"missing installed {binary}")
        rc, out, _ = self.run("target-sha", ["git", "rev-parse", "HEAD"], cwd=checkout)
        require(rc == 0 and out.strip() == expected_sha, "checkout HEAD differs from --expect-sha")
        rc, out, _ = self.run(
            "tracked-changes", ["git", "status", "--porcelain", "--untracked-files=no"], cwd=checkout,
        )
        require(rc == 0 and not out.strip(), "commit tracked source changes before proof")
        # This checkout is owned exclusively by this disposable secretless CI job.
        # Checkout credentials were not persisted; its prepared install is reused.
        self.source = checkout
        manifest = json.loads((self.source / "package.json").read_text(encoding="utf-8"))
        self.env["GIT_COMMIT"] = expected_sha
        rc, version, _ = self.run("node-version", ["node", "--version"])
        match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)\s*", version)
        require(rc == 0 and match is not None, "Node release version unavailable")
        node_version = tuple(int(part) for part in match.groups())
        require(
            (node_version[0] == 24 and node_version >= (24, 16, 0)) or node_version >= (26, 1, 0),
            "install a Node release supported by the current product (26 recommended)",
        )
        rc, version, _ = self.run("pnpm-version", ["pnpm", "--version"])
        required = manifest["packageManager"].split("+", 1)[0].removeprefix("pnpm@")
        require(rc == 0 and version.strip() == required, "installed pnpm differs from target packageManager")
        schema = (self.source / "src/config/zod-schema.agents.ts").read_text(encoding="utf-8")
        fields = re.findall(r"^\s+(entries|list):\s*z\b", schema, re.MULTILINE)
        require(len(fields) == 1, "unrecognized agent config schema; inspect source before adapting")
        self.agent_schema = fields[0]
        # Older official main has readiness but no startup probe route. Inspect
        # the actual route owner before launch; never treat an HTTP 404 as ready.
        route_files = (
            self.source / "src/gateway/gateway-http-route-contracts.ts",
            self.source / "src/gateway/server-http.ts",
        )
        self.has_startup_probe = any(
            '"/startupz"' in path.read_text(encoding="utf-8")
            for path in route_files if path.exists()
        )
        require(self.mode != "after" or self.has_startup_probe,
                "after target lacks the current startup-probe contract")
        self.record(
            phase="source", mode=self.mode, targetSha=expected_sha, agentSchema=self.agent_schema,
            node=".".join(map(str, node_version)), pnpm=required,
            startupProbeSupported=self.has_startup_probe,
            engines=manifest.get("engines", {}).get("node"),
            fixtures={"validSha256": hashlib.sha256(GOOD_BYTES).hexdigest(),
                      "malformedSha256": hashlib.sha256(BAD_BYTES).hexdigest()},
        )
        # Configure file logging before any repository installer/build/CLI code
        # can choose its default shared temp log location.
        self.prepare_fixture()
        # The normal source wrapper builds this CI job's disposable checkout.
        rc, _, _ = self.run("prepare-cli", ["pnpm", "--silent", "openclaw", "--version"], timeout=SETUP_SECONDS)
        require(rc == 0, "normal CLI build/startup failed; see prepare-cli captures")

    def prepare_fixture(self):
        self.good_file.parent.mkdir(parents=True)
        self.bad_file.parent.mkdir(parents=True)
        self.good_file.write_bytes(GOOD_BYTES)
        self.bad_file.write_bytes(BAD_BYTES)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            self.port = reservation.getsockname()[1]
        agent = {"workspace": str(self.workspace), "default": True}
        agents = {"defaults": {"workspace": str(self.workspace)}}
        if self.agent_schema == "entries":
            agents["entries"] = {"main": agent}
        else:
            agents["list"] = [{"id": "main", **agent}]
        config = {
            "agents": agents,
            "gateway": {"mode": "local", "bind": "loopback", "port": self.port,
                        "auth": {"mode": "token", "token": self.token},
                        "controlUi": {"enabled": False}, "tailscale": {"mode": "off"}},
            "skills": {"load": {"watch": True}},
            "plugins": {"enabled": False}, "cron": {"enabled": False},
            "browser": {"enabled": False}, "discovery": {"mdns": {"mode": "off"}},
            "update": {"checkOnStart": False}, "env": {"shellEnv": {"enabled": False}},
            "logging": {"file": str(self.runtime / "gateway-private.log"), "level": "info",
                        "consoleLevel": "info", "consoleStyle": "pretty"},
        }
        Path(self.env["OPENCLAW_CONFIG_PATH"]).write_text(json.dumps(config) + "\n", encoding="utf-8")
        # The random synthetic token is never an argv value or an evidence field.
        self.client_env = {**self.env, "OPENCLAW_GATEWAY_URL": f"ws://127.0.0.1:{self.port}",
                           "OPENCLAW_GATEWAY_TOKEN": self.token}

    def start_gateway(self):
        self.gateway = subprocess.Popen(
            ["pnpm", "--silent", "openclaw", "gateway", "run", "--bind", "loopback",
             "--port", str(self.port)], cwd=self.source, env=self.env,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1, start_new_session=True,
        )

        def capture():
            try:
                with (self.evidence / "gateway.log").open("w", encoding="utf-8") as output:
                    for line in self.gateway.stdout:
                        output.write(self.sanitize(line))
                        output.flush()
                        line = ANSI.sub("", line)
                        if re.search(r"\[gateway\]\s+ready\s*$", line):
                            self.ready_line_kind = "ready"
                            self.log_line.set()
                        elif re.search(r"\[gateway\]\s+http server listening \(", line):
                            self.ready_line_kind = self.ready_line_kind or "startup-listener"
                            self.log_line.set()
            except Exception as error:
                self.pump_error = type(error).__name__
                self.log_line.set()

        self.pump = threading.Thread(target=capture, daemon=True)
        self.pump.start()
        deadline = time.monotonic() + STARTUP_SECONDS
        delay = 0.01
        while time.monotonic() < deadline:
            require(self.gateway.poll() is None, "Gateway exited during startup; see gateway.log")
            require(self.pump_error is None, "Gateway log reader failed")
            if self.log_line.is_set():
                probes = {}
                for path in (("/readyz", "/startupz") if self.has_startup_probe else ("/readyz",)):
                    connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=1)
                    try:
                        connection.request("GET", path)
                        response = connection.getresponse()
                        data = json.loads(response.read())
                        probes[path] = {"status": response.status, "body": data}
                    except (OSError, ValueError, http.client.HTTPException):
                        break
                    finally:
                        connection.close()
                startup_settled = not self.has_startup_probe or (
                    probes.get("/startupz", {}).get("status") == 200
                    and probes["/startupz"]["body"].get("ok") is True
                    and probes["/startupz"]["body"].get("status") == "started"
                )
                if (probes.get("/readyz", {}).get("status") == 200
                        and probes["/readyz"]["body"].get("ready") is True
                        and startup_settled):
                    self.save("readiness.json", json.dumps(probes, indent=2) + "\n")
                    self.record(phase="ready", marker=self.ready_line_kind,
                                explicitGatewayTarget=True, localFallbackAllowed=False)
                    return
            time.sleep(min(delay, max(0, deadline - time.monotonic())))
            delay = min(0.5, delay * 2)
        raise ProofFailure("Gateway startup did not settle within the original 240 second bound")

    def cli(self, capture, args):
        result = self.run(capture, ["pnpm", "--silent", "openclaw", *args], env=self.client_env)
        require("[skills] Skipping invalid skill:" not in result[2], f"{capture}: unexpected legacy local discovery")
        return result

    def observe(self, phase, message):
        require(self.good_file.read_bytes() == GOOD_BYTES, "valid fixture bytes changed")
        json_payloads, text_cores = {}, {}
        surfaces = (
            ("list", ["skills", "list"], 0),
            ("info-good", ["skills", "info", GOOD], 0),
            ("info-bad", ["skills", "info", BAD], 1),
            ("check", ["skills", "check"], 0),
        )
        for surface, args, expected_code in surfaces:
            for machine in (False, True):
                label = f"{phase}-{surface}-{'json' if machine else 'text'}"
                code, out, _ = self.cli(label, [*args, "--agent", "main", *(["--json"] if machine else [])])
                require(code == expected_code, f"{label}: exit {code}, expected {expected_code}; see captures")
                if machine:
                    try:
                        payload = json.loads(out)
                    except ValueError:
                        raise ProofFailure(f"{label}: stdout is not one JSON document") from None
                    require(isinstance(payload, dict), f"{label}: expected JSON object")
                    if message is None:
                        require("diagnostics" not in payload, f"{label}: warnings should be absent")
                    else:
                        expected = {"items": [{"kind": "invalid", "path": str(self.bad_file), "message": message}], "omitted": 0}
                        require(payload.get("diagnostics") == expected, f"{label}: wrong discovery diagnostic; see captures")
                    core = {key: value for key, value in payload.items() if key != "diagnostics"}
                    if surface == "list":
                        require([skill["name"] for skill in core.get("skills", [])] == [GOOD], f"{label}: valid inventory differs")
                        skill = core["skills"][0]
                        require(skill.get("description") == DESCRIPTION and skill.get("eligible") is True
                                and skill.get("source") == "openclaw-workspace" and skill.get("bundled") is False,
                                f"{label}: valid sibling is not ready workspace content")
                    elif surface == "info-good":
                        require(core.get("name") == GOOD and core.get("description") == DESCRIPTION
                                and core.get("eligible") is True and core.get("filePath") == str(self.good_file),
                                f"{label}: valid sibling info differs")
                    elif surface == "info-bad":
                        error = core.get("error")
                        require(core.get("skill") == BAD and (
                            error == "not found" or isinstance(error, dict) and error.get("message") == f'Skill "{BAD}" not found.'
                        ), f"{label}: expected missing-skill error, not transport failure")
                    else:
                        require(core.get("summary", {}).get("total") == 1 and core["summary"].get("eligible") == 1
                                and core.get("eligible") == [GOOD] and core.get("missingRequirements") == [],
                                f"{label}: readiness inventory differs")
                    json_payloads[surface] = core
                else:
                    require((WARNING_HEADING in out) == (message is not None), f"{label}: warning heading mismatch")
                    if message is not None:
                        require(out.count(WARNING_HEADING) == 1 and message in out
                                and f"skills/{BAD}/SKILL.md" in out, f"{label}: missing warning path or message")
                    else:
                        require(FIRST_ERROR not in out and SECOND_ERROR not in out, f"{label}: stale warning text")
                    if surface == "info-bad":
                        require(f'Skill "{BAD}" not found.' in out, f"{label}: missing-skill text differs")
                    else:
                        require(GOOD in out, f"{label}: valid sibling missing from text")
                    text_cores[surface] = out.split("\n\nTip:", 1)[0].split("\n\n" + WARNING_HEADING, 1)[0].rstrip()
        self.record(phase=phase, passed=True, warning=message, diagnosticItems=int(message is not None),
                    validNames=[GOOD], validFixtureSha256=hashlib.sha256(GOOD_BYTES).hexdigest())
        return json_payloads, text_cores

    def await_passive(self, phase, changed_at):
        self.record(phase=phase, waitingFor="ordinary passive refresh", productIntervalSeconds=PASSIVE_SECONDS)
        deadline = changed_at + PASSIVE_SECONDS + PUBLICATION_GRACE_SECONDS
        while time.monotonic() < deadline:
            require(self.gateway.poll() is None, "Gateway exited while awaiting passive refresh")
            time.sleep(min(1, max(0, deadline - time.monotonic())))
        self.record(phase=phase + "-observing", mutationAgeSeconds=round(time.monotonic() - changed_at, 3))

    def stop_gateway(self):
        if self.gateway is not None:
            try:
                self.terminate(self.gateway)
            finally:
                if self.pump:
                    self.pump.join(timeout=10)
            require(not self.pump or not self.pump.is_alive(), "Gateway output pipe did not drain")
            require(self.pump_error is None, "Gateway output capture failed")
            self.record(phase="gateway-stopped", exit=self.gateway.returncode)

    def negative_control(self):
        # Verify refusal before making a single CLI observation. A lingering
        # listener is a cleanup failure, never evidence against fallback.
        with socket.socket() as probe:
            probe.settimeout(1)
            require(probe.connect_ex(("127.0.0.1", self.port)) != 0, "task Gateway endpoint still accepts connections")
        code, out, err = self.cli("stopped-no-fallback", ["skills", "list", "--agent", "main", "--json"])
        require(code != 0 and GOOD not in out and '"skills"' not in out,
                "stopped Gateway returned inventory: local fallback was not excluded")
        require(re.search(r"closed|connect|ECONNREFUSED|unavailable|timeout", out + err, re.IGNORECASE),
                "negative control failed without recognizable transport evidence")
        self.record(phase="stopped-no-local-fallback", passed=True, exit=code, validFixtureStillPresent=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("baseline", "after"))
    parser.add_argument("--expect-sha", required=True, help="full pinned checkout commit; baseline provenance is supplied by CI")
    parser.add_argument("--sandbox-parent", type=Path, default=Path("/tmp"))
    args = parser.parse_args()
    require(re.fullmatch(r"[0-9a-f]{40}", args.expect_sha), "--expect-sha must be a full commit SHA")
    require(sys.platform == "linux", "use disposable GitHub-hosted Ubuntu for this proof")
    checkout = Path.cwd().resolve()
    parent = args.sandbox_parent.resolve()
    require(parent.is_dir() and parent != checkout and checkout not in parent.parents,
            "sandbox parent must already exist outside the source checkout")
    os.umask(0o077)
    sandbox = Path(tempfile.mkdtemp(prefix="openclaw-worker-inventory-", dir=parent))
    proof = Proof(args.mode, sandbox)
    success = False
    try:
        proof.prepare_source(checkout, args.expect_sha)
        proof.start_gateway()
        # Warm the real inventory owner once; the CLI's established 1.5 second
        # cold-discovery limit is outside this diagnostic change.
        code, _, _ = proof.cli("warm-inventory-owner", [
            "gateway", "call", "skills.status", "--params", '{"agentId":"main"}', "--json",
        ])
        require(code == 0, "initial inventory owner preparation failed")
        initial = proof.observe("initial", FIRST_ERROR if args.mode == "after" else None)
        if args.mode == "after":
            proof.bad_file.write_bytes(CHANGED_BYTES)
            proof.await_passive("changed", time.monotonic())
            changed = proof.observe("changed", SECOND_ERROR)
            require(changed == initial, "valid JSON entries or text changed with only the diagnostic edit")
            proof.bad_file.unlink()
            proof.await_passive("removed", time.monotonic())
            removed = proof.observe("removed", None)
            require(removed == initial, "valid JSON entries or text changed after malformed skill removal")
        proof.stop_gateway()
        proof.negative_control()
        success = True
    except Exception as error:
        proof.record(phase="failed", passed=False, category=type(error).__name__, reason=str(error))
    finally:
        try:
            if proof.gateway is not None and (proof.gateway.poll() is None or proof.pump and proof.pump.is_alive()):
                proof.stop_gateway()
        except Exception as error:
            success = False
            proof.record(phase="cleanup-failed", passed=False, category=type(error).__name__, reason=str(error))
        # Publish only sanitized captures; remove task-owned auth/device material.
        # The disposable CI checkout is not deleted by this harness.
        if proof.gateway is None or (proof.gateway.poll() is not None
                                     and (not proof.pump or not proof.pump.is_alive())):
            try:
                shutil.rmtree(proof.runtime)
                archive = sandbox / "source.tar"
                if archive.exists():
                    archive.unlink()
            except OSError as error:
                success = False
                proof.record(phase="sandbox-cleanup-failed", passed=False, reason=str(error))
        proof.record(phase="complete", passed=success, mode=args.mode, targetSha=args.expect_sha)
    # Location contains only task-owned temp data; captures normalize it to <sandbox>.
    print(json.dumps({"evidenceDirectory": str(proof.evidence), "passed": success}), flush=True)
    return 0 if success else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ProofFailure as error:
        print(json.dumps({"phase": "preflight-failed", "reason": str(error)}), flush=True)
        sys.exit(1)
