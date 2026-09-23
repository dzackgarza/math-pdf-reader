// Capture background. The interception rules and the capture-bytes client are cribbed
// from mathread (extension/mathread/background.ts, capture-client.ts) in milestone M1.
export default defineBackground(() => {
  console.info("PDF Bucket capture background loaded");
});
