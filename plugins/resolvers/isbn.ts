// ISBN resolver: an ISBN to a book entry built from Open Library's edition record and the
// records of its authors.
import { z } from "zod";
import {
  cslBibtex,
  fetchOk,
  personName,
  readInput,
  text,
  upstream,
  writeBibtex,
  yearOf,
} from "./contract";

const EditionSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  authors: z.array(z.object({ key: z.string().regex(/^\/authors\/OL\w+A$/) })).min(1),
  publishers: z.tuple([z.string()]).rest(z.string()),
  publish_date: z.string(),
});

const AuthorSchema = z.object({ name: z.string() });

async function json(path: string): Promise<unknown> {
  return (await fetchOk(upstream(path), "application/json")).json();
}

const isbn = (await readInput()).replace(/^isbn:?\s*/i, "").replace(/[-\s]/g, "");
const edition = EditionSchema.parse(await json(`/isbn/${isbn}.json`));
const authors = await Promise.all(
  edition.authors.map(async (author) => AuthorSchema.parse(await json(`${author.key}.json`)).name),
);
const title =
  edition.subtitle === undefined
    ? text(edition.title)
    : `${text(edition.title)}: ${text(edition.subtitle)}`;

writeBibtex(
  cslBibtex({
    id: `isbn_${isbn}`,
    type: "book",
    title,
    author: authors.map(personName),
    publisher: text(edition.publishers[0]),
    issued: { "date-parts": [[yearOf(edition.publish_date)]] },
    ISBN: isbn,
  }),
);
