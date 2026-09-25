import { type ActionFailure, describeFailure } from "../actionFailure";

// A failure's heading, then its detail.
export default function FailureText({ failure }: { failure: ActionFailure }) {
  const { title, detail } = describeFailure(failure);
  return (
    <span className="min-w-0 flex-1">
      <strong className="block font-semibold">{title}</strong>
      <span className="block break-words whitespace-pre-line">{detail}</span>
    </span>
  );
}
