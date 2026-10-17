import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefObject
} from "react";

/*
 * How a table folds the columns that do not fit. A head with a priority registers its column;
 * the table measures every column at its full width and folds the least important ones until
 * the rest fit its box. A folded column's head and cells stay in the table, hidden, and each
 * cell also shows its value in the details of its row, under the head's label. The hidden cells
 * are what the table measures, so a folded value that changes is measured as it is now. The
 * table measures again whenever it renders and whenever its box changes width.
 */

/** A column that folds when the table runs out of room. */
interface FoldableColumn {
  /** The higher the number, the sooner the column folds. */
  priority: number;
  /** The head's content, which names the column's value in a row's details. */
  label: ReactNode;
}

interface FoldedColumn {
  index: number;
  label: ReactNode;
}

interface TableFoldContextValue {
  register(index: number, column: FoldableColumn): () => void;
  /** The folded columns, in column order. */
  folded: readonly FoldedColumn[];
}

interface TableRowFoldContextValue {
  /** Where each folded cell of the row shows its value, by column. */
  slots: ReadonlyMap<number, HTMLElement>;
  setSlot(index: number, node: HTMLElement | null): void;
}

export const TableFoldContext = createContext<TableFoldContextValue | undefined>(undefined);
/** The position of a head or cell in its row, which is its column. */
export const TableColumnContext = createContext<number | undefined>(undefined);
export const TableRowFoldContext = createContext<TableRowFoldContextValue | undefined>(undefined);

const noColumns: ReadonlyMap<number, FoldableColumn> = new Map();
const noFolds: readonly number[] = [];
const noSlots: ReadonlyMap<number, HTMLElement> = new Map();

/**
 * The columns to fold so the rest fit `available`: the highest priority number first, and of
 * two equal ones the later column. `natural` is the width of every column at its full width.
 */
function columnsToFold(
  columns: ReadonlyMap<number, FoldableColumn>,
  widths: ReadonlyMap<number, number>,
  natural: number,
  available: number
): readonly number[] {
  const order = [...columns]
    .sort(([left, a], [right, b]) => b.priority - a.priority || right - left)
    .map(([index]) => index);
  const folded: number[] = [];
  let needed = natural;
  for (const index of order) {
    // Widths are fractional; the box's is whole.
    if (needed - available < 1) {
      break;
    }
    folded.push(index);
    needed -= widths.get(index) ?? 0;
  }
  return folded.length === 0 ? noFolds : folded.sort((a, b) => a - b);
}

function sameIndexes(first: readonly number[], second: readonly number[]): boolean {
  return first.length === second.length && first.every((index, at) => second[at] === index);
}

/** The folding of one table, measured on the table inside its box. */
export function useColumnFolding(
  box: RefObject<HTMLElement | null>,
  table: RefObject<HTMLTableElement | null>
): TableFoldContextValue {
  const [columns, setColumns] = useState(noColumns);
  const [foldedIndexes, setFoldedIndexes] = useState(noFolds);

  const register = useCallback((index: number, column: FoldableColumn) => {
    setColumns((current) => new Map(current).set(index, column));
    return () =>
      setColumns((current) => {
        const next = new Map(current);
        next.delete(index);
        return next;
      });
  }, []);

  const fit = useCallback(() => {
    const boxNode = box.current;
    const tableNode = table.current;
    if (!boxNode || !tableNode || columns.size === 0) {
      return;
    }
    // Every column shown, at max-content each takes its full width and the table their sum.
    // Nothing paints in between: the folded cells hide again before this returns.
    const hidden = [...tableNode.querySelectorAll<HTMLElement>("[data-folded]")];
    for (const cell of hidden) {
      delete cell.dataset.folded;
    }
    const width = tableNode.style.width;
    tableNode.style.width = "max-content";
    const natural = tableNode.getBoundingClientRect().width;
    const widths = new Map<number, number>();
    for (const head of tableNode.querySelectorAll<HTMLElement>("thead th[data-column]")) {
      widths.set(Number(head.dataset.column), head.getBoundingClientRect().width);
    }
    tableNode.style.width = width;
    for (const cell of hidden) {
      cell.dataset.folded = "";
    }
    const next = columnsToFold(columns, widths, natural, boxNode.clientWidth);
    setFoldedIndexes((current) => (sameIndexes(current, next) ? current : next));
  }, [box, table, columns]);

  // After every render: rows, values and labels change the widths. Before paint, so a table
  // never shows the columns it is about to fold.
  useLayoutEffect(fit);

  const foldable = columns.size > 0;
  useEffect(() => {
    const boxNode = box.current;
    if (!foldable || !boxNode || typeof ResizeObserver === "undefined") {
      return;
    }
    let width = boxNode.clientWidth;
    const observer = new ResizeObserver(() => {
      // Folding changes the height of the box; only a change of width asks for another fit.
      if (boxNode.clientWidth !== width) {
        width = boxNode.clientWidth;
        fit();
      }
    });
    observer.observe(boxNode);
    return () => observer.disconnect();
  }, [box, foldable, fit]);

  const folded = useMemo(
    () =>
      foldedIndexes.flatMap((index) => {
        const column = columns.get(index);
        return column ? [{ index, label: column.label }] : [];
      }),
    [foldedIndexes, columns]
  );
  return useMemo(() => ({ register, folded }), [register, folded]);
}

/** Where the folded cells of one row show their values. */
export function useRowFolding(): TableRowFoldContextValue {
  const [slots, setSlots] = useState(noSlots);
  const setSlot = useCallback((index: number, node: HTMLElement | null) => {
    setSlots((current) => {
      if ((current.get(index) ?? null) === node) {
        return current;
      }
      const next = new Map(current);
      if (node) {
        next.set(index, node);
      } else {
        next.delete(index);
      }
      return next;
    });
  }, []);
  return useMemo(() => ({ slots, setSlot }), [slots, setSlot]);
}

/** Whether the head or cell in this column is folded, and what it needs either way. */
export function useColumnFold(): {
  index: number | undefined;
  fold: TableFoldContextValue | undefined;
  folded: boolean;
} {
  const index = useContext(TableColumnContext);
  const fold = useContext(TableFoldContext);
  const folded =
    index !== undefined && (fold?.folded.some((column) => column.index === index) ?? false);
  return { index, fold, folded };
}

/** The details of a row: each folded column's label, and the slot its cell fills. */
export function FoldedValues({ columns }: { columns: readonly FoldedColumn[] }) {
  const row = useContext(TableRowFoldContext);
  if (!row || columns.length === 0) {
    return null;
  }
  return (
    <dl
      data-slot="table-row-detail"
      // The details wrap in the room the column has and never widen it.
      className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-caption [contain:inline-size]"
    >
      {columns.map((column) => (
        <FoldedValue
          key={column.index}
          index={column.index}
          label={column.label}
          setSlot={row.setSlot}
        />
      ))}
    </dl>
  );
}

function FoldedValue({
  index,
  label,
  setSlot
}: {
  index: number;
  label: ReactNode;
  setSlot(index: number, node: HTMLElement | null): void;
}) {
  const slot = useCallback((node: HTMLElement | null) => setSlot(index, node), [index, setSlot]);
  // A value wider than the room beside its label wraps under it, so a column narrowed to a
  // phone's width never spills a folded value over the next column.
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd ref={slot} className="min-w-0" />
    </div>
  );
}
