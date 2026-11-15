"""Print what is serving on this machine as JSON, for the Servers list in the agents sidebar.

ports:   TCP listeners owned by processes started inside a herdr-core terminal
         (they inherit HC_TERMINAL_ID), with that terminal's address.
compose: running Docker Compose containers, their published ports, the
         terminal showing that one service's output, and the terminal showing
         the whole project's output (`docker compose up`), if any.
"""
import json
import os
import re
import shutil
import subprocess

# The agents themselves listen on loopback for their own plumbing; that's not a server you run.
AGENT_PROCESSES = {"claude", "codex", "opencode", "copilot", "gemini", "amp", "cursor-agent"}
# Kernel-assigned ports are helpers' sockets, not servers people open.
EPHEMERAL_FROM = 32768
COMPOSE_TERMINAL_RANK = {"up": 0, "watch": 0, "start": 1, "logs": 2}
# Flags of those verbs that take a value, so the value is not read as a service name.
COMPOSE_VALUE_FLAGS = {"-n", "--tail", "--since", "--until", "--index", "-t", "--timeout",
                       "--scale", "--exit-code-from", "--attach", "--no-attach", "--pull",
                       "--wait-timeout"}
COMMAND_TIMEOUT_S = 5


def run(args):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=COMMAND_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired):
        return None


LINUX = os.path.isdir("/proc/self")
ENV_KEYS = ("HC_TERMINAL_ID", "COMPOSE_PROJECT_NAME")


class Processes:
    """What we need to know about processes: argv, the few env vars, cwd, name.

    Linux reads /proc. macOS has no /proc: `ps -E` shows the environment of
    your own processes, `ps -o args` their argv and `lsof` their folder.
    """

    def __init__(self):
        self.mac_env = None
        self.mac_args = None

    def pids(self):
        if LINUX:
            return [int(e) for e in os.listdir("/proc") if e.isdigit()]
        self._mac_load()
        return list(self.mac_args)

    def _mac_load(self):
        if self.mac_args is not None:
            return
        self.mac_env, self.mac_args = {}, {}
        r = run(["ps", "-ax", "-o", "pid=,args="])
        for line in (r.stdout.splitlines() if r and r.returncode == 0 else []):
            pid, _, args = line.strip().partition(" ")
            if pid.isdigit():
                self.mac_args[int(pid)] = args.split()
        r = run(["ps", "-E", "-ax", "-o", "pid=,command="])
        for line in (r.stdout.splitlines() if r and r.returncode == 0 else []):
            pid, _, rest = line.strip().partition(" ")
            if pid.isdigit():
                env = {k: m.group(1) for k in ENV_KEYS if (m := re.search(rf"(?:^|\s){k}=(\S+)", rest))}
                if env:
                    self.mac_env[int(pid)] = env

    def env(self, pid):
        if not LINUX:
            self._mac_load()
            return self.mac_env.get(pid, {})
        try:
            with open(f"/proc/{pid}/environ", "rb") as f:
                pairs = f.read().split(b"\0")
        except OSError:
            return {}
        env = {}
        for p in pairs:
            k, sep, v = p.partition(b"=")
            if sep and k.decode(errors="replace") in ENV_KEYS:
                env[k.decode()] = v.decode(errors="replace")
        return env

    def argv(self, pid):
        if not LINUX:
            self._mac_load()
            return self.mac_args.get(pid, [])
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                return [a.decode(errors="replace") for a in f.read().split(b"\0") if a]
        except OSError:
            return []

    def cwd(self, pid):
        if LINUX:
            try:
                return os.readlink(f"/proc/{pid}/cwd")
            except OSError:
                return None
        r = run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"])
        lines = [l[1:] for l in (r.stdout.splitlines() if r else []) if l.startswith("n")]
        return lines[0] if lines else None

    def comm(self, pid):
        if LINUX:
            try:
                with open(f"/proc/{pid}/comm") as f:
                    return f.read().strip()
            except OSError:
                return ""
        argv = self.argv(pid)
        return os.path.basename(argv[0]) if argv else ""


PROCS = Processes()


def listening_sockets():
    """(host, port, pid) for every TCP listener whose owner we can see."""
    if shutil.which("ss"):
        r = run(["ss", "-ltnpH"])
        for line in (r.stdout.splitlines() if r and r.returncode == 0 else []):
            cols = line.split()
            if len(cols) < 6:
                continue
            host, _, port = cols[3].rpartition(":")
            if port.isdigit():
                for pid in re.findall(r"pid=(\d+)", " ".join(cols[5:])):
                    yield host, int(port), int(pid)
        return
    r = run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"])
    pid = None
    for line in (r.stdout.splitlines() if r and r.returncode == 0 else []):
        if line.startswith("p"):
            pid = int(line[1:])
        elif line.startswith("n") and pid is not None:
            host, _, port = line[1:].rpartition(":")
            if port.isdigit():
                yield host, int(port), pid


