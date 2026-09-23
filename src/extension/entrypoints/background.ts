// Capture background. Until milestone M1 cribs the interception rules and the
// capture-bytes client from mathread (extension/mathread/background.ts,
// capture-client.ts), loading this extension fails here instead of pretending to capture.
import { defineBackground } from "wxt/utils/define-background";

export default defineBackground(() => {
  throw new Error("PDF Bucket capture is not implemented: roadmap milestone M1");
});
