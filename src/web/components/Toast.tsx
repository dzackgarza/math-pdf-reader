import { AlertTriangle, CheckCircle2 } from "lucide-react";

// A message at the window's corner: why a call failed, or what a call did.
export type ToastMessage = { kind: "failure" | "notice"; message: string };

export default function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastMessage;
  onDismiss: () => void;
}) {
  return (
    <div
      role={toast.kind === "failure" ? "alert" : "status"}
      className="fixed right-5 bottom-12 z-50 flex max-w-md items-start gap-2 rounded-lg bg-toast px-4 py-3 text-sm text-white shadow-xl"
    >
      {toast.kind === "failure" ? (
        <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
      ) : (
        <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-green-300" />
      )}
      <span className="flex-1 whitespace-pre-line">{toast.message}</span>
      <button type="button" onClick={onDismiss} className="text-white/70 hover:text-white">
        Dismiss
      </button>
    </div>
  );
}
