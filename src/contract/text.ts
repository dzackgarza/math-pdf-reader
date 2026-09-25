// The string kinds the contracts share, named once so every field of a kind has one type.
import { z } from "zod";

export const NonEmptySchema = z.string().min(1);

// Names, tags and notes: not empty, and no whitespace before the first or after the last
// character. A pattern rather than a trim, so every reader of the contract (typify's Rust types,
// the server's JSON Schema check) enforces it; clients trim what the user typed.
export const TrimmedSchema = z.string().regex(/^\S(?:[\s\S]*\S)?$/);

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
