"""Print what is serving on this machine as JSON, for the Servers list in the agents sidebar.

ports:      TCP listeners started in Herdr, with their terminal and open log files.
compose:    Running Compose services.
containers: Standalone containers with published TCP ports.
"""
import json
import os
import re
import shutil
import subprocess

# Agents and editor extensions use their own ports.
HELPER_PROCESSES = {"claude", "codex", "opencode", "copilot", "gemini", "amp", "cursor-agent",
                    "Code Helper (Plugin)"}
# Leave out the range usually assigned by the kernel.
EPHEMERAL_FROM = 32768
COMPOSE_TERMINAL_RANK = {"up": 0, "watch": 0, "logs": 1}
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
        self.mac_parents = None

    def pids(self):
        if LINUX:
            return [int(e) for e in os.listdir("/proc") if e.isdigit()]
        self._mac_load()
        return list(self.mac_args)

    def _mac_load(self):
        if self.mac_args is not None:
            return
        self.mac_env, self.mac_args, self.mac_parents = {}, {}, {}
        r = run(["ps", "-ww", "-ax", "-o", "pid=,ppid=,args="])
        for line in (r.stdout.splitlines() if r and r.returncode == 0 else []):
            fields = line.split(maxsplit=2)
            if len(fields) == 3:
                pid, parent, args = fields
                self.mac_args[int(pid)] = args.split()
                self.mac_parents[int(pid)] = int(parent)
        r = run(["ps", "-wwE", "-ax", "-o", "pid=,command="])
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

    def parent(self, pid):
        if not LINUX:
            self._mac_load()
            return self.mac_parents.get(pid, 0)
        try:
            with open(f"/proc/{pid}/stat") as f:
                return int(f.read().rsplit(")", 1)[1].split()[1])
        except (OSError, IndexError, ValueError):
            return 0

    def terminal(self, pid):
        for pid in self.lineage(pid):
            address = self.env(pid).get("HC_TERMINAL_ID")
            if address:
                return address
        return None

    def lineage(self, pid):
        seen = set()
        while pid > 1 and pid not in seen:
            seen.add(pid)
            yield pid
            pid = self.parent(pid)

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


def output_descriptors(pids):
    """Return stdout, stderr, and the read ends of output channels."""
    outputs = {}
    readers = {pid: set() for pid in pids}
    if LINUX:
        read_linux_outputs(pids, outputs, readers)
    elif pids:
        r = run(["lsof", "-nP", "-a", "-p", ",".join(map(str, pids)), "-F0fatdn"])
        pid = None
        for record in (r.stdout.split("\0\n") if r else []):
            fields = {field[0]: field[1:] for field in record.split("\0") if field}
            if "p" in fields:
                pid = int(fields["p"])
                continue
            fd, kind, name = fields.get("f"), fields.get("t"), fields.get("n", "")
            if pid not in readers or not fd or not fd.isdecimal():
                continue
            if kind in {"PIPE", "unix"} and name.startswith("->0x"):
                if fields.get("a") in {"r", "u"} and "d" in fields:
                    readers[pid].add(fields["d"])
                if fd in {"1", "2"}:
                    outputs[pid, fd] = ("peer", name[2:])
            elif fd in {"1", "2"}:
                if kind == "REG" and os.path.isfile(name):
                    outputs[pid, fd] = ("file", name)
                elif kind == "CHR" and name.startswith("/dev/ttys"):
                    outputs[pid, fd] = ("terminal", name)
    return outputs, readers


def read_linux_outputs(pids, outputs, readers):
    socket_peers = {}
    if pids:
        r = run(["ss", "-xanH"])
        for line in (r.stdout.splitlines() if r and r.returncode == 0 else []):
            # A socket pair created by a runner has no bound address.
            match = re.fullmatch(r"\S+\s+ESTAB\s+\d+\s+\d+\s+\*\s+(\d+)\s+\*\s+(\d+)", line.strip())
            if match and match[2] != "0":
                socket_peers[f"socket:[{match[1]}]"] = f"socket:[{match[2]}]"
    for pid in pids:
        folder = f"/proc/{pid}"
        try:
            descriptors = os.listdir(f"{folder}/fd")
        except OSError:
            continue
        for fd in descriptors:
            try:
                name = os.readlink(f"{folder}/fd/{fd}")
                peer = name if name.startswith("pipe:[") else socket_peers.get(name)
                if peer:
                    with open(f"{folder}/fdinfo/{fd}") as f:
                        mode = re.search(r"^flags:\s+([0-7]+)", f.read(), re.M)
                    if mode and int(mode[1], 8) & os.O_ACCMODE != os.O_WRONLY:
                        readers[pid].add(name)
                    if fd in {"1", "2"}:
                        outputs[pid, fd] = ("peer", peer)
                elif fd in {"1", "2"}:
                    if name.startswith("/dev/pts/"):
                        outputs[pid, fd] = ("terminal", name)
                    elif os.path.isabs(name) and os.path.isfile(name):
                        outputs[pid, fd] = ("file", name)
            except OSError:
                continue


