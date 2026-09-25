// A response body read as text and checked against a schema, with a body that is not JSON
// reported as a schema failure instead of a thrown SyntaxError. The string-to-JSON codec is
// zod's own `jsonCodec` recipe (zod.dev/codecs, "Useful codecs"), with its target narrowed from
// the checked schema to `z.json()` so the parsed value is typed before the schema sees it.
import { z } from "zod";

const JsonTextSchema = z.codec(z.string(), z.json(), {
  decode: (text, ctx) => {
    try {
      return z.json().parse(JSON.parse(text));
    } catch (error) {
      ctx.issues.push({
        code: "invalid_format",
        format: "json",
        input: text,
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  },
  encode: (value) => JSON.stringify(value),
});

export type Checked<T> = { ok: true; value: T } | { ok: false; detail: string };

// The body of RESPONSE checked against SCHEMA; a read failure or a mismatch names the body.
export async function checkedBody<T extends z.core.$ZodType>(
  response: Response,
  schema: T,
): Promise<Checked<z.output<T>>> {
  const text = await response.text().then(
    (body) => ({ ok: true as const, body }),
    (error: unknown) => ({ ok: false as const, detail: String(error) }),
  );
  if (!text.ok) {
    return { ok: false, detail: `the body could not be read (${text.detail})` };
  }
  const json = JsonTextSchema.safeDecode(text.body);
  const parsed = json.success ? z.safeParse(schema, json.data) : json;
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, detail: `${z.prettifyError(parsed.error)}\n${text.body.slice(0, 500)}` };
}
