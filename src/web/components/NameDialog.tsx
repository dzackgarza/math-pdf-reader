import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";

export type NameRequest = {
  title: string;
  label: string;
  submitLabel: string;
  initialName: string;
  onSubmit: (name: string) => void;
};

// Asks for one name: a new collection, a subcollection, a rename, a saved search.
export default function NameDialog({
  request,
  onClose,
}: {
  request: NameRequest;
  onClose: () => void;
}) {
  const [name, setName] = useState(request.initialName);
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/20" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 w-[24rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-white p-5 shadow-2xl outline-none"
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
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="w-full rounded-lg border border-line px-3 py-2 outline-none focus:border-accent"
              />
            </label>
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
