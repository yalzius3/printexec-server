import {
  BadGatewayException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException
} from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { ANALYTICS_TOOLS } from "./analytics-tools";
import { AnalyticsService, canUseTool, type AnalyticsAccess } from "./analytics.service";
import {
  chartArtifactSchema,
  reportArtifactSchema,
  tableArtifactSchema,
  type AskBody,
  type ChartArtifact,
  type ReportArtifact,
  type TableArtifact
} from "./analytics.schemas";
import type { ZodType } from "zod";

// ════════════════════════════════════════════════════════════════
// AnalyticsAiService — the "Ask" analyst.
//
// Agent loop over the SAME tool registry the dashboard cards use. The model
// NEVER writes SQL and never sees company_id: it picks a registry tool +
// zod-validated params, we execute, it composes the answer. Every executed
// call is returned to the client as an evidence step so the UI can show its
// work.
//
// Besides query tools the belt carries three PRESENTATION tools
// (present_chart / present_table / compose_report): server-validated artifact
// payloads the client renders with the dashboard's own chart primitives. The
// ask response also returns per-answer token/cost usage and the live budget
// snapshot, so the client can meter spend without extra round-trips.
//
// Provider-agnostic BY DESIGN (owner decision 2026-07-13): a thin adapter
// over the two wire formats that cover practically every LLM API —
//   · "openai"     — OpenAI-compatible /chat/completions (OpenAI, Groq,
//                    Gemini-compat, local llama.cpp/vLLM, …)
//   · "openrouter" — same wire format as "openai", plus per-call USD cost
//                    accounting (usage.cost) + attribution headers; this is
//                    what backs the spend budget below
//   · "anthropic"  — Anthropic /v1/messages
// Plain fetch, no SDK dependency: the feature is env-gated and optional, so
// it must not add weight to the deploy when it's off.
//
// Env (all optional until the feature is switched on):
//   AI_ANALYST_ENABLED=true                  master switch (EMAIL_ENABLED-style)
//   AI_PROVIDER=openai|openrouter|anthropic   default openai
//   AI_BASE_URL=…                            default per provider
//   AI_API_KEY=…                             required to enable
//   AI_MODEL=…                               required to enable (never hardcoded)
//   AI_MAX_TOKENS=…                          default 3000 (per round)
//
// Spend budget (per-CALENDAR-MONTH USD cap, metered from provider cost /
// tokens). The cap is internal only — the client is shown a percentage, never
// the dollar figure:
//   AI_BUDGET_USD=1  AI_BUDGET_SCOPE=global|company
// Needs migrations/2026-07-15_ai_usage_budget.sql; fails OPEN until applied.
// ════════════════════════════════════════════════════════════════

const MAX_ROUNDS = 8;
const CALL_TIMEOUT_MS = 60_000;
/** Hard cap on a single tool result as seen by the model. */
const MAX_RESULT_CHARS = 14_000;
/** Hard cap on rendered artifacts per answer. */
const MAX_ARTIFACTS = 5;

interface NeutralToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** The minimal tool shape the wire adapters need — registry query tools and
 *  the presentation tools below both satisfy it. */
interface ToolDef {
  name: string;
  description: string;
  jsonSchema: Record<string, unknown>;
}

interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  /** Real dollar cost of the call when the provider reports it (OpenRouter). */
  costUsd?: number | undefined;
}

interface NeutralTurn {
  text: string | null;
  toolCalls: NeutralToolCall[];
  usage?: TurnUsage | undefined;
}

export interface AskStep {
  tool: string;
  params: Record<string, unknown>;
  ok: boolean;
}

interface ProviderAdapter {
  /** Provider-native message list, seeded with history + question. */
  init(system: string, history: { role: "user" | "assistant"; content: string }[], question: string): void;
  call(tools: ToolDef[]): Promise<NeutralTurn>;
  appendToolResults(results: { call: NeutralToolCall; content: string }[]): void;
}

const env = (key: string): string | undefined => {
  const v = process.env[key];
  return v && v.trim() !== "" ? v.trim() : undefined;
};

