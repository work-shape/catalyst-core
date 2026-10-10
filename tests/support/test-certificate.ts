import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestCertificate {
  /** The certificate of the authority, which a client is told to trust. */
  authority: string;
  key: string;
  certificate: string;
}

/**
 * Makes a certificate authority and a server certificate it signed for `host`, with the
 * system's `openssl`. Both keys are made here and exist for this run only.
 */
export function makeTestCertificate(host: string): TestCertificate {
  const directory = mkdtempSync(join(tmpdir(), "catalyst-test-certificate-"));
  const file = (name: string) => join(directory, name);
  const openssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "pipe" });
  try {
    // Each request takes its name from a file: not every `openssl` honours `-subj` here.
    writeFileSync(
      file("authority.cnf"),
      [
        "[req]",
        "distinguished_name = name",
        "x509_extensions = authority",
        "prompt = no",
        "[name]",
        "CN = Catalyst test authority",
        "[authority]",
        "basicConstraints = critical, CA:TRUE",
        "keyUsage = critical, keyCertSign",
        ""
      ].join("\n")
    );
    writeFileSync(
      file("server.cnf"),
      [
        "[req]",
        "distinguished_name = name",
        "prompt = no",
        "[name]",
        `CN = ${host}`,
        "[server]",
        `subjectAltName = DNS:${host}`,
        ""
      ].join("\n")
    );
    openssl(
      ...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2"],
      ...["-config", file("authority.cnf"), "-keyout", file("ca.key"), "-out", file("ca.crt")]
    );
    openssl(
      ...["req", "-new", "-newkey", "rsa:2048", "-nodes", "-config", file("server.cnf")],
      ...["-keyout", file("server.key"), "-out", file("server.csr")]
    );
    openssl(
      ...["x509", "-req", "-days", "2", "-in", file("server.csr")],
      ...["-CA", file("ca.crt"), "-CAkey", file("ca.key"), "-CAcreateserial"],
      ...["-extfile", file("server.cnf"), "-extensions", "server", "-out", file("server.crt")]
    );
    return {
      authority: readFileSync(file("ca.crt"), "utf8"),
      key: readFileSync(file("server.key"), "utf8"),
      certificate: readFileSync(file("server.crt"), "utf8")
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
