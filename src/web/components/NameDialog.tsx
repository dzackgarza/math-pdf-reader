import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";

export type NameRequest = {
  title: string;
  label: string;
  submitLabel: string;
  initialName: string;
  // Stores the trimmed text; the dialog closes once it resolves and shows why it rejected.
  onSubmit: (name: string) => Promise<void>;
  // Set where an empty text clears a field (a description).
  allowEmpty?: true;
  // Fills the field from a chooser (a folder path); absent where there is no chooser.
  browse?: () => Promise<string | null>;
};

// Asks for one line of text: a name (collection, subcollection, rename, saved search, tag),
// a description, a URL to import, or a folder path. What was typed stays until the server has
// accepted it.
export default function NameDialog({
  request,
  onClose,
}: {
  request: NameRequest;
  onClose: () => void;
}) {
  const [name, setName] = useState(request.initialName);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const submittable = request.allowEmpty === true || name.trim().length > 0;
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
              setSaving(true);
              setFailure(null);
              request.onSubmit(name.trim()).then(onClose, (error: Error) => {
                setSaving(false);
                setFailure(error.message);
              });
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
                        (error: Error) => setFailure(error.message),
                      );
                    }}
                    className="rounded-lg border border-line px-3 py-2 font-medium hover:bg-surface"
                  >
                    Browse…
                  </button>
                )}
              </span>
            </label>
            {failure !== null && (
              <p role="alert" className="text-sm break-words text-danger">
                {failure}
              </p>
            )}
            <div className="flex justify-end gap-2 text-sm">
              <Dialog.Close className="rounded-lg border border-line px-3.5 py-2 font-medium hover:bg-surface">
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={!submittable || saving}
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
