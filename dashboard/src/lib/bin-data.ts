/**
 * Shape of a BIN (bank identification number) entry.
 *
 * The catalogue itself lives server-side in `src/lib/bin-data.ts` and is served
 * over `/api/bin/*`; the dashboard only needs the type to describe responses.
 */
export interface BinEntry {
  bin: string;
  brand: string;
  country: string;
  countryName: string;
  issuer?: string;
  type?: string;
}
