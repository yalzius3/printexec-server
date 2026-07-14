import { BadGatewayException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ANALYTICS_TOOLS, type AnalyticsTool } from "./analytics-tools";
import { AnalyticsService, canUseTool, type AnalyticsAccess } from "./analytics.service";
import type { AskBody } from "./analytics.schemas";

// ════════════════════════════════════════════════════════════════
// AnalyticsAiService — the "Ask" analyst.
//
// Agent loop over the SAME tool registry the dashboard cards use. The model
// NEVER writes SQL and never sees company_id: it picks a registry tool +
// zod-validated params, we execute, it composes the answer. Every executed
// call is returned to the client as an evidence step so the UI can show its
// work.
//
// Provider-agnostic BY DESIGN (owner decision 2026-07-13): a thin adapter
// over the two wire formats that cover practically every LLM API —
//   · "openai"    — OpenAI-compatible /chat/completions (OpenAI, OpenRouter,
//                   Groq, Gemini-compat, local llama.cpp/vLLM, …)
//   · "anthropic" — Anthropic /v1/messages
// Plain fetch, no SDK dependency: the feature is env-gated and optional, so
// it must not add weight to the deploy when it's off.
//
// Env (all optional until the feature is switched on):
//   AI_ANALYST_ENABLED=true      master switch (EMAIL_ENABLED-style gate)
//   AI_PROVIDER=openai|anthropic default openai
//   AI_BASE_URL=…                default per provider
//   AI_API_KEY=…                 required to enable
//   AI_MODEL=…                   required to enable (never hardcoded here)
//   AI_MAX_TOKENS=…              default 1500 (per round)
// ════════════════════════════════════════════════════════════════

const MAX_ROUNDS = 6;
const CALL_TIMEOUT_MS = 60_000;
/** Hard cap on a single tool result as seen by the model. */
const MAX_RESULT_CHARS = 14_000;

interface NeutralToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface NeutralTurn {
  text: string | null;
  toolCalls: NeutralToolCall[];
}

export interface AskStep {
  tool: string;
  params: Record<string, unknown>;
  ok: boolean;
}

interface ProviderAdapter {
  /** Provider-native message list, seeded with history + question. */
  init(system: string, history: { role: "user" | "assistant"; content: string }[], question: string): void;
  call(tools: AnalyticsTool[]): Promise<NeutralTurn>;
  appendToolResults(results: { call: NeutralToolCall; content: string }[]): void;
}

const env = (key: string): string | undefined => {
  const v = process.env[key];
  return v && v.trim() !== "" ? v.trim() : undefined;
};

const truncate = (s: string): string =>
  s.length <= MAX_RESULT_CHARS ? s : `${s.slice(0, MAX_RESULT_CHARS)}… [truncated ${s.length - MAX_RESULT_CHARS} chars]`;

async function providerFetch(url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
    });
  } catch (e) {
    throw new BadGatewayException(
      e instanceof Error && e.name === "TimeoutError"
        ? "The AI provider timed out."
        : "Could not reach the AI provider."
    );
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !payload) {
    // Surface status but never the raw provider body (may echo request/key context).
    throw new BadGatewayException(`AI provider returned ${response.status}.`);
  }
  return payload;
}

// ── OpenAI-compatible /chat/completions ─────────────────────────────────────
class OpenAiCompatAdapter implements ProviderAdapter {
  private messages: Record<string, unknown>[] = [];
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly maxTokens: number
  ) {}

  init(system: string, history: { role: "user" | "assistant"; content: string }[], question: string) {
    this.messages = [
      { role: "system", content: system },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: question }
    ];
  }

  async call(tools: AnalyticsTool[]): Promise<NeutralTurn> {
    const payload = await providerFetch(
      `${this.baseUrl}/chat/completions`,
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        max_tokens: this.maxTokens,
        messages: this.messages,
        tools: tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.jsonSchema }
        })),
        tool_choice: "auto"
      }
    );
    const choice = (payload.choices as { message?: Record<string, unknown> }[] | undefined)?.[0];
    const message = choice?.message ?? {};
    // Echo the assistant turn back verbatim so tool_call ids stay linked.
    this.messages.push(message as Record<string, unknown>);
    const rawCalls = (message.tool_calls as { id?: string; function?: { name?: string; arguments?: string } }[] | undefined) ?? [];
    const toolCalls: NeutralToolCall[] = rawCalls.map((c, i) => {
      let args: Record<string, unknown> = {};
      try {
        args = c.function?.arguments ? (JSON.parse(c.function.arguments) as Record<string, unknown>) : {};
      } catch {
        args = {};
      }
      return { id: c.id ?? `call_${i}`, name: c.function?.name ?? "", args };
    });
    return { text: typeof message.content === "string" ? message.content : null, toolCalls };
  }

  appendToolResults(results: { call: NeutralToolCall; content: string }[]) {
    for (const r of results) {
      this.messages.push({ role: "tool", tool_call_id: r.call.id, content: r.content });
    }
  }
}

