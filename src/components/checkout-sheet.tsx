import { Feather } from "@expo/vector-icons";
import { openBrowserAsync } from "expo-web-browser";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

export interface CheckoutRequest {
  /** Stripe checkout/setup URL to load. */
  url: string;
  /** Sheet header title, e.g. "Subscribe · Electric". */
  title: string;
  /** Smaller header subtitle, e.g. "$20/mo · secure Stripe checkout". */
  subtitle?: string;
  /** Loading overlay text. Defaults to "Loading secure checkout…". */
  loadingText?: string;
  /**
   * Small trust note under the loader. Defaults to "Encrypted by Stripe".
   * Pass null to hide it (non-Stripe pages).
   */
  secureNote?: string | null;
  /** URL fragments meaning "paid" (Stripe success_url landing pages). */
  successMarkers: string[];
  /** URL fragments meaning "canceled" (Stripe cancel_url landing pages). */
  cancelMarkers?: string[];
}

interface Props {
  request: CheckoutRequest | null;
  /** Payment completed inside the sheet (success URL seen). */
  onSuccess: (url: string) => void;
  /**
   * Sheet closed without a success signal. `openedExternally` is true when
   * the device couldn't render the sheet and a browser tab was opened
   * instead — callers should then watch for payment like the legacy flow.
   */
  onCancel: (openedExternally: boolean) => void;
}

function getWebViewComponent(): any | null {
  try {
    // Lazy require: the native view may not exist in this binary
    // (Expo Go / stale dev build) — never import at file top.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("react-native-webview");
    return mod?.WebView ?? mod?.default ?? null;
  } catch {
    return null;
  }
}

/** In-app sheet available = native (not web) + WebView JS resolvable. */
export function isCheckoutSheetAvailable(): boolean {
  if (Platform.OS === "web") return false;
  return getWebViewComponent() !== null;
}

interface BoundaryProps {
  requestKey: string;
  url: string;
  onFallback: () => void;
  children: React.ReactNode;
}

/**
 * Catches a missing native view manager (stale binary) and falls back to a
 * browser tab instead of redboxing.
 */
class WebViewErrorBoundary extends React.Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onFallback();
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

/**
 * Branded in-app Stripe checkout sheet: dark themed header with progress,
 * loading + success states, and automatic success/cancel detection from
 * Stripe's return URLs.
 */
