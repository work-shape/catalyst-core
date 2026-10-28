import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../cn";

/** One file of a tree. Its folders come from its `/`-separated path. */
export interface FileTreeItem {
  path: string;
  /** Before the name; a file icon where there is none. */
  icon?: ReactNode;
  /** One short line at the row's end, such as the size or when it changed. */
  meta?: ReactNode;
  /** Buttons at the row's end. They are not part of what opens the file. */
  actions?: ReactNode;
  selected?: boolean;
}

export interface FileTreeFolderNode<Item extends FileTreeItem = FileTreeItem> {
  kind: "folder";
  name: string;
  /** The folder's path, ending in `/`. */
  path: string;
  children: FileTreeNode<Item>[];
}

export interface FileTreeFileNode<Item extends FileTreeItem = FileTreeItem> {
  kind: "file";
  name: string;
  path: string;
  item: Item;
}

export type FileTreeNode<Item extends FileTreeItem = FileTreeItem> =
  FileTreeFolderNode<Item> | FileTreeFileNode<Item>;

/**
 * The folders and files of `items`, folders first, each level by name. A path's empty segments
 * are skipped; a file and a folder of the same name both show.
 */
export function buildFileTree<Item extends FileTreeItem>(
  items: readonly Item[]
): FileTreeNode<Item>[] {
  const root: FileTreeFolderNode<Item> = { kind: "folder", name: "", path: "", children: [] };
  const folders = new Map<string, FileTreeFolderNode<Item>>([["", root]]);
  for (const item of items) {
    const segments = item.path.split("/").filter((segment) => segment !== "");
    const name = segments.pop();
    if (name === undefined) continue;
    let parent = root;
    for (const segment of segments) {
      const path = `${parent.path}${segment}/`;
      let folder = folders.get(path);
      if (!folder) {
        folder = { kind: "folder", name: segment, path, children: [] };
        folders.set(path, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }
    parent.children.push({ kind: "file", name, path: item.path, item });
  }
  for (const folder of folders.values()) folder.children.sort(compareNodes);
  return root.children;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareNodes(left: FileTreeNode, right: FileTreeNode): number {
  if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
  return collator.compare(left.name, right.name);
}

export interface FileTreeProps<Item extends FileTreeItem = FileTreeItem> {
  items: readonly Item[];
  onOpen?(item: Item): void;
  /** Buttons at a folder's end, such as renaming it. `path` ends in `/`. */
  folderActions?(path: string): ReactNode;
  /** Folders start open. A folder holding a selected file is always open at first. */
  defaultExpanded?: boolean;
  /** Names the tree for assistive technology. */
  label: string;
  /** Set on every file row, for tests. */
  fileTestId?: string;
  className?: string;
}

/**
 * Files in their folders. A folder unfolds on click, Enter, Space or the right arrow and folds on
 * the left arrow; a file opens on click, Enter or Space.
 */
export function FileTree<Item extends FileTreeItem>({
  items,
  onOpen,
  folderActions,
  defaultExpanded = false,
  label,
  fileTestId,
  className
}: FileTreeProps<Item>) {
  const nodes = buildFileTree(items);
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const selectedFolders = new Set(
    items
      .filter((item) => item.selected)
      .flatMap((item) =>
        item.path
          .split("/")
          .slice(0, -1)
          .map((_, index, segments) => `${segments.slice(0, index + 1).join("/")}/`)
      )
  );
  const isOpen = (path: string) =>
    toggled.get(path) ?? (defaultExpanded || selectedFolders.has(path));
  const setOpen = (path: string, open: boolean) =>
    setToggled((current) => new Map(current).set(path, open));

  const renderNodes = (level: number, children: FileTreeNode<Item>[]): ReactNode =>
    children.map((node) => {
      const indent = { paddingInlineStart: `${level * 1.25 + 0.5}rem` };
      if (node.kind === "folder") {
        const open = isOpen(node.path);
        const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key === "ArrowRight" && !open) {
            event.preventDefault();
            setOpen(node.path, true);
          } else if (event.key === "ArrowLeft" && open) {
            event.preventDefault();
            setOpen(node.path, false);
          }
        };
        const FolderIcon = open ? FolderOpen : Folder;
        return (
          <li key={node.path} className="min-w-0" data-folder={node.path}>
            <div className="group/file-tree-row flex min-w-0 items-center rounded-md transition-colors hover:bg-state-hover">
              <button
                type="button"
                className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md py-1 pr-2 text-left text-body focus-visible:focus-ring"
                style={indent}
                aria-expanded={open}
                onClick={() => setOpen(node.path, !open)}
                onKeyDown={onKeyDown}
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground transition-transform",
                    open && "rotate-90"
                  )}
                />
                <FolderIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate" title={node.name}>
                  {node.name}
                </span>
              </button>
              {folderActions ? (
                <span className="mr-1 flex shrink-0 items-center gap-1 md:opacity-0 md:group-focus-within/file-tree-row:opacity-100 md:group-hover/file-tree-row:opacity-100">
                  {folderActions(node.path)}
                </span>
              ) : null}
            </div>
            {open ? (
              <ul role="group" className="grid min-w-0 gap-0.5">
                {renderNodes(level + 1, node.children)}
              </ul>
            ) : null}
          </li>
        );
      }
      const { item } = node;
      const content = (
        <>
          {/* Aligns a file with the folder names beside it, past the chevron's room. */}
          <span aria-hidden="true" className="size-4 shrink-0" />
          <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
            {item.icon ?? <File aria-hidden="true" className="size-4" />}
          </span>
          <span
            className={cn("min-w-0 flex-1 truncate", item.selected && "font-medium")}
            title={node.name}
          >
            {node.name}
          </span>
          {item.meta === undefined ? null : (
            <span className="shrink-0 text-caption whitespace-nowrap text-muted-foreground">
              {item.meta}
            </span>
          )}
        </>
      );
      const rowClassName =
        "flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md py-1 pr-2 text-left text-body";
      return (
        <li
          key={`file:${node.path}`}
          className="min-w-0"
          data-testid={fileTestId}
          data-path={node.path}
        >
          <div
            className={cn(
              "group/file-tree-row flex min-w-0 items-center rounded-md transition-colors",
              onOpen && "hover:bg-state-hover",
              item.selected && "bg-state-selected hover:bg-state-selected"
            )}
          >
            {onOpen ? (
              <button
                type="button"
                className={cn(rowClassName, "focus-visible:focus-ring")}
                style={indent}
                aria-current={item.selected ? "true" : undefined}
                onClick={() => onOpen(item)}
              >
                {content}
              </button>
            ) : (
              <div className={rowClassName} style={indent}>
                {content}
              </div>
            )}
            {item.actions === undefined ? null : (
              <span className="mr-1 flex shrink-0 items-center gap-1 md:opacity-0 md:group-focus-within/file-tree-row:opacity-100 md:group-hover/file-tree-row:opacity-100">
                {item.actions}
              </span>
            )}
          </div>
        </li>
      );
    });

  return (
    <ul aria-label={label} className={cn("grid min-w-0 gap-0.5", className)}>
      {renderNodes(0, nodes)}
    </ul>
  );
}
