import { z } from "zod";
import { InstanceTypeSchema } from "./files.js";

/** Locales `i18n/translations.csv` carries; `GET /lookups?locale=` falls back to the first. */
export const LOOKUP_LOCALES = ["en", "sr"] as const;
export const LookupLocaleSchema = z.enum(LOOKUP_LOCALES);
export type LookupLocale = z.infer<typeof LookupLocaleSchema>;
export const DEFAULT_LOOKUP_LOCALE: LookupLocale = "en";
/** `?locale=sr` of `GET /lookups`. */
export const LOCALE_QUERY = "locale";

/**
 * The sections of `lookups.yaml`. There is no `InstanceTypes`: an instance type is a free
 * string of the caller and the ones in use come from `GET /instance-types`.
 */
export const LOOKUP_SECTIONS = {
  fileKinds: "FileKinds",
  processingStatuses: "ProcessingStatuses",
  processingKinds: "ProcessingKinds",
  shareScopes: "ShareScopes",
  ocrLanguages: "OcrLanguages",
  encryptionModes: "EncryptionModes",
} as const;
export type LookupSection = (typeof LOOKUP_SECTIONS)[keyof typeof LOOKUP_SECTIONS];

/** The wire form of a term: lower case (`IMAGE` → `image`, as `vola_file.kind` stores it). */
export function lookupWireValue(term: string): string {
  return term.toLowerCase();
}

/** One term of a section: as written in `lookups.yaml`, as sent on the wire, and its label. */
export const LookupEntrySchema = z.object({
  term: z.string().min(1),
  value: z.string().min(1),
  label: z.string().min(1),
});
export type LookupEntry = z.infer<typeof LookupEntrySchema>;

/** `GET /lookups[?locale=]`: every section with its terms, labelled in `locale`. */
export const LookupsResponseSchema = z.object({
  /** The locale the labels are in (the fallback when the one asked for is unknown). */
  locale: LookupLocaleSchema,
  /** Every locale the translations sheet has. */
  locales: z.array(z.string()),
  lookups: z.record(z.string(), z.array(LookupEntrySchema)),
});
export type LookupsResponse = z.infer<typeof LookupsResponseSchema>;

/** One instance type of the tenant with the number of its live files. */
export const InstanceTypeCountSchema = z.object({
  instance_type: InstanceTypeSchema,
  files: z.number().int().nonnegative(),
});
export type InstanceTypeCount = z.infer<typeof InstanceTypeCountSchema>;

/** `GET /instance-types`: the distinct `instance_type` values with live files, sorted. */
export const InstanceTypesResponseSchema = z.object({
  instance_types: z.array(InstanceTypeCountSchema),
});
export type InstanceTypesResponse = z.infer<typeof InstanceTypesResponseSchema>;