export function CheckoutSheet({ request, onSuccess, onCancel }: Props) {
  const [phase, setPhase] = useState<"loading" | "browsing" | "success">("loading");
  const [progress, setProgress] = useState(0);
  const [webKey, setWebKey] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const doneRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSuccessRef = useRef(onSuccess);
  const onCancelRef = useRef(onCancel);
  onSuccessRef.current = onSuccess;
  onCancelRef.current = onCancel;

  useEffect(() => {
    setPhase("loading");
    setProgress(0);
    setLoadError(null);
    doneRef.current = false;
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [request?.url]);

  const finishOnce = (fn: () => void) => {
    if (doneRef.current) return;
    doneRef.current = true;
    fn();
  };

  const fallbackToBrowser = () => {
    finishOnce(() => {
      if (request) openBrowserAsync(request.url).catch(() => {});
      onCancelRef.current(true);
    });
  };

  const handleNav = (nav: { url?: string }) => {
    if (!request || doneRef.current) return;
    const url = nav?.url || "";
    if (request.successMarkers.some((m) => url.includes(m))) {
      finishOnce(() => {
        setPhase("success");
        timerRef.current = setTimeout(() => onSuccessRef.current(url), 1100);
      });
    } else if ((request.cancelMarkers ?? []).some((m) => url.includes(m))) {
      finishOnce(() => onCancelRef.current(false));
    }
  };

  const WebViewComp = request ? getWebViewComponent() : null;

  useEffect(() => {
    if (request && !WebViewComp) fallbackToBrowser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, WebViewComp]);

  return (
    <Modal
      visible={!!request}
      transparent
      animationType="slide"
      onRequestClose={() => request && finishOnce(() => onCancelRef.current(false))}
    >
      {request ? (
        <View style={s.wrap}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => finishOnce(() => onCancelRef.current(false))}
          />
          <View style={s.sheet}>
            <View style={s.handle} />
            <View style={s.header}>
              <View style={s.lockChip}>
                <Feather name="lock" size={15} color="#34D399" />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.title} numberOfLines={1}>{request.title}</Text>
                <Text style={s.subtitle} numberOfLines={1}>
                  {request.subtitle ?? "Secure Stripe checkout"}
                </Text>
              </View>
              <TouchableOpacity
                style={s.closeBtn}
                onPress={() => finishOnce(() => onCancelRef.current(false))}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Feather name="x" size={18} color="#94A3B8" />
              </TouchableOpacity>
            </View>
            <View style={s.progressTrack}>
              <View style={[s.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
            </View>
            <View style={s.webWrap}>
              {WebViewComp ? (
                <WebViewErrorBoundary
                  key={request.url}
                  requestKey={request.url}
                  url={request.url}
                  onFallback={fallbackToBrowser}
                >
                  <WebViewComp
                    key={webKey}
                    source={{ uri: request.url }}
                    style={s.webview}
                    onLoadProgress={(e: any) => setProgress(e?.nativeEvent?.progress ?? 0)}
                    onLoadEnd={() => {
                      if (!doneRef.current) {
                        setPhase("browsing");
                        setLoadError(null);
                      }
                    }}
                    onError={(e: any) => {
                      if (!doneRef.current) {
                        setLoadError(e?.nativeEvent?.description || "Could not load checkout.");
                      }
                    }}
                    onNavigationStateChange={handleNav}
                    sharedCookiesEnabled
                    thirdPartyCookiesEnabled
                    domStorageEnabled
                    startInLoadingState={false}
                  />
                </WebViewErrorBoundary>
              ) : null}
              {phase === "loading" && !loadError ? (
                <View style={s.overlay}>
                  <ActivityIndicator size="large" color="#3B82F6" />
                  <Text style={s.overlayText}>{request.loadingText ?? "Loading secure checkout…"}</Text>
                  {request.secureNote === null ? null : (
                    <View style={s.secureRow}>
                      <Feather name="shield" size={12} color="#34D399" />
                      <Text style={s.secureText}>{request.secureNote ?? "Encrypted by Stripe"}</Text>
                    </View>
                  )}
                </View>
              ) : null}
              {loadError ? (
                <View style={s.overlay}>
                  <Feather name="alert-circle" size={28} color="#F87171" />
                  <Text style={[s.overlayText, { marginTop: 12 }]}>{loadError}</Text>
                  <TouchableOpacity
                    style={s.retryBtn}
                    onPress={() => {
                      setLoadError(null);
                      setPhase("loading");
                      setWebKey((k) => k + 1);
                    }}
                  >
                    <Text style={s.retryText}>Retry</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.browserBtn} onPress={fallbackToBrowser}>
                    <Text style={s.browserText}>Open in browser instead</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
              {phase === "success" ? (
                <View style={s.overlay}>
                  <View style={s.checkCircle}>
                    <Feather name="check" size={34} color="#FFFFFF" />
                  </View>
                  <Text style={s.successTitle}>Payment complete</Text>
                  <Text style={s.overlayText}>Confirming with our servers…</Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>
      ) : null}
    </Modal>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.6)" },
  sheet: {
    height: "92%",
    backgroundColor: "#0B1120",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: "rgba(59,130,246,0.25)",
    overflow: "hidden",
  },
  handle: {
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: "rgba(148,163,184,0.4)",
    alignSelf: "center",
    marginTop: 10,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
  },
  lockChip: {
    width: 40,
    height: 40,
    borderRadius: 13,
    backgroundColor: "rgba(52,211,153,0.12)",
    borderWidth: 1,
    borderColor: "rgba(52,211,153,0.3)",
    alignItems: "center",
    justifyContent: "center",
  },
  title: { color: "#FFFFFF", fontSize: 17, fontWeight: "900" },
  subtitle: { color: "#64748B", fontSize: 12, fontWeight: "600", marginTop: 2 },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  progressTrack: { height: 3, backgroundColor: "rgba(255,255,255,0.06)" },
  progressFill: { height: "100%", backgroundColor: "#3B82F6" },
  webWrap: { flex: 1, backgroundColor: "#0B1120" },
  webview: { flex: 1, backgroundColor: "#FFFFFF" },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(6,13,28,0.97)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  overlayText: { color: "#94A3B8", fontSize: 14, fontWeight: "600", marginTop: 12, textAlign: "center" },
  secureRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 },
  secureText: { color: "#34D399", fontSize: 12, fontWeight: "700" },
  checkCircle: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: "#10B981",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#10B981",
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  successTitle: { color: "#FFFFFF", fontSize: 20, fontWeight: "900", marginTop: 16 },
  retryBtn: {
    marginTop: 16,
    backgroundColor: "#2563EB",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 14,
  },
  retryText: { color: "#FFFFFF", fontSize: 14, fontWeight: "800" },
  browserBtn: { marginTop: 8, padding: 12 },
  browserText: { color: "#60A5FA", fontSize: 13, fontWeight: "700" },
});
