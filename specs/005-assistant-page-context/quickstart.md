# Validate assistant paper context

Run the bucket with `just provision`. Open the library on port 8770 and use the
paper's assistant pane for these checks.

## Acceptance scenarios

1. Open a PDF-only paper. Inspect the session location and confirm that the original
   PDF is present and readable. If the configured tools cannot read its content,
   the assistant reports that limitation.
2. Open an enriched paper. Ask for a passage that requires searching the Markdown.
   Observe a shell command run from the paper directory and verify the answer
   against the passage read there.
3. Display a page whose text layer garbles a formula. Check the reported page number
   and the label on any snippet. Ask about the formula and compare the answer with
   the PDF or the structured extraction.
4. Place an unregistered artifact with unique contents in the directory after the
   chat opens. Verify that the same conversation reads it and returns those contents.
