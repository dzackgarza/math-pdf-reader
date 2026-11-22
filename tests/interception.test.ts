import { expect, test } from "bun:test";
import { isPdfResponse } from "../src/extension/interception";
import { captureCases } from "./fixtures/capture-cases";

for (const fixture of captureCases) {
  test(`shared eligibility predicate: ${fixture.name}`, () => {
    expect(isPdfResponse(fixture.url, fixture.headers)).toBe(fixture.eligible);
  });
}
