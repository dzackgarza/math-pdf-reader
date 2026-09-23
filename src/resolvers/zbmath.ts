// zbMATH resolver: a Zbl number (bare, `an:`-prefixed, or a zbmath.org search URL) to an
// article entry built from zbMATH Open's document record.
import { z } from "zod";
import {
  cslBibtex,
  fetchOk,
  invariant,
  personName,
  readInput,
  text,
  upstream,
  writeBibtex,
  yearOf,
} from "./contract";

const AN_PREFIX = /^an:/i;

const OptionalTextSchema = z.string().nullable().optional();

// The journal (serial) or book series the article appeared in, with its volume and issue.
const SourceEntrySchema = z.object({
  title: z.string(),
  volume: OptionalTextSchema,
  issue: OptionalTextSchema,
});

const DocumentSchema = z.object({
  database: z.literal("Zbl"),
  document_type: z.object({ code: z.literal("j") }),
  title: z.object({ title: z.string(), subtitle: OptionalTextSchema }),
  year: z.string(),
  contributors: z.object({ authors: z.array(z.object({ name: z.string() })).min(1) }),
  links: z.array(z.object({ type: z.string(), identifier: z.string() })),
  source: z.object({
    serial: z.array(SourceEntrySchema).nullish(),
    series: z.array(SourceEntrySchema).nullish(),
    pages: OptionalTextSchema,
  }),
});

const SearchSchema = z.object({
  status: z.object({ status_code: z.literal(200), nr_total_results: z.literal(1) }),
  result: z.tuple([DocumentSchema]),
});

type ZbmathDocument = z.infer<typeof DocumentSchema>;

function zblNumber(input: string): string {
  if (!/^https?:\/\//i.test(input)) {
    return input.replace(AN_PREFIX, "").trim();
  }
  const query = new URL(input).searchParams.get("q");
  invariant(query !== null && AN_PREFIX.test(query), "zbMATH URL must carry q=an:<number>");
  return query.replace(AN_PREFIX, "").trim();
}

// A present, non-blank optional field, normalized; absent or blank stays absent.
function optionalText(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value.trim() === "" ? undefined : text(value);
}

function articleBibtex(document: ZbmathDocument, zbl: string): string {
  const [journal] = [document.source.serial, document.source.series]
    .filter((entries) => Array.isArray(entries))
    .flat();
  invariant(journal !== undefined, "zbMATH article carries no serial or series source");
  const title = text(document.title.title);
  const subtitle = optionalText(document.title.subtitle);
  return cslBibtex({
    id: `zbl_${zbl.replaceAll(".", "_")}`,
    type: "article-journal",
    title: subtitle === undefined ? title : `${title}: ${subtitle}`,
    author: document.contributors.authors.map((author) => personName(author.name)),
    "container-title": text(journal.title),
    issued: { "date-parts": [[yearOf(document.year)]] },
    DOI: document.links.find((link) => link.type === "doi")?.identifier,
    volume: optionalText(journal.volume),
    issue: optionalText(journal.issue),
    page: optionalText(document.source.pages),
  });
}

const zbl = zblNumber(await readInput());
const search = upstream("/v1/document/_search");
search.searchParams.set("search_string", `an:${zbl}`);
search.searchParams.set("results_per_page", "1");
const found = SearchSchema.parse(await (await fetchOk(search, "application/json")).json());
writeBibtex(articleBibtex(found.result[0], zbl));
