"""Exercise the built CLI with a fresh stdin attached to a real terminal."""

import json
import os
import select
import subprocess
import sys
import termios
import time

request = json.load(sys.stdin)
master, slave = os.openpty()
child = None
output = bytearray()


def flags():
    local = termios.tcgetattr(slave)[3]
    return {name: bool(local & getattr(termios, name)) for name in ("ECHO", "ICANON", "ISIG")}


def pump():
    if select.select([master], [], [], 0.05)[0]:
        try:
            output.extend(os.read(master, 4096))
        except OSError:
            pass


try:
    before = flags()
    child = subprocess.Popen(
        [request["node"], request["cli"], "connection", "secret", "set", request["name"],
         "--instance", request["url"]],
        stdin=slave, stdout=slave, stderr=slave,
        env=dict(os.environ, CATALYST_API_KEY="pty-test-key"), close_fds=True,
    )
    deadline = time.monotonic() + 10
    while b"Secret (hidden): " not in output and child.poll() is None and time.monotonic() < deadline:
        pump()
    prompted = b"Secret (hidden): " in output
    during = flags()
    if prompted:
        os.write(master, request["secret"].encode())
        pump()
        os.write(master, b"\x03" if request["cancel"] else b"\r")
    deadline = time.monotonic() + 5
    while child.poll() is None and time.monotonic() < deadline:
        pump()
    hung = child.poll() is None
    code = child.returncode
    after = flags()
    if hung:
        child.kill()
        child.wait()
    pump()
    print(json.dumps({
        "prompted": prompted, "hung": hung, "code": code,
        "before": before, "during": during, "after": after,
        "output": output.decode("utf8", "replace"),
    }))
finally:
    if child is not None and child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
    os.close(slave)