def listeners():
    seen = {}
    for host, port, pid in listening_sockets():
        if port >= EPHEMERAL_FROM:
            continue
        terminal = PROCS.env(pid).get("HC_TERMINAL_ID")
        comm = PROCS.comm(pid)
        if not terminal or comm in AGENT_PROCESSES:
            continue
        entry = seen.get((port, pid))
        if entry is None:
            entry = seen[(port, pid)] = {"port": port, "pid": pid, "comm": comm, "terminal": terminal,
                                         "argv": PROCS.argv(pid)[:8], "cwd": PROCS.cwd(pid), "hosts": []}
        host = host.strip("[]").split("%")[0]
        if host not in entry["hosts"]:
            entry["hosts"].append(host)
    return sorted(seen.values(), key=lambda p: (p["port"], p["pid"]))


def compose_project_name(name):
    return re.sub(r"[^a-z0-9_-]", "", name.lower())


def compose_terminals():
    """`docker compose ...` CLIs running inside herdr-core terminals."""
    found = []
    for pid in PROCS.pids():
        argv = PROCS.argv(pid)
        if "compose" not in argv:
            continue
        env = PROCS.env(pid)
        if "HC_TERMINAL_ID" not in env:
            continue
        rest = argv[argv.index("compose") + 1:]
        verb = next((a for a in rest if a in COMPOSE_TERMINAL_RANK), None)
        if verb is None:
            continue
        project = env.get("COMPOSE_PROJECT_NAME")
        for i, a in enumerate(rest):
            if a in ("-p", "--project-name") and i + 1 < len(rest):
                project = rest[i + 1]
            elif a.startswith("--project-name="):
                project = a.split("=", 1)[1]
        cwd = PROCS.cwd(pid)
        found.append({"terminal": env["HC_TERMINAL_ID"], "verb": verb, "cwd": cwd,
                      "named": project is not None,
                      "project": project or (compose_project_name(os.path.basename(cwd)) if cwd else None),
                      "services": compose_services(rest[rest.index(verb) + 1:])})
    return found


def compose_services(args):
    """The services a `docker compose <verb>` names. None named means all of them."""
    services, skip = [], False
    for a in args:
        if skip:
            skip = False
        elif a in COMPOSE_VALUE_FLAGS:
            skip = True
        elif not a.startswith("-"):
            services.append(a)
    return services


def compose_terminal(clis, project, workdir, services):
    """The best terminal showing exactly these services of the project, or None."""
    # A command that names its project matches that project only. Otherwise two
    # projects started from one folder would share each other's terminals.
    matches = [t for t in clis
               if (t["project"] == project or (not t["named"] and workdir and t["cwd"] == workdir))
               and t["services"] == services]
    matches.sort(key=lambda t: COMPOSE_TERMINAL_RANK[t["verb"]])
    return matches[0]["terminal"] if matches else None


def parse_ports(text):
    out = []
    for part in filter(None, (p.strip() for p in (text or "").split(","))):
        m = re.match(r"(.+):(\d+)->(\d+)/(\w+)", part)
        if not m:
            continue
        host_port, container_port = int(m.group(2)), int(m.group(3))
        if not any(p["host"] == host_port for p in out):
            out.append({"host": host_port, "container": container_port, "proto": m.group(4)})
    return out


def compose():
    if not shutil.which("docker"):
        return [], None
    r = run(["docker", "ps", "--format", "{{json .}}"])
    if r is None:
        return [], None
    if r.returncode != 0:
        return [], (r.stderr.strip().splitlines() or ["docker failed"])[-1]
    clis = compose_terminals()
    services = []
    for line in r.stdout.splitlines():
        try:
            c = json.loads(line)
        except ValueError:
            continue
        labels = dict(kv.split("=", 1) for kv in c.get("Labels", "").split(",") if "=" in kv)
        project = labels.get("com.docker.compose.project")
        if not project:
            continue
        workdir = labels.get("com.docker.compose.project.working_dir")
        service = labels.get("com.docker.compose.service", c.get("Names", ""))
        status = c.get("Status", "")
        services.append({
            "project": project,
            "service": service,
            "container": c.get("Names", ""),
            "workdir": workdir,
            "workdir_exists": bool(workdir) and os.path.isdir(workdir),
            "state": c.get("State", ""),
            "health": "unhealthy" if "unhealthy" in status else "healthy" if "healthy" in status else None,
            "status": status,
            "ports": parse_ports(c.get("Ports")),
            "terminal": compose_terminal(clis, project, workdir, [service]),
            "project_terminal": compose_terminal(clis, project, workdir, []),
        })
    services.sort(key=lambda s: (s["project"], s["service"]))
    return services, None


if __name__ == "__main__":
    services, docker_error = compose()
    print(json.dumps({"ports": listeners(), "compose": services, "docker_error": docker_error}))
