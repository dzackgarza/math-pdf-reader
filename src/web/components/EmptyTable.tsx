export default function EmptyTable({
  bucketEmpty,
  searching,
  viewName,
  onClearSearch,
}: {
  bucketEmpty: boolean;
  searching: boolean;
  viewName: string | null;
  onClearSearch: () => void;
}) {
  if (bucketEmpty) {
    return <p className="text-sm text-muted">No PDFs yet</p>;
  }
  if (searching) {
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
  return (
    <p className="text-sm text-muted">
      {viewName === null ? "No PDF matches this view" : `No PDF matches ${viewName}`}
    </p>
  );
}
