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
