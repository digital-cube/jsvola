// Apostrophes vanish without leaving a separator: "O'Brien" → "OBRIEN", not "O_BRIEN".
const APOSTROPHES = /['’‘ʼ]/g;
// Letters NFKD does not decompose, transliterated the way their languages do (Đorđe → Djordje).
const LETTERS: Record<string, string> = {
  Đ: "Dj",
  đ: "dj",
  Ø: "O",
  ø: "o",
  Ł: "L",
  ł: "l",
  ß: "ss",
  Æ: "AE",
  æ: "ae",
};

/**
 * Maps a free-form value to an UPPER_SNAKE_CASE term: `"São Tomé"` → `SAO_TOME`, `"Đorđe"` → `DJORDJE`,
 * `"user"` → `USER`, `"ticket-closed"` → `TICKET_CLOSED`. Returns `""` when nothing
 * alphanumeric is left. Same pipeline as dc-lookups' `normalize_candidate_value`.
 */
export function normalizeTerm(raw: string): string {
  return raw
    .trim()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(APOSTROPHES, "")
    .replace(/[ĐđØøŁłßÆæ]/g, (ch) => LETTERS[ch] as string)
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}