const truncate = (s: string): string =>
  s.length <= MAX_RESULT_CHARS ? s : `${s.slice(0, MAX_RESULT_CHARS)}… [truncated ${s.length - MAX_RESULT_CHARS} chars]`;

const asTokens = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// OpenAI-compatible usage block. OpenRouter adds `cost` (USD) when the request
// asks for it; plain OpenAI omits it (we fall back to a token estimate).
const readOpenAiUsage = (raw: unknown): TurnUsage | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  return {
    inputTokens: asTokens(u.prompt_tokens),
    outputTokens: asTokens(u.completion_tokens),
    costUsd: typeof u.cost === "number" && Number.isFinite(u.cost) ? u.cost : undefined
  };
};

const readAnthropicUsage = (raw: unknown): TurnUsage | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  return { inputTokens: asTokens(u.input_tokens), outputTokens: asTokens(u.output_tokens) };
};

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
    private readonly maxTokens: number,
    // OpenRouter: ask for per-call cost accounting (usage.cost) and send its
    // optional attribution headers. Plain OpenAI leaves both off.
    private readonly costAccounting = false,
    private readonly extraHeaders: Record<string, string> = {}
  ) {}

  init(system: string, history: { role: "user" | "assistant"; content: string }[], question: string) {
    this.messages = [
      { role: "system", content: system },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: question }
    ];
  }

  async call(tools: ToolDef[]): Promise<NeutralTurn> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: this.messages,
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.jsonSchema }
      })),
      tool_choice: "auto"
    };
    // OpenRouter returns the call's real USD cost on usage.cost when asked.
    if (this.costAccounting) body.usage = { include: true };
    const payload = await providerFetch(
      `${this.baseUrl}/chat/completions`,
      { authorization: `Bearer ${this.apiKey}`, ...this.extraHeaders },
      body
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
    return {
      text: typeof message.content === "string" ? message.content : null,
      toolCalls,
      usage: readOpenAiUsage(payload.usage)
    };
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

  async call(tools: ToolDef[]): Promise<NeutralTurn> {
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
      return {
        text: "The AI provider declined to answer this question.",
        toolCalls: [],
        usage: readAnthropicUsage(payload.usage)
      };
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
    return { text: text || null, toolCalls, usage: readAnthropicUsage(payload.usage) };
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
// Presentation tools — how Lorelei SHOWS things.
//
// Unlike registry tools these never run SQL: the model calls them with data
// it already fetched in this conversation, the server zod-validates the shape
// and hands the artifact to the client, which renders it with the same chart
// primitives the dashboard cards use. The model gets back a short ack so it
// can reference the artifact in its prose instead of repeating the numbers.
// ════════════════════════════════════════════════════════════════

export type AskArtifact =
  | ({ kind: "chart" } & ChartArtifact)
  | ({ kind: "table" } & TableArtifact)
  | ({ kind: "report" } & ReportArtifact);

interface PresentationTool extends ToolDef {
  kind: AskArtifact["kind"];
  schema: ZodType;
}

const seriesJson = {
  type: "array",
  minItems: 1,
  maxItems: 2,
  items: {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 44, description: "Series name shown in the legend." },
      values: {
        type: "array",
        items: { type: "number" },
        description: "One number per label, copied verbatim from tool results in this conversation."
      }
    },
    required: ["name", "values"],
    additionalProperties: false
  }
};

