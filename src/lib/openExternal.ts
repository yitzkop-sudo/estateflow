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

/**
 * Open an external URL (Stripe checkout, provider login, billing portal).
 *
 * On web, browsers block `window.open` calls that happen after an `await`
 * (the tap gesture is over by then), so the blank tab is opened
 * synchronously here — before `getUrl()` runs — and navigated once the URL
 * arrives. On native it falls through to the in-app browser.
 *
 * Returns true when something was opened, false when there was no URL or the
 * popup was blocked. Re-throws errors from `getUrl()` (closing any blank tab
 * it opened first).
 */
export async function openExternalUrl(getUrl: () => Promise<string>): Promise<boolean> {
  const w = webWindow();
  let popup: any = null;
  try {
    popup = w ? w.open("", "_blank", "noopener") : null;
  } catch {
    popup = null;
  }
  try {
    const url = await getUrl();
    if (!url) {
      try {
        if (popup && !popup.closed) popup.close();
      } catch {
        // ignore
      }
      return false;
    }
    if (popup && !popup.closed) {
      popup.location.href = url;
      try {
        popup.focus();
      } catch {
        // ignore
      }
      return true;
    }
    await openBrowserAsync(url);
    return true;
  } catch (e) {
    try {
      if (popup && !popup.closed) popup.close();
    } catch {
      // ignore
    }
    throw e;
  }
}
