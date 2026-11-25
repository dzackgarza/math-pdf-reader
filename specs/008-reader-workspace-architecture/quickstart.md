# Quickstart: Reader Workspace Validation

Run each check on the provisioned app (`just provision`, port 8770) after the last change
it covers. The automated forms live in `tests/library-e2e.test.ts`.

1. **Two papers (US1/AC1, AC2, SC-001, SC-005).** Open paper A at page 3, zoom 150%.
   Open paper B at page 5, zoom 80%. Switch A, B, Library, A, B. Each shows its own page
   and zoom. Each switch shows the page in under 2 s.
2. **Sleep (US1/AC3).** Open six papers. The tab shown longest ago sleeps. Show it. It
   opens at the same page, place and zoom.
3. **Active document (US2/AC2, SC-002).** Open A from the library, then show B by its
   tab. The tab row, the address and the library agree that B is active.
4. **Close (US2/AC3).** Write a note in A and close its tab. Reopen A: the note is there
   and the library shows its last viewed page.
5. **Address (FR-006).** In a reader tab, go to page 7. The window address names the
   paper and page 7. Open that address in a new window: it shows page 7.
6. **Save and conflict (US3/AC1, AC2).** Write a note: it saves. Change the PDF from a
   second view, then write a note in the first: an alert shows the conflict and no bytes
   are overwritten.
7. **Reload (US3/AC3, FR-009).** With two tabs open, reload the window. The tabs come
   back at their pages and zoom, with notes present.