const PRESENTATION_TOOLS: PresentationTool[] = [
  {
    kind: "chart",
    name: "present_chart",
    description:
      "Render an interactive chart to the user inside the chat, from data you already fetched with the query tools in THIS conversation. Use when shape tells the story better than prose: 'bar' compares buckets or categories (may carry a second series for a comparison), 'line' shows a continuous trend over time (one series), 'donut' shows share of a whole (one series; labels are the slices). Values must be copied verbatim from tool results — never invented, never re-scaled. Put the period in the title; set unit to what the numbers are ('EGP', 'g', 'hours', 'orders'). After presenting, give the takeaway in a sentence — do not re-list the values.",
    schema: chartArtifactSchema,
    jsonSchema: {
      type: "object",
      properties: {
        chart: { type: "string", enum: ["bar", "line", "donut"], description: "bar = comparison, line = trend, donut = mix." },
        title: { type: "string", maxLength: 90, description: "What the chart shows, including the period." },
        unit: { type: "string", maxLength: 14, description: "Unit suffix for values ('EGP', 'g', 'hours')." },
        labels: {
          type: "array",
          items: { type: "string", maxLength: 44 },
          description: "X-axis buckets (ISO dates render as short dates) or donut slice names. Max 62."
        },
        series: seriesJson,
        note: { type: "string", maxLength: 280, description: "Optional one-line caption under the chart." }
      },
      required: ["chart", "title", "labels", "series"],
      additionalProperties: false
    }
  },
  {
    kind: "table",
    name: "present_table",
    description:
      "Render a compact data table to the user inside the chat, from data you already fetched in THIS conversation. Use for leaderboards and itemized comparisons where the exact figures matter more than the shape. 2-7 columns, up to 40 rows, values verbatim from tool results. Pass numbers as JSON numbers (not pre-formatted strings) so the UI can align and format them; null for missing cells.",
    schema: tableArtifactSchema,
    jsonSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 90 },
        columns: { type: "array", items: { type: "string", maxLength: 40 }, description: "2-7 column headers." },
        rows: {
          type: "array",
          items: { type: "array", items: { type: ["string", "number", "null"], maxLength: 160 } },
          description: "Up to 40 rows; each row has exactly one cell per column."
        },
        note: { type: "string", maxLength: 280, description: "Optional one-line caption under the table." }
      },
      required: ["title", "columns", "rows"],
      additionalProperties: false
    }
  },
  {
    kind: "report",
    name: "compose_report",
    description:
      "Assemble a structured written report the user can read in the chat and download as a document (title, optional subtitle, sections with headings and bodies; bodies support paragraphs, **bold**, `code` and '- ' lists). Use ONLY when the user asks for a report, briefing or summary document, or when the answer genuinely needs several sections of narrative — ordinary questions get an ordinary chat answer. Every figure in the body must come from tool results in this conversation. Charts and tables are separate artifacts — reference them by title instead of embedding.",
    schema: reportArtifactSchema,
    jsonSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 90 },
        subtitle: { type: "string", maxLength: 140, description: "Optional dateline/scope line, e.g. the period covered." },
        sections: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              heading: { type: "string", maxLength: 90 },
              body: { type: "string", maxLength: 5000 }
            },
            required: ["heading", "body"],
            additionalProperties: false
          }
        }
      },
      required: ["title", "sections"],
      additionalProperties: false
    }
  }
];

const PRESENTATION_BY_NAME = new Map(PRESENTATION_TOOLS.map((t) => [t.name, t]));

// ════════════════════════════════════════════════════════════════

