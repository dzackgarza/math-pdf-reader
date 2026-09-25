import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { ActionFailure } from "../actionFailure";
import FailureText from "./FailureText";

// A message at the window's corner: why a call failed, what a call that succeeded could not do,
// or what a call did.
export type ToastMessage =
  | { kind: "failure"; failure: ActionFailure }
  | { kind: "shortfall"; message: string }
  | { kind: "notice"; message: string };

function Body({ toast }: { toast: ToastMessage }) {
  switch (toast.kind) {
    case "failure":
      return <FailureText failure={toast.failure} />;
    case "shortfall":
    case "notice":
      return <span className="flex-1 whitespace-pre-line">{toast.message}</span>;
  }
}

export default function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastMessage;
  onDismiss: () => void;
}) {
  const alert = toast.kind !== "notice";
  return (
    <div
      role={alert ? "alert" : "status"}
      className="fixed right-5 bottom-12 z-50 flex max-w-md items-start gap-2 rounded-lg bg-toast px-4 py-3 text-sm text-white shadow-xl"
    >
      {alert ? (
        <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
      ) : (
        <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-green-300" />
      )}
      <Body toast={toast} />
      <button type="button" onClick={onDismiss} className="text-white/70 hover:text-white">
        Dismiss
      </button>
    </div>
  );
}
