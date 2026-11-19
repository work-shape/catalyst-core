// What a code tool's handler imports to call a Connection (TOOL-2c, platform-access.md,
// section 3a): one module for Python and one for Node, put beside the tool's files for each
// call. A call writes one request as a line of JSON to the descriptor the platform opened and
// reads the answer as one line from the other; the worker carries the request out through the
// platform, as the tool's caller. The sandbox has no network, so this is the one way out, and
// no credential ever comes in. A full SDK with `ctx` is TOOL-2d.
//
// Python:
//   from catalyst_tool import connection
//   contact = connection("crm").call("find_contact", {"email": "..."})
// Node:
//   import { connection } from "catalyst-tool";
//   const contact = await connection("crm").call("find_contact", { email: "..." });
//
// A refused or failed call raises `ConnectionCallError` with its `code`, such as
// `connection_not_declared`.

const PYTHON = `"""Calls a Connection operation the tool declares, through the platform."""

import json
import os
import select
import threading

__all__ = ["ConnectionCallError", "call", "connection"]

_lock = threading.Lock()
_held = b""


class ConnectionCallError(Exception):
    """A call the platform refused, or that failed. \`code\` names why."""

    def __init__(self, code, message):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def _descriptor(name):
    value = os.environ.get(name)
    if value is None:
        raise ConnectionCallError(
            "channel_unavailable", "This handler runs without the platform's request channel"
        )
    return int(value)


def _write(fd, data):
    while data:
        select.select([], [fd], [])
        try:
            data = data[os.write(fd, data):]
        except BlockingIOError:
            pass


def _read_line(fd):
    global _held
    while b"\\n" not in _held:
        select.select([fd], [], [])
        try:
            chunk = os.read(fd, 65536)
        except BlockingIOError:
            continue
        if not chunk:
            raise ConnectionCallError("channel_closed", "The platform closed the request channel")
        _held += chunk
    line, _, _held = _held.partition(b"\\n")
    return line


def call(connection, operation, input=None):
    """Calls \`connection.<connection>.<operation>\` and answers its output."""
    request = json.dumps(
        {"connection": connection, "operation": operation, "input": {} if input is None else input},
        separators=(",", ":"),
    )
    with _lock:
        _write(_descriptor("CATALYST_REQUEST_FD"), (request + "\\n").encode("utf-8"))
        answer = json.loads(_read_line(_descriptor("CATALYST_ANSWER_FD")))
    if answer.get("ok"):
        return answer.get("output")
    error = answer.get("error") or {}
    raise ConnectionCallError(error.get("code", "failed"), error.get("message", ""))


class _Connection:
    def __init__(self, name):
        self.name = name

    def call(self, operation, input=None):
        return call(self.name, operation, input)


def connection(name):
    """The Connection \`name\`, whose declared operations \`.call\` calls."""
    return _Connection(name)
`;

const NODE = `// Calls a Connection operation the tool declares, through the platform.
import { readSync, writeSync } from "node:fs";

export class ConnectionCallError extends Error {
  constructor(code, message) {
    super(\`\${code}: \${message}\`);
    this.name = "ConnectionCallError";
    this.code = code;
  }
}

let held = Buffer.alloc(0);
const pause = new Int32Array(new SharedArrayBuffer(4));

function descriptor(value) {
  if (value === undefined)
    throw new ConnectionCallError("channel_unavailable", "This handler runs without the platform's request channel");
  return Number(value);
}

function again(error) {
  if (error?.code !== "EAGAIN") throw error;
  Atomics.wait(pause, 0, 0, 5);
}

function write(fd, data) {
  let at = 0;
  while (at < data.length) {
    try {
      at += writeSync(fd, data, at);
    } catch (error) {
      again(error);
    }
  }
}

function readLine(fd) {
  const chunk = Buffer.alloc(65536);
  for (;;) {
    const end = held.indexOf(10);
    if (end >= 0) {
      const line = held.subarray(0, end).toString("utf8");
      held = held.subarray(end + 1);
      return line;
    }
    let read;
    try {
      read = readSync(fd, chunk, 0, chunk.length, null);
    } catch (error) {
      again(error);
      continue;
    }
    if (read === 0) throw new ConnectionCallError("channel_closed", "The platform closed the request channel");
    held = Buffer.concat([held, chunk.subarray(0, read)]);
  }
}

/** Calls \`connection.<connection>.<operation>\` and answers its output. */
export async function call(connection, operation, input = {}) {
  write(descriptor(process.env.CATALYST_REQUEST_FD), Buffer.from(JSON.stringify({ connection, operation, input }) + "\\n", "utf8"));
  const answer = JSON.parse(readLine(descriptor(process.env.CATALYST_ANSWER_FD)));
  if (answer.ok) return answer.output;
  throw new ConnectionCallError(answer.error?.code ?? "failed", answer.error?.message ?? "");
}

/** The Connection \`name\`, whose declared operations \`.call\` calls. */
export function connection(name) {
  return { call: (operation, input) => call(name, operation, input) };
}
`;

/** The modules a handler imports by name: `catalyst_tool` in Python, `catalyst-tool` in Node. */
export const TOOL_CODE_LIBRARY: readonly { path: string; content: string }[] = [
  { path: "catalyst_tool.py", content: PYTHON },
  { path: "catalyst-tool.mjs", content: NODE }
];
