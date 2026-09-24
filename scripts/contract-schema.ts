// Prints the JSON Schema of every zod schema the contract modules export, as one document
// whose `$defs` name each schema after its export (`BucketItemSchema` is `BucketItem`).
// The server crate's build script generates its Rust types from this document (typify).
//
// Four rewrites keep typify's types as strict as the zod schemas:
// - a date-time keeps only `format: date-time`: zod adds a pattern that typify would turn
//   into a new string type per field, where the crate maps the format to one timestamp type;
// - a `const` becomes a one-value `enum`, which typify types as an enum instead of `String`;
// - a record keyed by an enum (zod requires every key) becomes an object with those properties;
// - every enum and object nested inside a definition gets a `title` naming its path
//   (`Rule` + `Tag` + `Operator`), because typify names nested types from their property
//   alone and merges two nested types that share a name.
import { z } from "zod";
import * as capture from "../src/contract/capture";
import * as config from "../src/contract/config";
import * as extraction from "../src/contract/extraction";
import * as files from "../src/contract/files";
import * as library from "../src/contract/library";
import * as store from "../src/contract/store";
import * as text from "../src/contract/text";

type JsonSchema = { [keyword: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonValue[] | JsonSchema;

const registry = z.registry<{ id: string }>();
for (const module of [text, capture, config, extraction, library, files, store]) {
  for (const [name, value] of Object.entries(module)) {
    if (name.endsWith("Schema") && value instanceof z.ZodType && !registry.has(value)) {
      registry.add(value, { id: name.slice(0, -"Schema".length) });
    }
  }
}

const exported = z.toJSONSchema(registry, {
  uri: (id) => `#/$defs/${id}`,
  unrepresentable: "throw",
  override: ({ jsonSchema }) => {
    if (jsonSchema.format === "date-time") {
      delete jsonSchema.pattern;
    }
    if (jsonSchema.const !== undefined) {
      jsonSchema.enum = [jsonSchema.const];
      if (typeof jsonSchema.const === "number") {
        jsonSchema.type = "integer";
      }
      delete jsonSchema.const;
    }
  },
});

function isSchema(value: JsonValue | undefined): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pascal(word: string): string {
  return word
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

// The value of the property that tells a union's variants apart, when the variant has one.
function discriminator(variant: JsonSchema): string | undefined {
  const properties = variant.properties;
  if (!isSchema(properties)) {
    return undefined;
  }
  for (const property of Object.values(properties)) {
    if (isSchema(property) && Array.isArray(property.enum) && property.enum.length === 1) {
      return String(property.enum[0]);
    }
  }
  return undefined;
}

function exhaustiveRecord(schema: JsonSchema): void {
  const names = schema.propertyNames;
  if (!isSchema(names) || !Array.isArray(names.enum) || !isSchema(schema.additionalProperties)) {
    return;
  }
  const value = schema.additionalProperties;
  schema.properties = Object.fromEntries(names.enum.map((name) => [String(name), value]));
  schema.additionalProperties = false;
  delete schema.propertyNames;
}

function name(schema: JsonSchema, path: string, nested: boolean): void {
  exhaustiveRecord(schema);
  if (nested && schema.$ref === undefined && (schema.enum !== undefined || schema.type === "object" || schema.oneOf !== undefined)) {
    schema.title = path;
  }
  if (isSchema(schema.properties)) {
    for (const [property, child] of Object.entries(schema.properties)) {
      if (isSchema(child)) {
        name(child, path + pascal(property), true);
      }
    }
  }
  for (const keyword of ["oneOf", "anyOf"]) {
    const variants = schema[keyword];
    if (Array.isArray(variants)) {
      variants.forEach((variant, index) => {
        if (isSchema(variant)) {
          name(variant, path + pascal(discriminator(variant) ?? `Variant${index}`), true);
        }
      });
    }
  }
  if (isSchema(schema.items)) {
    name(schema.items, `${path}Item`, true);
  }
  if (isSchema(schema.additionalProperties)) {
    name(schema.additionalProperties, `${path}Value`, true);
  }
}

const definitions: Record<string, JsonSchema> = {};
for (const [id, { $schema, ...schema }] of Object.entries(exported.schemas)) {
  const definition = schema as JsonSchema;
  name(definition, id, false);
  definitions[id] = definition;
}
process.stdout.write(
  `${JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", $defs: definitions }, null, 2)}\n`,
);
