// The last attempt of an action per item key, for actions whose progress and outcome the
// inspector shows (a send, an extraction run). Setting null clears the item's attempt.
import { useCallback, useState } from "react";

export function useKeyedAttempts<T>() {
  const [attempts, setAttempts] = useState<ReadonlyMap<string, T>>(new Map());
  const setAttempt = useCallback((key: string, attempt: T | null) => {
    setAttempts((current) => {
      const next = new Map(current);
      if (attempt === null) {
        next.delete(key);
      } else {
        next.set(key, attempt);
      }
      return next;
    });
  }, []);
  return [attempts, setAttempt] as const;
}
