import JSZip from "jszip";
import { buildFileTree } from "@work-shape/catalyst-ui";
import { describe, expect, it } from "vitest";
import {
  checkProjectUploads,
  expandProjectUploads,
  formatProjectBytes,
  isSkippedUploadPath,
  projectFilePreviewKind,
  projectMoveTargets,
  projectParentFolder,
  projectPathInFolder,
  readProjectFileChange,
  runLimited,
  takenUploadPaths,
  zipFolderName,
  type ProjectUpload
} from "./support/chat-ui";

// PRJ-2: a project's folder in the interface. The tree comes from the paths; uploads are checked
// against the project's caps before anything is read; a .zip is unpacked into a folder of its
// name; a write of the agent leaves a line with its change.

const roomy = { maxFileBytes: 1_000_000, maxProjectBytes: 10_000_000, usedBytes: 0 };

/** A .zip whose entry declares `declared` bytes while it inflates to what `content` is. */
async function zipDeclaring(name: string, content: string, declared: number): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(name, content, { compression: "DEFLATE" });
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < bytes.length - 4; at += 1) {
    // The local header declares the size at 22, the central directory's at 24.
    const signature = view.getUint32(at, true);
    if (signature === 0x04034b50) view.setUint32(at + 22, declared, true);
    if (signature === 0x02014b50) view.setUint32(at + 24, declared, true);
  }
  const copy = new ArrayBuffer(bytes.length);
  new Uint8Array(copy).set(bytes);
  return copy;
}

const limits = {
  maxFiles: 3,
  maxFileBytes: 100,
  maxProjectBytes: 250,
  versionsPerFile: 20
};

function upload(path: string, size: number): ProjectUpload {
  return { path, size, read: () => Promise.resolve(new File(["x".repeat(size)], path)) };
}

describe("the file tree", () => {
  it("builds folders from the paths, folders first, each level by name", () => {
    const tree = buildFileTree([
      { path: "zeta.md" },
      { path: "notes/b.md" },
      { path: "notes/a.md" },
      { path: "notes/deep/c.txt" },
      { path: "alpha.txt" }
    ]);
    expect(tree.map((node) => `${node.kind}:${node.name}`)).toEqual([
      "folder:notes",
      "file:alpha.txt",
      "file:zeta.md"
    ]);
    const [notes] = tree;
    expect(notes?.kind === "folder" ? notes.path : undefined).toBe("notes/");
    expect(
      notes?.kind === "folder" ? notes.children.map((node) => `${node.kind}:${node.path}`) : []
    ).toEqual(["folder:notes/deep/", "file:notes/a.md", "file:notes/b.md"]);
  });
});

describe("moving a file or folder", () => {
  const paths = ["plan.md", "unterlagen/vertrag.md", "unterlagen/neu/a.md", "bilder/logo.png"];

  it("offers the top level and every folder, a folder never itself or below itself", () => {
    expect(projectMoveTargets(paths, "plan.md")).toEqual([
      "",
      "bilder/",
      "unterlagen/",
      "unterlagen/neu/"
    ]);
    expect(projectMoveTargets(paths, "unterlagen/")).toEqual(["", "bilder/"]);
  });

  it("puts a file or folder into a folder, or on the top level, keeping its name", () => {
    expect(projectPathInFolder("unterlagen/neu/", "")).toBe("neu/");
    expect(projectPathInFolder("unterlagen/vertrag.md", "")).toBe("vertrag.md");
    expect(projectPathInFolder("plan.md", "bilder/")).toBe("bilder/plan.md");
    expect(projectParentFolder("unterlagen/neu/")).toBe("unterlagen/");
    expect(projectParentFolder("plan.md")).toBe("");
  });
});

