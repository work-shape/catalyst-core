import { expect, it } from "vitest";
import { sha256Hex } from "@work-shape/catalyst-core/sha256";

it("hashes UTF-8 strings and byte views as lowercase SHA-256 hex", () => {
  expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(sha256Hex("Grüße 🧪\n")).toBe(
    "b53bbcc216941d77fb1d53438af1a3153b5ea72f94ed06de757c8c380e73e129"
  );
  const bytes = Uint8Array.from([1, 0xff, 0, 0x80, 0x61, 2]);
  expect(sha256Hex(bytes.subarray(1, 5))).toBe(
    "7db24bcd8c65b9e0d5c5e147be130fbce7f757295538b0e69888ee7cf545e7ae"
  );
  expect(sha256Hex(Buffer.from(bytes.subarray(1, 5)))).toBe(
    "7db24bcd8c65b9e0d5c5e147be130fbce7f757295538b0e69888ee7cf545e7ae"
  );
});
