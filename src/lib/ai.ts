/**
 * EstateFlow AI engine — cloud-first, offline fallback.
 *
 * askAssistant() tries POST /ai-chat (server LLM when OPENAI_API_KEY or
 * GEMINI_API_KEY is configured), passing recent conversation turns so
 * follow-up questions keep context. Any failure → answerLocally() using
 * the built-in knowledge base, so the assistant always works for free.
 */
import { apiPost } from "./api";
import { QUICK_QUESTIONS, buildAIContext, calculateWithContext, searchKnowledge, suggestTopics, type PortfolioContext } from "./ai-knowledge";

export type AIMessage = { id: string; role: "user" | "assistant"; text: string };

export { type PortfolioContext } from "./ai-knowledge";

export { QUICK_QUESTIONS };

/** One past conversation turn (what we send to the cloud model). */
export type AIHistoryTurn = { role: "user" | "assistant"; text: string };

const uid = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

export function makeUserMessage(text: string): AIMessage {
  return { id: uid(), role: "user", text };
}

export function makeAssistantMessage(text: string): AIMessage {
  return { id: uid(), role: "assistant", text };
}

function contextLine(ctx?: PortfolioContext): string {
  if (!ctx) return "";
  const parts: string[] = [];
  if (typeof ctx.propertyCount === "number")
    parts.push(`You currently track ${ctx.propertyCount} ${ctx.propertyCount === 1 ? "property" : "properties"}`);
  if (typeof ctx.tenantCount === "number")
    parts.push(`${ctx.tenantCount} ${ctx.tenantCount === 1 ? "tenant" : "tenants"}`);
  if (typeof ctx.monthlyIncome === "number" && ctx.monthlyIncome > 0)
    parts.push(`about $${Math.round(ctx.monthlyIncome).toLocaleString()}/mo income`);
  if (typeof ctx.monthlyExpense === "number" && ctx.monthlyExpense > 0)
    parts.push(`$${Math.round(ctx.monthlyExpense).toLocaleString()}/mo expenses`);
  if (typeof ctx.overdueCount === "number" && ctx.overdueCount > 0)
    parts.push(`${ctx.overdueCount} overdue rent${ctx.overdueCount === 1 ? "" : "s"}`);
  if (typeof ctx.portfolioValue === "number" && ctx.portfolioValue > 0)
    parts.push(`$${Math.round(ctx.portfolioValue).toLocaleString()} total market value`);
  if (parts.length === 0) return "";
  return `\n\n_(${parts.join(" · ")})_`;
}

function smallTalk(query: string): string | null {
  const q = query.toLowerCase().trim();
  if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/.test(q) && q.length < 30)
    return "Hello! I'm the EstateFlow assistant. Ask me anything about using the app (properties, tenants, rent, utilities, maintenance, payouts) or about real-estate topics like leases, screening, cash flow, financing, taxes — even how to get started. What's on your mind?";
  if (q.includes("thank")) return "You're welcome! Anything else about your properties or property management I can help with?";
  if (q.includes("who are you") || q.includes("your name"))
    return "I'm the EstateFlow assistant — your in-app guide to the app and to property management topics.";
  if (q.includes("what can you do") || q.includes("help me") && q.length < 25)
    return "I can answer questions about the app (adding properties, tenants, rent, utilities, maintenance, payouts, plans) and general real-estate topics (leases, screening, deposits, cap rate, financing, taxes, insurance, evictions). What would you like to know?";
  return null;
}

/** Pure offline answer from the built-in knowledge base. */
export function answerLocally(query: string, ctx?: PortfolioContext): string {
  const q = query.trim();
  if (!q) return "Ask me anything — e.g. 'How do I add a property?' or 'What is cap rate?'";
  const talk = smallTalk(q);
  if (talk) return talk + contextLine(ctx);

  // Financial/portfolio questions with numbers can be worked out offline with
  // the built-in calculator — no LLM needed, no waiting on network.
  const calc = calculateWithContext(q, ctx);
  const hits = searchKnowledge(q, 2);

  if (calc) {
    let text = calc.explanation;
    if (hits.length) text += `\n\nRelated: ${hits[0].title} — ${hits[0].answer.split(". ")[0]}.`;
    return text + contextLine(ctx);
  }

  if (hits.length === 0) {
    // No confident match — suggest the closest topics instead of giving up.
    const near = suggestTopics(q, 4);
    let text =
      "I don't have an exact match for that offline, but I can help with almost anything about the app or real estate. Try rephrasing, or ask me about:";
    if (near.length > 0) {
      text += "\n" + near.map((t) => `• ${t.title}`).join("\n");
    } else {
      text +=
        "\n• Adding properties, tenants, rent & utilities\n• Maintenance, insights, exports & payouts\n• Real-estate basics: leases, screening, deposits, cap rate, financing, taxes";
    }
    text +=
      "\n\nTip: the ☰ menu on the Dashboard reaches every section. (Tip: cloud answers get unlocked when an OpenAI/Gemini key is configured server-side.)";
    return text + contextLine(ctx);
  }
  const [best, second] = hits;
  let text = best.answer;
  if (second && second.id !== best.id) text += `\n\nRelated: ${second.title} — ${second.answer.split(". ")[0]}.`;
  if (best.route) text += `\n\nOpen it: ${best.route} (via the app router / menu).`;
  return text + contextLine(ctx);
}

export type AssistantResult = { text: string; cloud: boolean; provider?: string };

/**
 * Main entry: try the cloud LLM via the app backend (with conversation
 * memory + a grounded local analysis), fall back to local. Never throws —
 * always resolves a displayable string.
 */
export async function askAssistant(
  query: string,
  ctx?: PortfolioContext,
  history?: AIMessage[]
): Promise<AssistantResult> {
  const q = query.trim();
  if (!q) return { text: answerLocally(q, ctx), cloud: false };
  try {
    // Send the most recent turns (excluding the current question) as memory.
    const turns: AIHistoryTurn[] = (history ?? [])
      .filter((m) => m.text.trim())
      .slice(-10)
      .map((m) => ({ role: m.role, text: m.text }));
    const res = await Promise.race([
      apiPost<{ reply?: string; answer?: string; text?: string; provider?: string }>("/ai-chat", {
        message: q,
        context: ctx ?? null,
        history: turns,
        analysis: buildAIContext(q, 2, ctx),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 25000)),
    ]);
    const reply = (res?.reply || res?.answer || res?.text || "").trim();
    if (reply) return { text: reply, cloud: true, provider: res?.provider || undefined };
    return { text: answerLocally(q, ctx), cloud: false };
  } catch {
    // Backend missing / offline / no LLM key → free local brain.
    return { text: answerLocally(q, ctx), cloud: false };
  }
}