describe("uploads into a project", () => {
  const empty = { usage: { files: 0, bytes: 0 }, limits, paths: new Set<string>() };

  it("takes what fits", () => {
    expect(checkProjectUploads([upload("a.md", 50), upload("b.md", 50)], empty)).toBeUndefined();
  });

  it("refuses a file larger than a project file may be, naming it", () => {
    expect(checkProjectUploads([upload("a.md", 10), upload("big.pdf", 101)], empty)).toEqual({
      limit: "file_bytes",
      path: "big.pdf",
      size: 101,
      max: 100
    });
  });

  it("refuses more files than the project holds; a taken path adds none", () => {
    const current = { ...empty, usage: { files: 2, bytes: 0 }, paths: new Set(["a.md", "b.md"]) };
    expect(checkProjectUploads([upload("a.md", 1), upload("c.md", 1)], current)).toBeUndefined();
    expect(checkProjectUploads([upload("c.md", 1), upload("d.md", 1)], current)).toEqual({
      limit: "files",
      count: 4,
      max: 3
    });
  });

  it("refuses more bytes than the project holds beside what it holds", () => {
    const current = { ...empty, usage: { files: 1, bytes: 200 } };
    expect(checkProjectUploads([upload("a.md", 60)], current)).toEqual({
      limit: "project_bytes",
      bytes: 260,
      max: 250
    });
  });

  it("names the taken paths with the version each replaces", () => {
    expect(
      takenUploadPaths(
        [upload("a.md", 1), upload("new.md", 1)],
        [
          { path: "a.md", version: 4 },
          { path: "b.md", version: 1 }
        ]
      )
    ).toEqual(new Map([["a.md", 4]]));
  });

  it("leaves out what a system adds beside the files", () => {
    expect(isSkippedUploadPath("__MACOSX/notes/._a.md")).toBe(true);
    expect(isSkippedUploadPath("notes/.DS_Store")).toBe(true);
    expect(isSkippedUploadPath("notes/a.md")).toBe(false);
  });

  it("unpacks a .zip into a folder of its name, without its folders and system files", async () => {
    const zip = new JSZip();
    zip.file("a.md", "hello");
    zip.folder("sub")?.file("b.csv", "1,2");
    zip.file("__MACOSX/._a.md", "x");
    zip.file(".DS_Store", "x");
    const bytes = await zip.generateAsync({ type: "arraybuffer" });
    const archive: ProjectUpload = {
      path: "Unterlagen.zip",
      size: bytes.byteLength,
      read: () => Promise.resolve(new File([bytes], "Unterlagen.zip"))
    };
    const expanded = await expandProjectUploads([archive, upload("plain.txt", 3)], roomy);
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    expect(expanded.uploads.map((entry) => [entry.path, entry.size]).sort()).toEqual([
      ["Unterlagen/a.md", 5],
      ["Unterlagen/sub/b.csv", 3],
      ["plain.txt", 3]
    ]);
    const unpacked = expanded.uploads.find((entry) => entry.path === "Unterlagen/a.md");
    expect(await (await unpacked?.read())?.text()).toBe("hello");
  });

  it("refuses a .zip it cannot open", async () => {
    const broken: ProjectUpload = {
      path: "broken.zip",
      size: 3,
      read: () => Promise.resolve(new File(["abc"], "broken.zip"))
    };
    expect(await expandProjectUploads([broken], roomy)).toEqual({
      ok: false,
      refusal: { limit: "unreadable", path: "broken.zip" }
    });
  });

  it("does not take an entry that ends at another size than it declares", async () => {
    const bytes = await zipDeclaring("a.txt", "x".repeat(900), 3);
    const expanded = await expandProjectUploads(
      [
        {
          path: "lie.zip",
          size: bytes.byteLength,
          read: () => Promise.resolve(new File([bytes], "lie.zip"))
        }
      ],
      roomy
    );
    expect(expanded).toEqual({ ok: false, refusal: { limit: "unreadable", path: "lie.zip" } });
  });

  it("stops an entry that declares less than it inflates at the file cap", async () => {
    const bytes = await zipDeclaring("a.txt", "x".repeat(50_000), 3);
    const expanded = await expandProjectUploads(
      [
        {
          path: "bomb.zip",
          size: bytes.byteLength,
          read: () => Promise.resolve(new File([bytes], "bomb.zip"))
        }
      ],
      { ...roomy, maxFileBytes: 100 }
    );
    expect(expanded).toMatchObject({
      ok: false,
      refusal: { limit: "file_bytes", path: "bomb/a.txt", max: 100 }
    });
    if (!expanded.ok && expanded.refusal.limit === "file_bytes") {
      expect(expanded.refusal.size).toBeGreaterThan(100);
    }
  });

  it("stops an archive whose entries together pass what the project may still hold", async () => {
    const zip = new JSZip();
    zip.file("a.txt", "x".repeat(60));
    zip.file("b.txt", "x".repeat(60));
    const bytes = await zip.generateAsync({ type: "arraybuffer" });
    const expanded = await expandProjectUploads(
      [
        {
          path: "two.zip",
          size: bytes.byteLength,
          read: () => Promise.resolve(new File([bytes], "two.zip"))
        }
      ],
      { maxFileBytes: 100, maxProjectBytes: 250, usedBytes: 150 }
    );
    expect(expanded).toMatchObject({
      ok: false,
      refusal: { limit: "project_bytes", max: 250 }
    });
  });

  it("refuses a .zip with an entry that climbs out of its folder", async () => {
    for (const name of ["../evil.txt", "docs/../../evil.txt", "docs/..\\evil.txt"]) {
      const zip = new JSZip();
      zip.file("fine.txt", "ok");
      zip.file(name, "bad");
      const bytes = await zip.generateAsync({ type: "arraybuffer" });
      const expanded = await expandProjectUploads(
        [
          {
            path: "Ordner.zip",
            size: bytes.byteLength,
            read: () => Promise.resolve(new File([bytes], "Ordner.zip"))
          }
        ],
        roomy
      );
      expect(expanded, name).toEqual({
        ok: false,
        refusal: { limit: "unsafe_path", path: "Ordner.zip" }
      });
    }
  });

  it("names the folder of a .zip without its extension", () => {
    expect(zipFolderName("Angebote.ZIP")).toBe("Angebote");
    expect(zipFolderName("ordner/archiv.zip")).toBe("ordner/archiv");
  });

  it("runs at most two at a time", async () => {
    let running = 0;
    let most = 0;
    await runLimited([1, 2, 3, 4, 5], 2, async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
    });
    expect(most).toBe(2);
  });
});

