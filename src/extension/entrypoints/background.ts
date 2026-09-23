// Capture background. Until the interception rules and the capture client exist, loading
// the extension fails here instead of pretending to capture.
import { defineBackground } from "wxt/utils/define-background";

export default defineBackground(() => {
  throw new Error("PDF Bucket capture is not implemented");
});
