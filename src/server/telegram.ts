import { queries, type IssueWithRepo, type PullRequestWithRepo } from "./db";
import {
  prioritizePullRequests,
  type PullRequestPriorityResult,
} from "./llm";

const TELEGRAM_API = "https://api.telegram.org";

// Telegram acepta 4096; el margen deja sitio al sufijo de truncado.
const MAX_MESSAGE_LENGTH = 4000;
const MAX_PRS_FOR_PRIORITY = 12;
const MAX_PR_DESCRIPTION_CHARS = 500;
const MAX_ISSUES_IN_DIGEST = 10;
const PREVIEW_MESSAGE_SEPARATOR = "\n\n---\n\n";

export type TelegramConfig = {
  enabled: boolean;
  configured: boolean;
  chatId: string | null;
  timezone: string;
  cron: string;
};

export function telegramConfig(): TelegramConfig {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() || null;
  const enabled =
    (process.env.TELEGRAM_ENABLED ?? "true").toLowerCase() !== "false";
  return {
    enabled,
    configured: Boolean(token && chatId),
    chatId: chatId ? maskId(chatId) : null,
    timezone: process.env.DIGEST_TIMEZONE ?? "America/Mexico_City",
    cron: process.env.DIGEST_CRON?.trim() || "0 0,15 * * *",
  };
}

function maskId(id: string): string {
  const clean = id.replace(/\D/g, "");
  if (clean.length <= 4) return clean;
  return `${clean.slice(0, 2)}…${clean.slice(-3)}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Corta en el último salto de línea: cada <b>/<i> abre y cierra en su propia línea.
export function fitTelegramLimit(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  const cut = text.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
  return `${text.slice(0, cut > 0 ? cut : MAX_MESSAGE_LENGTH)}\n… (truncado)`;
}

export async function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) {
    throw new Error(
      "Faltan TELEGRAM_BOT_TOKEN y/o TELEGRAM_CHAT_ID en el entorno."
    );
  }

  let res: Response;
  try {
    res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: fitTelegramLimit(text),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // No se re-lanza el error original: su mensaje puede incluir la URL con el token.
    const name = err instanceof Error ? err.name : "Error";
    throw new Error(`Telegram: fallo de red (${name})`);
  }

  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
  };
  if (!res.ok || !data.ok) {
    throw new Error(
      `Telegram ${res.status}: ${data.description ?? "respuesta inválida"}`
    );
  }
}

export type DigestItems = {
  prs: PullRequestWithRepo[];
  issues: IssueWithRepo[];
  truncatedPRs: number;
  truncatedIssues: number;
  totals: {
    repos: number;
    openIssues: number;
    analyzedIssues: number;
    openPRs: number;
    lastScan: string | null;
  };
};

export function collectDigestItems(lastScan: string | null = null): DigestItems {
  const prsAll = queries.listOpenExternalPRs.all();
  const issuesAll = queries.listOpenHighRiskIssues.all();
  return {
    prs: prsAll.slice(0, MAX_PRS_FOR_PRIORITY),
    issues: issuesAll.slice(0, MAX_ISSUES_IN_DIGEST),
    truncatedPRs: Math.max(0, prsAll.length - MAX_PRS_FOR_PRIORITY),
    truncatedIssues: Math.max(0, issuesAll.length - MAX_ISSUES_IN_DIGEST),
    totals: {
      repos: queries.listRepos.all().length,
      openIssues: queries.countIssues.get()?.total ?? 0,
      analyzedIssues: queries.countAnalyzed.get()?.total ?? 0,
      openPRs: queries.countOpenPRs.get()?.total ?? 0,
      lastScan,
    },
  };
}

export type DigestContext = {
  slot: "morning" | "evening" | "manual";
  timezone: string;
};

export async function buildDigestMessages(
  items: DigestItems,
  ctx: DigestContext
): Promise<string[]> {
  const time = new Date().toLocaleString("es-MX", {
    timeZone: ctx.timezone,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    day: "2-digit",
    month: "short",
  });

  if (items.prs.length > 0) {
    const focus = await buildPullRequestFocus(items.prs);
    return buildPullRequestMessages(items.prs, focus);
  }

  return [buildFallbackDigestMessage(items, ctx, time)];
}

export async function buildDigestMessage(
  items: DigestItems,
  ctx: DigestContext
): Promise<string> {
  const messages = await buildDigestMessages(items, ctx);
  return messages.join(PREVIEW_MESSAGE_SEPARATOR);
}

function buildFallbackDigestMessage(
  items: DigestItems,
  ctx: DigestContext,
  time: string
): string {
  const greeting =
    ctx.slot === "morning"
      ? "Buenos días"
      : ctx.slot === "evening"
        ? "Buenas tardes"
        : "Resumen";
  const lines: string[] = [];
  lines.push(`<b>GitHub Sentinel</b> · ${greeting}`);
  lines.push(`<i>${escapeHtml(time)}</i>`);
  lines.push("");

  if (items.prs.length === 0 && items.issues.length === 0) {
    lines.push("✅ Todo en orden, nada pendiente de revisar.");
    lines.push("");
    lines.push(
      `<i>${items.totals.repos} repos · ${items.totals.openIssues} issues totales · ${items.totals.analyzedIssues} analizadas</i>`
    );
    if (items.totals.lastScan) {
      lines.push(`<i>último scan: ${relativeAge(items.totals.lastScan)}</i>`);
    }
    return lines.join("\n");
  }

  if (items.issues.length > 0) {
    lines.push(
      `<b>Issues high-risk (${items.issues.length}${items.truncatedIssues ? `+${items.truncatedIssues}` : ""})</b>`
    );
    for (const issue of items.issues) {
      const age = relativeAge(issue.created_at);
      lines.push(
        `• ${escapeHtml(`${issue.owner}/${issue.repo_name}`)} #${issue.issue_number} · ${age}`
      );
      lines.push(`  ${escapeHtml(truncate(cleanText(issue.title), 90))}`);
      if (issue.analysis_summary) {
        lines.push(
          `  <i>${escapeHtml(truncate(cleanText(issue.analysis_summary), 120))}</i>`
        );
      }
      lines.push(`  ${escapeHtml(issue.html_url)}`);
    }
    if (items.truncatedIssues > 0) {
      lines.push(`  …y ${items.truncatedIssues} más`);
    }
  }

  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

