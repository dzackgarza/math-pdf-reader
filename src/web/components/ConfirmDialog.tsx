import * as AlertDialog from "@radix-ui/react-alert-dialog";

export type ConfirmRequest = {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
};

export default function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest;
  onClose: () => void;
}) {
  return (
    <AlertDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-scrim" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[26rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-panel p-5 shadow-2xl outline-none">
          <AlertDialog.Title className="text-base font-semibold">{request.title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-muted">
            {request.description}
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2 text-sm">
            <AlertDialog.Cancel className="rounded-lg border border-line px-3.5 py-2 font-medium hover:bg-surface">
              Cancel
            </AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={request.onConfirm}
              className="rounded-lg bg-red-600 px-3.5 py-2 font-medium text-white hover:bg-red-700"
            >
              {request.confirmLabel}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