def log_sources(lineage, outputs, readers):
    files, terminal_output = [], False
    pending = [(0, "1"), (0, "2")]
    seen = set()
    for index, fd in pending:
        if (index, fd) in seen:
            continue
        seen.add((index, fd))
        kind, target = outputs.get((lineage[index], fd), (None, None))
        if kind == "file" and target not in files:
            files.append(target)
        elif kind == "terminal":
            terminal_output = True
        elif kind == "peer":
            # The runner can send either child stream to its own stdout or stderr.
            for parent in range(index + 1, len(lineage)):
                if target in readers[lineage[parent]]:
                    pending.extend([(parent, "1"), (parent, "2")])
                    break
    return files, terminal_output


def listening_sockets():
    """Yield the address and owner of each visible TCP listener."""
    if shutil.which("ss"):
        r = run(["ss", "-ltnpH"])
        for line in (r.stdout.splitlines() if r and r.returncode == 0 else []):
            cols = line.split()
            if len(cols) < 6:
                continue
            host, _, port = cols[3].rpartition(":")
            if port.isdigit():
                for pid in re.findall(r"pid=(\d+)", " ".join(cols[5:])):
                    yield host, int(port), int(pid), None
        return
    r = run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])
    pid = None
    command = None
    for line in (r.stdout.splitlines() if r and r.returncode == 0 else []):
        if line.startswith("p"):
            pid = int(line[1:])
            command = None
        elif line.startswith("c"):
            command = line[1:]
        elif line.startswith("n") and pid is not None:
            host, _, port = line[1:].rpartition(":")
            if port.isdigit():
                yield host, int(port), pid, command


def listeners(docker_ports):
    seen = {}
    for host, port, pid, command in listening_sockets():
        if port >= EPHEMERAL_FROM or command in HELPER_PROCESSES:
            continue
        entry = seen.get((port, pid))
        if entry is None:
            terminal = PROCS.terminal(pid)
            comm = PROCS.comm(pid)
            if not terminal or comm in HELPER_PROCESSES:
                continue
            if port in docker_ports and comm in {"ssh", "docker-proxy", "com.docker.backend"}:
                continue
            entry = seen[(port, pid)] = {"port": port, "pid": pid, "comm": comm, "terminal": terminal,
                                         "argv": PROCS.argv(pid)[:8], "cwd": PROCS.cwd(pid), "hosts": []}
        host = host.strip("[]").split("%")[0]
        if host not in entry["hosts"]:
            entry["hosts"].append(host)
    lineages = {}
    for entry in seen.values():
        if entry["pid"] not in lineages:
            lineages[entry["pid"]] = list(PROCS.lineage(entry["pid"]))
    outputs, readers = output_descriptors({pid for path in lineages.values() for pid in path})
    for entry in seen.values():
        entry["log_files"], entry["terminal_output"] = log_sources(lineages[entry["pid"]], outputs, readers)
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
        args = rest[rest.index(verb) + 1:]
        if "-d" in args or "--detach" in args or "--wait" in args:
            continue
        if verb == "logs" and "-f" not in args and "--follow" not in args:
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
                      "services": compose_services(args)})
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
        port = {"host": host_port, "container": container_port, "proto": m.group(4)}
        if port not in out:
            out.append(port)
    return out


def docker_services():
    if not shutil.which("docker"):
        return [], None
    r = run(["docker", "ps", "--no-trunc", "--format", "{{json .}}"])
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
        ports = [p for p in parse_ports(c.get("Ports")) if p["proto"] == "tcp"]
        if not project and not ports:
            continue
        workdir = labels.get("com.docker.compose.project.working_dir")
        service = labels.get("com.docker.compose.service", c.get("Names", ""))
        status = c.get("Status", "")
        services.append({
            "project": project,
            "service": service,
            "container": c.get("Names", ""),
            "container_id": c["ID"],
            "workdir": workdir,
            "workdir_exists": bool(workdir) and os.path.isdir(workdir),
            "state": c.get("State", ""),
            "health": "unhealthy" if "unhealthy" in status else "healthy" if "healthy" in status else None,
            "status": status,
            "ports": ports,
            "project_terminal": compose_terminal(clis, project, workdir, []) if project else None,
        })
    services.sort(key=lambda s: (s["project"] or "", s["service"]))
    return services, None


if __name__ == "__main__":
    services, docker_error = docker_services()
    docker_ports = {p["host"] for s in services for p in s["ports"]}
    print(json.dumps({
        "ports": listeners(docker_ports),
        "compose": [s for s in services if s["project"]],
        "containers": [s for s in services if not s["project"]],
        "docker_error": docker_error,
    }))
