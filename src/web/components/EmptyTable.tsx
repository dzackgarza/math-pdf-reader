// What the table says when it has no rows: the bucket is empty, the search excludes
// everything, or nothing has been filed under this view yet.
export default function EmptyTable({
  bucketEmpty,
  searching,
  onClearSearch,
}: {
  bucketEmpty: boolean;
  searching: boolean;
  onClearSearch: () => void;
}) {
  if (bucketEmpty) {
    return (
      <>
        <p className="text-base font-semibold">No PDFs in the bucket yet</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">
          Open a PDF link in Chrome or Firefox with the capture extension installed; the PDF is
          stored here with where it came from.
        </p>
      </>
    );
  }
  if (searching) {
    return (
      <>
        <p className="text-base font-semibold">No PDFs match</p>
        <button
          type="button"
          onClick={onClearSearch}
          className="mt-3 rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-surface"
        >
          Clear the search
        </button>
      </>
    );
  }
  return (
    <>
      <p className="text-base font-semibold">Nothing here yet</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted">
        File PDFs here from their details in the library.
      </p>
    </>
  );
}
