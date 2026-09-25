// The string kinds the contracts share, named once so every field of a kind has one type.
import { z } from "zod";

export const NonEmptySchema = z.string().min(1);

// Names, tags and notes: surrounding whitespace is dropped, and nothing may remain empty.
export const TrimmedSchema = z.string().trim().min(1);

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
