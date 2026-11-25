# Browser Capture Contract

Both browsers implement the same semantic eligibility policy:

1. The navigation is a GET.
2. The response is a top-level document or an eligible subframe.
3. The response is not the bucket's own origin.
4. The response is identified as a PDF by `Content-Type`, a PDF
   `Content-Disposition` filename, or a `.pdf` URL path.
5. Small embedded frames are excluded from capture and remain native.

Chrome uses declarative response-header rules and a download handoff because it
cannot read navigation bodies. Firefox uses blocking response interception and
response streaming. The two paths must submit equivalent capture requests and
produce equivalent success/failure outcomes.

On failure, the browser must show the error and offer an explicit native-open
action. It must not silently drop the navigation or silently retry forever.

After a successful capture, Wayland window focus is handled by the desktop shell
rather than by either browser extension. If focus cannot be obtained in Wayland,
the shell reports that condition without undoing or reclassifying the successful
capture. Other desktop sessions are outside this focus contract.

## Extension background and status page

- Every message to the background gets exactly one reply. An error in the background is a
  `failed` reply at stage `extension`.
- Only the extension's own pages may ask for a capture, an exemption, a tab to be left, or
  tabs to be sent. Content scripts run in web pages and only report followed links. A
  followed link's report names the page for each URL the navigation is redirected to.
- The badge re-reads `/status` every minute between captures (Chrome's alarm floor is 30 s).
  The status check never throws: every answer is read as text and checked against its
  schema. A refused connection or a foreign answer on the port is `unreachable`; the app's
  own error document is `check-failed`.
- Chrome cannot read a download's frame: scripts in a frame whose navigation became a
  download see the document it showed before, because a download commits no document.
- A PDF the browser saved as a download: a frame too small to read in goes back to the
  browser's viewer, which fetches the PDF again. Otherwise the download is deleted once the
  app holds the PDF, and a frame shows the stored item. A failed capture keeps the download
  and shows the failure in the frame, or in a capture page tab for a top-level navigation.
- Send tabs runs in the background, so the work goes on when the popup closes; the popup
  lists the stored result of the last run. The popup is in no tab.
- A stale build refuses a capture or Send tabs before it takes or sends anything; the
  refresh after the refusal's reply starts its replacement.
