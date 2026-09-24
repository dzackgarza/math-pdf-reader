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
  if (searching && !bucketEmpty) {
    return (
      <>
        <p className="text-sm text-muted">No matches</p>
        <button
          type="button"
          onClick={onClearSearch}
          className="mt-3 rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:bg-surface"
        >
          Clear search
        </button>
      </>
    );
  }
  return <p className="text-sm text-muted">{bucketEmpty ? "No PDFs yet" : "Empty"}</p>;
}
