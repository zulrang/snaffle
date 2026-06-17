import type { Brand } from "./brand";
import { err, ok, type Result } from "./result";

/**
 * Value objects shared across aggregates: identifiers, content addresses, and
 * timestamps. All are immutable and constructed only through validating smart
 * constructors, so an invalid instance cannot exist.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export interface EmptyIdError {
  readonly kind: "empty_id";
  readonly field: string;
}

/**
 * Build a validating smart constructor for a branded string id. Each aggregate
 * declares its own id type (`LineageId`, `GenerationId`, …) sharing this helper,
 * so ids of different aggregates never unify even though both are strings.
 */
export const idConstructor =
  <Tag extends string>(field: Tag) =>
  (raw: string): Result<Brand<string, Tag>, EmptyIdError> => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return err({ kind: "empty_id", field });
    return ok(trimmed as Brand<string, Tag>);
  };

// ---------------------------------------------------------------------------
// Content address (D10 / D20 / D21: content-addressed provenance & snapshots)
// ---------------------------------------------------------------------------

/** A SHA-256 content address, normalized to 64 lowercase hex characters. */
export type ContentHash = Brand<string, "ContentHash">;

export interface MalformedContentHashError {
  readonly kind: "malformed_content_hash";
  readonly value: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export const parseContentHash = (raw: string): Result<ContentHash, MalformedContentHashError> => {
  const normalized = raw.trim().toLowerCase();
  if (!SHA256_HEX.test(normalized)) {
    return err({ kind: "malformed_content_hash", value: raw });
  }
  return ok(normalized as ContentHash);
};

/** True when two content addresses are bit-for-bit identical. */
export const contentHashEquals = (a: ContentHash, b: ContentHash): boolean => a === b;

// ---------------------------------------------------------------------------
// Timestamp
// ---------------------------------------------------------------------------

/** A point in time as integer epoch milliseconds (UTC). */
export type Timestamp = Brand<number, "Timestamp">;

export interface InvalidTimestampError {
  readonly kind: "invalid_timestamp";
  readonly value: number;
}

export const parseTimestamp = (epochMillis: number): Result<Timestamp, InvalidTimestampError> => {
  if (!Number.isInteger(epochMillis) || epochMillis < 0) {
    return err({ kind: "invalid_timestamp", value: epochMillis });
  }
  return ok(epochMillis as Timestamp);
};

export const timestampFromDate = (date: Date): Result<Timestamp, InvalidTimestampError> =>
  parseTimestamp(date.getTime());
