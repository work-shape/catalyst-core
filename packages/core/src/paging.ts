/** A named store fetches at most limit rows after a stable, exclusive key tuple. */
export interface StorePage {
  limit: number;
  after?: readonly (string | number)[];
}