@Injectable()
export class AnalyticsAiService {
  private readonly logger = new Logger(AnalyticsAiService.name);

  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly databaseService: DatabaseService
  ) {}

  enabled(): boolean {
    return env("AI_ANALYST_ENABLED") === "true" && !!env("AI_API_KEY") && !!env("AI_MODEL");
  }

  private buildAdapter(): ProviderAdapter {
    const provider = env("AI_PROVIDER") ?? "openai";
    const apiKey = env("AI_API_KEY") ?? "";
    const model = env("AI_MODEL") ?? "";
    // Per-round output cap. Generous by default: a compose_report tool call is
    // one large JSON argument, and a truncated call is a wasted (billed) round.
    const maxTokens = Number(env("AI_MAX_TOKENS") ?? 3000) || 3000;
    if (provider === "anthropic") {
      const base = (env("AI_BASE_URL") ?? "https://api.anthropic.com").replace(/\/+$/, "");
      return new AnthropicAdapter(base, apiKey, model, maxTokens);
    }
    if (provider === "openrouter") {
      const base = (env("AI_BASE_URL") ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
      // OpenRouter-recommended (optional) attribution headers.
      const headers: Record<string, string> = { "X-Title": env("AI_OPENROUTER_TITLE") ?? "PrintExec Lorelei" };
      const referer = env("AI_OPENROUTER_REFERER") ?? env("PUBLIC_APP_URL");
      if (referer) headers["HTTP-Referer"] = referer;
      // costAccounting=true → request usage.cost so the budget meters real spend.
      return new OpenAiCompatAdapter(base, apiKey, model, maxTokens, true, headers);
    }
    const base = (env("AI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    return new OpenAiCompatAdapter(base, apiKey, model, maxTokens);
  }

  private async systemPrompt(companyId: string, access: AnalyticsAccess, beltSize: number): Promise<string> {
    const meta = await this.analyticsService.meta(companyId, access);
    const today = new Date().toISOString().slice(0, 10);
    const restricted = beltSize < ANALYTICS_TOOLS.length;
    return [
      "You are Lorelei, the resident analyst inside PrintExec, an operations platform for 3D-printing businesses. You know this domain cold: print farms, filament economics, order pipelines, invoicing, double-entry books.",
      `Today is ${today}.${meta.currency_code ? ` Amounts are in ${meta.currency_code}.` : ""}`,
      "You answer questions about THIS company's production and business performance, from their live data.",
      "",
      "Evidence rules:",
      "- Every number you state or present MUST come from a tool result in this conversation. Never estimate, extrapolate beyond a regression a tool computed, or fill gaps from general knowledge.",
      "- Call query tools to get data; you may call several in one turn. Default period is the last 30 days — say which period you used.",
      "- If the data is empty or too thin to answer, say so plainly, and say what would have to be recorded for the question to become answerable.",
      `- You only have the tools listed.${restricted ? " Some company data (financials) is outside this user's access — if the question needs it, say they lack finance access rather than approximating." : ""}`,
      "",
      "Showing your work:",
      "- You can render artifacts in the chat: present_chart when shape tells the story (trend, comparison, mix), present_table when exact per-row figures matter, compose_report only when the user asks for a report or briefing document.",
      "- Prefer one good artifact over three thin ones. Never repeat in prose what an artifact already shows — state the takeaway and move on.",
      "",
      "Voice:",
      "- You are a seasoned analyst, not a chat assistant. Direct, specific, numerate. Lead with the finding, then the why.",
      "- No filler, no exclamation marks, no 'great question', no apologies unless something actually failed. Numbers carry their units and period.",
      "- Keep prose compact: short paragraphs; markdown lists only when comparing items.",
      "- When the data points at an obvious next cut — by printer, by customer, by month — close with one short offer to run it. One clause, not a pitch."
    ].join("\n");
  }

  async ask(body: AskBody, companyId: string, access: AnalyticsAccess) {
    if (!this.enabled()) {
      throw new ServiceUnavailableException("The AI analyst is not enabled on this server.");
    }
    await this.enforceBudget(companyId);

    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    let result: { answer: string; steps: AskStep[]; artifacts: AskArtifact[] };
    try {
      result = await this.runAgentLoop(body, companyId, access, usage);
    } finally {
      // Record whatever was spent even if a round threw mid-loop.
      if (usage.inputTokens > 0 || usage.outputTokens > 0 || usage.costUsd > 0) {
        await this.recordSpend(companyId, usage.costUsd, usage.inputTokens, usage.outputTokens, env("AI_MODEL") ?? "");
      }
    }
    return {
      ...result,
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cost_usd: Math.round(usage.costUsd * 1e6) / 1e6,
        model: env("AI_MODEL") ?? ""
      },
      // Post-spend budget snapshot so the client meter updates without a
      // second request.
      budget: await this.budgetStatus(companyId)
    };
  }

  private async runAgentLoop(
    body: AskBody,
    companyId: string,
    access: AnalyticsAccess,
    usage: { inputTokens: number; outputTokens: number; costUsd: number }
  ): Promise<{ answer: string; steps: AskStep[]; artifacts: AskArtifact[] }> {
    const belt = ANALYTICS_TOOLS.filter((t) => canUseTool(access, t));
    const adapter = this.buildAdapter();
    adapter.init(await this.systemPrompt(companyId, access, belt.length), body.history ?? [], body.question);

    // Query tools + presentation tools, one belt as the model sees it.
    const toolDefs: ToolDef[] = [...belt, ...PRESENTATION_TOOLS];
    const steps: AskStep[] = [];
    const artifacts: AskArtifact[] = [];

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const turn = await adapter.call(toolDefs);
      if (turn.usage) {
        usage.inputTokens += turn.usage.inputTokens;
        usage.outputTokens += turn.usage.outputTokens;
        // Prefer the provider's real cost; estimate from tokens otherwise.
        usage.costUsd += turn.usage.costUsd ?? this.estimateCostUsd(turn.usage.inputTokens, turn.usage.outputTokens);
      }
      if (turn.toolCalls.length === 0) {
        return { answer: turn.text ?? "I could not produce an answer.", steps, artifacts };
      }
      const results = await Promise.all(
        turn.toolCalls.map(async (call) => {
          const presentation = PRESENTATION_BY_NAME.get(call.name);
          if (presentation) {
            return { call, content: this.executePresentation(presentation, call, steps, artifacts) };
          }
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
      steps,
      artifacts
    };
  }

  /** Validate + collect a presentation tool call; returns the model-facing ack. */
  private executePresentation(
    tool: PresentationTool,
    call: NeutralToolCall,
    steps: AskStep[],
    artifacts: AskArtifact[]
  ): string {
    if (artifacts.length >= MAX_ARTIFACTS) {
      steps.push({ tool: call.name, params: {}, ok: false });
      return JSON.stringify({ error: `Artifact limit (${MAX_ARTIFACTS}) reached for this answer — finish in prose.` });
    }
    const parsed = tool.schema.safeParse(call.args);
    if (!parsed.success) {
      steps.push({ tool: call.name, params: {}, ok: false });
      const issues = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return JSON.stringify({ error: `Invalid ${tool.name} payload — ${issues}` });
    }
    artifacts.push({ kind: tool.kind, ...(parsed.data as object) } as AskArtifact);
    // Steps carry only the title — artifact bodies would bloat the evidence trail.
    const title = (parsed.data as { title?: string }).title;
    steps.push({ tool: call.name, params: title ? { title } : {}, ok: true });
    return JSON.stringify({ ok: true, note: "Rendered to the user. Reference it briefly — do not repeat its data in prose." });
  }

  // ── Spend budget ──────────────────────────────────────────────────────────
  // Per-CALENDAR-MONTH cap on real model cost (USD), metered from the
  // provider's reported per-call cost (OpenRouter usage.cost) or a token-price
  // estimate, and resetting at the start of each month. Default: $1/month
  // GLOBAL across the deployment — it guards the owner's provider key, not
  // per-tenant fairness. AI_BUDGET_SCOPE=company meters each tenant separately;
  // AI_BUDGET_USD=0 disables the cap. The dollar figure is internal: callers
  // surface only a 0–100 percentage (used_pct) to the user, never the amount.

  private budgetUsd(): number {
    const raw = env("AI_BUDGET_USD");
    if (raw === undefined) return 1;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : 1;
  }

  private budgetScope(): "global" | "company" {
    return env("AI_BUDGET_SCOPE") === "company" ? "company" : "global";
  }

  /** Token-price fallback; defaults are Claude Sonnet 5 list price ($/1M). */
  private estimateCostUsd(inputTokens: number, outputTokens: number): number {
    const inPerM = Number(env("AI_PRICE_INPUT_PER_MTOK") ?? 3);
    const outPerM = Number(env("AI_PRICE_OUTPUT_PER_MTOK") ?? 15);
    const i = Number.isFinite(inPerM) ? inPerM : 3;
    const o = Number.isFinite(outPerM) ? outPerM : 15;
    return (inputTokens / 1_000_000) * i + (outputTokens / 1_000_000) * o;
  }

  /** Spend since the start of the current calendar month, plus when the meter
   *  resets (the start of next month). Both the sum window and the reset
   *  boundary are computed in SQL so they share the DB's clock/timezone.
   *  Throws on DB errors (missing table included) — each caller picks its own
   *  failure posture. */
  private async monthSpend(companyId: string): Promise<{ spend: number; resetsAt: Date }> {
    const where = ["created_at >= date_trunc('month', now())"];
    const params: unknown[] = [];
    if (this.budgetScope() === "company") {
      where.push("company_id = $1");
      params.push(companyId);
    }
    const { rows } = await this.databaseService.query<{ spend: string; resets_at: Date }>(
      `SELECT COALESCE(SUM(cost_usd), 0)::text AS spend,
              (date_trunc('month', now()) + interval '1 month') AS resets_at
         FROM ai_usage_events
        WHERE ${where.join(" AND ")}`,
      params
    );
    return {
      spend: Number(rows[0]?.spend ?? 0),
      resetsAt: rows[0]?.resets_at ? new Date(rows[0].resets_at) : this.nextMonthStart()
    };
  }

  /** Start of next calendar month (UTC) — the fallback reset when no rows. */
  private nextMonthStart(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  }

  /** Used share of the cap, clamped to 0–100 (integer). The ONLY budget number
   *  meant for the user — the dollar cap/spend stay server-side. */
  private usedPct(spend: number, cap: number): number {
    if (cap <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((spend / cap) * 100)));
  }

  /** Live budget snapshot for the client's meter — also GET /analytics/ask/budget.
   *  used_pct is what the UI renders; the *_usd fields are internal detail. */
  async budgetStatus(companyId: string) {
    const cap = this.budgetUsd();
    const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
    try {
      const { spend, resetsAt } = await this.monthSpend(companyId);
      return {
        tracked: true,
        scope: this.budgetScope(),
        period: "month" as const,
        cap_usd: cap,
        used_usd: round6(spend),
        remaining_usd: cap > 0 ? round6(Math.max(0, cap - spend)) : null,
        used_pct: this.usedPct(spend, cap),
        resets_at: resetsAt.toISOString()
      };
    } catch (e) {
      // Pre-migration (42P01) or a transient accounting error: nothing to meter.
      const code = (e as { code?: string })?.code;
      if (code !== "42P01") {
        this.logger.warn(`AI budget status unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
      return {
        tracked: false,
        scope: this.budgetScope(),
        period: "month" as const,
        cap_usd: cap,
        used_usd: 0,
        remaining_usd: cap > 0 ? cap : null,
        used_pct: 0,
        resets_at: this.nextMonthStart().toISOString()
      };
    }
  }

  private async enforceBudget(companyId: string): Promise<void> {
    const cap = this.budgetUsd();
    if (cap <= 0) return; // cap disabled
    try {
      const { spend, resetsAt } = await this.monthSpend(companyId);
      if (spend < cap) return;
      // User-facing copy carries NO currency — just the monthly reset date.
      const tail = ` Her allowance resets on ${resetsAt.toISOString().slice(0, 10)}.`;
      throw new HttpException(
        `Lorelei has reached her monthly usage limit and is resting for now.${tail}`,
        HttpStatus.TOO_MANY_REQUESTS
      );
    } catch (e) {
      if (e instanceof HttpException) throw e;
      // Fail OPEN on any accounting error so the analyst keeps working. The
      // usual case is the table not being migrated yet (Postgres 42P01) — the
      // cap simply isn't enforced until migrations/2026-07-15_ai_usage_budget.sql
      // is applied.
      const code = (e as { code?: string })?.code;
      this.logger.warn(
        code === "42P01"
          ? "AI budget not enforced: ai_usage_events is missing — apply migrations/2026-07-15_ai_usage_budget.sql."
          : `AI budget check failed (allowing request): ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private async recordSpend(
    companyId: string,
    costUsd: number,
    inputTokens: number,
    outputTokens: number,
    model: string
  ): Promise<void> {
    try {
      await this.databaseService.query(
        `INSERT INTO ai_usage_events (company_id, model, input_tokens, output_tokens, cost_usd)
         VALUES ($1, $2, $3, $4, $5)`,
        [companyId, model || null, Math.round(inputTokens), Math.round(outputTokens), costUsd]
      );
    } catch (e) {
      // Never fail the user's answer over accounting. Pre-migration this just
      // means spend isn't tracked yet.
      this.logger.warn(`AI usage not recorded: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
