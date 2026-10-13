/** What one part of the seed did: how many things it made, and how many were there already. */
export interface SeedStep {
  name: string;
  created: number;
  existing: number;
  note?: string;
}
