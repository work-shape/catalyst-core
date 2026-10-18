// What a read that comes a page at a time hands a screen: the rows read so far and, while more
// follow, the way to the next page. The page size of the read is its only bound.

/** Present while more follow: loads the next page. */
export interface MoreRead {
  loading: boolean;
  load(): void;
}

/** The rows read so far, and the way to the rest. */
export interface PagedItems<Item> {
  items: readonly Item[];
  more?: MoreRead;
}
