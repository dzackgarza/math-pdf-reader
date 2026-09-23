// Reports the linking page and link text of every followed link to the background, before
// the navigation that may turn out to be a PDF. The message is dispatched synchronously on
// click, so it survives the page unloading.
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import type { RuntimeMessage } from "../messages";

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_start",
  main() {
    const report = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || !/^https?:$/.test(anchor.protocol)) {
        return;
      }
      const message: RuntimeMessage = {
        type: "remember-link",
        href: anchor.href,
        origin: {
          source_url: location.href,
          link_text: anchor.innerText.replace(/\s+/g, " ").trim(),
          page_title: document.title.trim(),
          recorded_at: Date.now(),
        },
      };
      void browser.runtime.sendMessage(message);
    };
    document.addEventListener("click", report, true);
    document.addEventListener("auxclick", report, true);
  },
});
