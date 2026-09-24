import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";

export type NameRequest = {
  title: string;
  label: string;
  submitLabel: string;
  initialName: string;
  onSubmit: (name: string) => void;
  // Fills the field from a chooser (a folder path); absent where there is no chooser.
  browse?: () => Promise<string | null>;
};

// Asks for one line of text: a name (collection, subcollection, rename, saved search, tag),
// a URL to import, or a folder path.
export default function NameDialog({
  request,
  onClose,
}: {
  request: NameRequest;
  onClose: () => void;
}) {
  const [name, setName] = useState(request.initialName);
  const [browseError, setBrowseError] = useState<string | null>(null);
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 w-[24rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-panel p-5 shadow-2xl outline-none"
        >
          <Dialog.Title className="text-base font-semibold">{request.title}</Dialog.Title>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              request.onSubmit(name.trim());
              onClose();
            }}
            className="mt-4 space-y-4"
          >
            <label className="block text-sm">
              <span className="mb-1.5 block text-muted">{request.label}</span>
              <span className="flex gap-2">
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-line px-3 py-2 outline-none focus:border-accent"
                />
                {request.browse !== undefined && (
                  <button
                    type="button"
                    onClick={() => {
                      request.browse?.().then(
                        (chosen) => chosen !== null && setName(chosen),
                        (error: Error) => setBrowseError(error.message),
                      );
                    }}
                    className="rounded-lg border border-line px-3 py-2 font-medium hover:bg-surface"
                  >
                    Browse…
                  </button>
                )}
              </span>
            </label>
            {browseError !== null && (
              <p role="alert" className="text-sm text-danger">
                {browseError}
              </p>
            )}
            <div className="flex justify-end gap-2 text-sm">
              <Dialog.Close className="rounded-lg border border-line px-3.5 py-2 font-medium hover:bg-surface">
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={name.trim().length === 0}
                className="rounded-lg bg-accent px-3.5 py-2 font-medium text-white disabled:opacity-40"
              >
                {request.submitLabel}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
