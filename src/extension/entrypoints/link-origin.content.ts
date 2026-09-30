// Reports the link text and the page title of every followed link to the background, before
// the navigation that may turn out to be a PDF. The message is dispatched synchronously on
// click, so it survives the page unloading.
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import type { RuntimeMessage } from "../messages";

// The `utm_source` ChatGPT puts on every link it cites.
const CHATGPT_REFERRAL = "chatgpt.com";

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_start",
  main() {
    const report = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || !/^https?:$/.test(anchor.protocol)) {
        return;
      }
      // A citation in a ChatGPT answer shows the cited site's name, and the page is the chat, so
      // neither text names the document.
      const cited = new URL(anchor.href).searchParams.get("utm_source") === CHATGPT_REFERRAL;
      const message: RuntimeMessage = {
        type: "remember-link",
        href: anchor.href,
        origin: {
          link_text: cited ? "" : anchor.innerText.replace(/\s+/g, " ").trim(),
          page_title: cited ? "" : document.title.trim(),
          recorded_at: Date.now(),
        },
      };
      void browser.runtime.sendMessage(message);
    };
    document.addEventListener("click", report, true);
    document.addEventListener("auxclick", report, true);
  },
});