// ── Anthropic /v1/messages ──────────────────────────────────────────────────
class AnthropicAdapter implements ProviderAdapter {
  private system = "";
  private messages: Record<string, unknown>[] = [];
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly maxTokens: number
  ) {}

  init(system: string, history: { role: "user" | "assistant"; content: string }[], question: string) {
    this.system = system;
    this.messages = [
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: question }
    ];
  }

  async call(tools: AnalyticsTool[]): Promise<NeutralTurn> {
    const payload = await providerFetch(
      `${this.baseUrl}/v1/messages`,
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      {
        model: this.model,
        max_tokens: this.maxTokens,
        system: this.system,
        messages: this.messages,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.jsonSchema }))
      }
    );
    const content = (payload.content as Record<string, unknown>[] | undefined) ?? [];
    // Echo the assistant content back verbatim (tool_use ids must survive).
    this.messages.push({ role: "assistant", content });
    if (payload.stop_reason === "refusal") {
      return { text: "The AI provider declined to answer this question.", toolCalls: [] };
    }
    const text = content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n")
      .trim();
    const toolCalls: NeutralToolCall[] = content
      .filter((b) => b.type === "tool_use")
      .map((b, i) => ({
        id: typeof b.id === "string" ? b.id : `toolu_${i}`,
        name: typeof b.name === "string" ? b.name : "",
        args: (b.input as Record<string, unknown> | undefined) ?? {}
      }));
    return { text: text || null, toolCalls };
  }

  appendToolResults(results: { call: NeutralToolCall; content: string }[]) {
    // All tool_result blocks for a turn go in ONE user message.
    this.messages.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.call.id,
        content: r.content
      }))
    });
  }
}

// ════════════════════════════════════════════════════════════════

@Injectable()
export class AnalyticsAiService {
  constructor(private readonly analyticsService: AnalyticsService) {}

  enabled(): boolean {
    return env("AI_ANALYST_ENABLED") === "true" && !!env("AI_API_KEY") && !!env("AI_MODEL");
  }

  private buildAdapter(): ProviderAdapter {
    const provider = env("AI_PROVIDER") ?? "openai";
    const apiKey = env("AI_API_KEY") ?? "";
    const model = env("AI_MODEL") ?? "";
    const maxTokens = Number(env("AI_MAX_TOKENS") ?? 1500) || 1500;
    if (provider === "anthropic") {
      const base = (env("AI_BASE_URL") ?? "https://api.anthropic.com").replace(/\/+$/, "");
      return new AnthropicAdapter(base, apiKey, model, maxTokens);
    }
    const base = (env("AI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    return new OpenAiCompatAdapter(base, apiKey, model, maxTokens);
  }

  private async systemPrompt(companyId: string, access: AnalyticsAccess, belt: AnalyticsTool[]): Promise<string> {
    const meta = await this.analyticsService.meta(companyId, access);
    const today = new Date().toISOString().slice(0, 10);
    return [
      "You are Lorelei, the resident analyst inside PrintExec, an operations platform for 3D-printing businesses.",
      `Today is ${today}.${meta.currency_code ? ` Amounts are in ${meta.currency_code}.` : ""}`,
      "You answer questions about THIS company's production and business performance.",
      "",
      "Rules:",
      "- Every number you state MUST come from a tool result in this conversation. Never estimate, extrapolate beyond a regression a tool computed, or fill gaps from general knowledge.",
      "- Call tools to get data; you may call several in one turn. Default period is the last 30 days — say which period you used.",
      "- If the data is empty or too thin to answer, say so plainly instead of guessing.",
      `- You only have the tools listed. ${belt.length < ANALYTICS_TOOLS.length ? "Some company data (financials) is outside this user's access — if the question needs it, say they lack finance access rather than approximating." : ""}`,
      "- Answer in plain language, lead with the answer, keep it compact. Use short markdown lists or a small table when comparing items. No preamble."
    ].join("\n");
  }

  async ask(body: AskBody, companyId: string, access: AnalyticsAccess) {
    if (!this.enabled()) {
      throw new ServiceUnavailableException("The AI analyst is not enabled on this server.");
    }
    const belt = ANALYTICS_TOOLS.filter((t) => canUseTool(access, t));
    const adapter = this.buildAdapter();
    adapter.init(await this.systemPrompt(companyId, access, belt), body.history ?? [], body.question);

    const steps: AskStep[] = [];
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const turn = await adapter.call(belt);
      if (turn.toolCalls.length === 0) {
        return { answer: turn.text ?? "I could not produce an answer.", steps };
      }
      const results = await Promise.all(
        turn.toolCalls.map(async (call) => {
          try {
            const data = await this.analyticsService.execute(call.name, call.args, companyId, access);
            steps.push({ tool: call.name, params: call.args, ok: true });
            return { call, content: truncate(JSON.stringify(data)) };
          } catch (e) {
            steps.push({ tool: call.name, params: call.args, ok: false });
            return { call, content: JSON.stringify({ error: e instanceof Error ? e.message : "Tool failed." }) };
          }
        })
      );
      adapter.appendToolResults(results);
    }
    return {
      answer: "I hit the tool-call limit before finishing. Try a narrower question.",
      steps
    };
  }
}
