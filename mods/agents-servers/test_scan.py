import tempfile
import unittest
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import scan


class LogSourcesTest(unittest.TestCase):
    def test_macos_runner_receives_child_output(self):
        with tempfile.TemporaryDirectory() as directory:
            log = str(Path(directory) / "dev server.log")
            Path(log).touch()
            records = [
                ["p30"],
                ["f1", "au", "tunix", "d0xaa", "n->0xbb"],
                ["f2", "au", "tunix", "d0xcc", "n->0xdd"],
                ["p20"],
                ["f1", "au", "tunix", "d0xaa", "n->0xbb"],
                ["f2", "au", "tunix", "d0xcc", "n->0xdd"],
                ["p10"],
                ["f1", "aw", "tREG", f"n{log}"],
                ["f2", "aw", "tREG", f"n{log}"],
                ["f16", "au", "tunix", "d0xbb", "n->0xaa"],
                ["f18", "au", "tunix", "d0xdd", "n->0xcc"],
            ]
            stdout = "\0\n".join("\0".join(record) for record in records) + "\0\n"
            with patch.object(scan, "LINUX", False), patch.object(scan, "run", return_value=SimpleNamespace(stdout=stdout)):
                outputs, readers = scan.output_descriptors({10, 20, 30})

            self.assertEqual(scan.log_sources([30, 20, 10], outputs, readers), ([log], False))

    def test_unrelated_ancestor_file_is_ignored(self):
        outputs = {(30, "1"): ("peer", "child output"), (10, "1"): ("file", "/tmp/agent.log")}
        readers = {30: set(), 10: {"other output"}}
        self.assertEqual(scan.log_sources([30, 10], outputs, readers), ([], False))

    def test_linux_runner_receives_child_output(self):
        sockets = "u_str ESTAB 0 0 * 421 * 422\nu_str ESTAB 0 0 * 422 * 421\n"
        descriptors = {
            "/proc/30/fd": {"1": "socket:[421]", "2": "pipe:[501]"},
            "/proc/10/fd": {"1": "/tmp/dev.log", "16": "socket:[422]", "18": "pipe:[501]"},
        }
        flags = {"/proc/30/fdinfo/1": "02", "/proc/30/fdinfo/2": "01",
                 "/proc/10/fdinfo/16": "02", "/proc/10/fdinfo/18": "00"}

        def readlink(path):
            folder, fd = path.rsplit("/", 1)
            return descriptors[folder][fd]

        with patch.object(scan, "LINUX", True), \
             patch.object(scan, "run", return_value=SimpleNamespace(stdout=sockets, returncode=0)), \
             patch.object(scan.os, "listdir", side_effect=lambda path: list(descriptors[path])), \
             patch.object(scan.os, "readlink", side_effect=readlink), \
             patch.object(scan.os.path, "isfile", return_value=True), \
             patch.object(scan, "open", create=True, side_effect=lambda path: StringIO(f"flags:\t{flags[path]}\n")):
            outputs, readers = scan.output_descriptors({10, 30})

        self.assertEqual(outputs[30, "1"], ("peer", "socket:[422]"))
        self.assertEqual(outputs[30, "2"], ("peer", "pipe:[501]"))
        self.assertNotIn("pipe:[501]", readers[30])
        self.assertEqual(scan.log_sources([30, 10], outputs, readers), (["/tmp/dev.log"], False))

    def test_terminal_output_has_no_file(self):
        outputs = {(30, "1"): ("terminal", "/dev/ttys001")}
        self.assertEqual(scan.log_sources([30], outputs, {30: set()}), ([], True))
