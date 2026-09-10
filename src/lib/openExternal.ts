import { openBrowserAsync } from "expo-web-browser";
import { Platform } from "react-native";

function webWindow(): any | null {
  try {
    const g = globalThis as any;
    if (Platform.OS === "web" && g?.window && typeof g.window.open === "function") {
      return g.window;
    }
    return null;
  } catch {
    return null;
  }
}

function closeQuietly(popup: any) {
  try {
    if (popup && !popup.closed) popup.close();
  } catch {
    // ignore
  }
}

/**
 * Open an external URL (Stripe checkout, provider login, billing portal).
 *
 * On web, browsers block `window.open` calls that happen after an `await`
 * (the tap gesture is over by then), so the tab is opened synchronously
 * here — before `getUrl()` runs — and navigated once the URL arrives.
 * NOTE: no `noopener` feature flag: with it, Chrome returns a null handle
 * while still opening the tab, leaving an about:blank page we can never
 * navigate. The opened pages (Stripe / UtilityAPI) are trusted.
 * On native it falls through to the in-app browser.
 *
 * Returns true when something was opened, false when there was no URL or the
 * popup was blocked. Re-throws errors from `getUrl()` (closing any blank tab
 * it opened first). Throws if the returned URL is not a valid http(s) URL.
 */
export async function openExternalUrl(getUrl: () => Promise<string>): Promise<boolean> {
  const w = webWindow();
  let popup: any = null;
  try {
    // Open synchronously inside the tap handler so the popup blocker allows it.
    popup = w ? w.open("about:blank", "_blank") : null;
  } catch (e) {
    console.warn("openExternalUrl: window.open failed:", e);
    popup = null;
  }
  try {
    const url = await getUrl();
    console.log("openExternalUrl: got URL, navigating:", typeof url === "string" ? url.slice(0, 60) : url);
    if (typeof url !== "string" || !/^https?:\/\/.+/i.test(url.trim())) {
      closeQuietly(popup);
      throw new Error(
        `The server did not return a valid checkout URL${url ? ` (got: ${String(url).slice(0, 80)})` : ""}. Check the API deployment and Stripe configuration.`
      );
    }
    const cleanUrl = url.trim();
    if (popup && !popup.closed) {
      popup.location.href = cleanUrl;
      try {
        popup.focus();
      } catch {
        // ignore
      }
      return true;
    }
    // No tab handle (popup blocked, or native) — fall back to in-app browser.
    await openBrowserAsync(cleanUrl);
    return true;
  } catch (e) {
    closeQuietly(popup);
    throw e;
  }
}