function buildPullRequestMessages(
  prs: PullRequestWithRepo[],
  focus: PullRequestPriorityResult
): string[] {
  const byId = new Map(prs.map((pr) => [prKey(pr), pr]));
  const blocks: string[] = [];

  for (const item of focus.focus) {
    const pr = byId.get(item.id);
    if (!pr) continue;

    const meta = `${pr.owner}/${pr.repo_name}#${pr.pr_number} · ${relativeAge(
      pr.created_at
    )}`;
    const reason = item.reason || truncate(cleanText(pr.title), 110);

    const lines = [
      `<b>${item.priority.toUpperCase()}</b> ${escapeHtml(meta)}`,
      escapeHtml(truncate(cleanText(reason), 120)),
      "",
      escapeHtml(pr.html_url),
    ];

    blocks.push(lines.join("\n"));
  }

  return blocks.length > 0 ? [blocks.join("\n\n")] : [];
}

async function buildPullRequestFocus(
  prs: PullRequestWithRepo[]
): Promise<PullRequestPriorityResult> {
  const input = prs.map((pr) => ({
    id: prKey(pr),
    repo: `${pr.owner}/${pr.repo_name}`,
    number: pr.pr_number,
    title: truncate(cleanText(pr.title), 160),
    description: pr.body
      ? truncate(cleanText(pr.body), MAX_PR_DESCRIPTION_CHARS)
      : null,
    author: pr.author,
    age: relativeAge(pr.created_at),
    comments: pr.comments,
    labels: parseLabels(pr.labels),
    url: pr.html_url,
  }));

  try {
    return await prioritizePullRequests(input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[digest] priorización IA de PRs no disponible: ${msg}`);
    return {
      summary: "IA no disponible; foco provisional por antigüedad.",
      focus: input.slice(0, 3).map((pr) => ({
        id: pr.id,
        priority: "medium",
        reason: `PR externa abierta desde hace ${pr.age}; revisar si bloquea algo importante.`,
        action: "",
      })),
    };
  }
}

function prKey(pr: PullRequestWithRepo): string {
  return `${pr.owner}/${pr.repo_name}#${pr.pr_number}`;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseLabels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const labels = JSON.parse(raw) as unknown;
    if (!Array.isArray(labels)) return [];
    return labels.filter((label): label is string => typeof label === "string");
  } catch {
    return [];
  }
}

function relativeAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "ahora";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}