describe("a project's usage", () => {
  // Intl joins a number and its unit with a space that does not break.
  const size = (bytes: number, locale: "de" | "en") =>
    formatProjectBytes(bytes, locale).replace(/\s/gu, " ");

  it("reads as people read sizes, in the interface's language", () => {
    expect(size(3_400_000, "de")).toBe("3,4 MB");
    expect(size(2_000_000_000, "de")).toBe("2 GB");
    expect(size(1_500, "en")).toBe("1.5 kB");
  });
});

describe("a project file's preview", () => {
  it("shows text, images and PDFs, and only details for anything else", () => {
    expect(projectFilePreviewKind({ path: "a.md", mimeType: "text/markdown" })).toBe("text");
    expect(projectFilePreviewKind({ path: "a.json", mimeType: "application/json" })).toBe("text");
    expect(projectFilePreviewKind({ path: "a.csv", mimeType: "text/csv" })).toBe("text");
    expect(projectFilePreviewKind({ path: "a.png", mimeType: "image/png" })).toBe("image");
    expect(projectFilePreviewKind({ path: "a.svg", mimeType: "image/svg+xml" })).toBe("none");
    expect(projectFilePreviewKind({ path: "a.pdf", mimeType: "application/pdf" })).toBe("pdf");
    expect(projectFilePreviewKind({ path: "a.html", mimeType: "text/html" })).toBe("none");
    expect(
      projectFilePreviewKind({
        path: "a.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      })
    ).toBe("none");
  });
});

describe("the line of an agent's write to a project file", () => {
  const output = (project: unknown) => ({ output: { path: "project/a.md", project } });

  it("reads the change of a write or an edit", () => {
    expect(
      readProjectFileChange({
        toolName: "workspace.edit_file",
        result: output({
          projectId: "asset_1",
          path: "notes/a.md",
          version: 4,
          change: "updated",
          previousVersion: 3
        })
      })
    ).toEqual({
      projectId: "asset_1",
      path: "notes/a.md",
      version: 4,
      change: "updated",
      previousVersion: 3
    });
    expect(
      readProjectFileChange({
        toolName: "workspace.write_file",
        result: output({
          projectId: "asset_1",
          path: "a (Konflikt Agent 28.10. 13.05).md",
          version: 1,
          change: "conflict_copy",
          changed: { path: "a.md", version: 3 }
        })
      })
    ).toMatchObject({ change: "conflict_copy", changed: { path: "a.md", version: 3 } });
  });

  it("is absent for another tool, a failed call or a write outside the project", () => {
    const project = { projectId: "asset_1", path: "a.md", version: 1, change: "created" };
    expect(
      readProjectFileChange({ toolName: "workspace.read_file", result: output(project) })
    ).toBe(undefined);
    expect(
      readProjectFileChange({
        toolName: "workspace.write_file",
        result: output(project),
        isError: true
      })
    ).toBeUndefined();
    expect(
      readProjectFileChange({
        toolName: "workspace.write_file",
        result: { output: { path: "a.md" } }
      })
    ).toBeUndefined();
  });
});
