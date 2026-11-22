export type RecoveryCase = {
  key: string;
  recoverable: boolean;
};

// The controlled recovery corpus used to measure SC-003. A fixture is recoverable when
// at least one original or mirror source is expected to serve the captured bytes.
export const recoveryCases: RecoveryCase[] = [
  { key: "kept-url", recoverable: true },
  { key: "moved", recoverable: true },
  { key: "lost", recoverable: false },
];
