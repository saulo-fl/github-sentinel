import { afterEach, expect, mock, test } from "bun:test";
import {
  buildDigestMessages,
  escapeHtml,
  fitTelegramLimit,
  sendTelegram,
  telegramConfig,
  type DigestItems,
} from "./telegram";
import type { IssueWithRepo } from "./db";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function useFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = mock(impl);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

test("escapeHtml neutraliza texto externo", () => {
  expect(escapeHtml(`<script>alert("x")</script> & co`)).toBe(
    `&lt;script&gt;alert("x")&lt;/script&gt; &amp; co`
  );
});

test("fitTelegramLimit no toca mensajes cortos", () => {
  expect(fitTelegramLimit("<b>hola</b>")).toBe("<b>hola</b>");
});

test("fitTelegramLimit corta en línea completa y queda bajo 4096", () => {
  const line = "<b>HIGH</b> owner/repo#1 · razón bastante larga para llenar la línea";
  const text = Array.from({ length: 200 }, () => line).join("\n");
  const out = fitTelegramLimit(text);
  const suffix = "\n… (truncado)";
  expect(out.length).toBeLessThanOrEqual(4096);
  expect(out.endsWith(suffix)).toBe(true);
  for (const l of out.slice(0, -suffix.length).split("\n")) {
    expect(l).toBe(line);
  }
});

test("sendTelegram manda HTML al chat configurado", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:SECRET";
  process.env.TELEGRAM_CHAT_ID = "42";
  const fn = useFetch(async () => Response.json({ ok: true }));

  await sendTelegram("<b>hola</b>");

  const [url, init] = fn.mock.calls[0]!;
  expect(url).toBe("https://api.telegram.org/bot123:SECRET/sendMessage");
  expect(JSON.parse(init.body as string)).toEqual({
    chat_id: "42",
    text: "<b>hola</b>",
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
});

test("sendTelegram propaga la descripción de error de Telegram", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:SECRET";
  process.env.TELEGRAM_CHAT_ID = "42";
  useFetch(async () =>
    Response.json(
      { ok: false, description: "Bad Request: chat not found" },
      { status: 400 }
    )
  );

  await expect(sendTelegram("x")).rejects.toThrow(
    "Telegram 400: Bad Request: chat not found"
  );
});

test("sendTelegram no filtra el token en errores de red", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:SECRET";
  process.env.TELEGRAM_CHAT_ID = "42";
  useFetch(async () => {
    throw new TypeError(
      "fetch failed: https://api.telegram.org/bot123:SECRET/sendMessage"
    );
  });

  const err = (await sendTelegram("x").catch((e) => e)) as Error;
  expect(err).toBeInstanceOf(Error);
  expect(err.message).not.toContain("SECRET");
});

// F5: Bun suele dar name === "Error" en fallos de red; err.code (p.ej. ECONNREFUSED)
// es lo único diagnosticable y nunca contiene el token.
test("sendTelegram incluye err.code en el mensaje de red cuando existe", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:SECRET";
  process.env.TELEGRAM_CHAT_ID = "42";
  useFetch(async () => {
    throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
      code: "ECONNREFUSED",
    });
  });

  const err = (await sendTelegram("x").catch((e) => e)) as Error;
  expect(err.message).toBe("Telegram: fallo de red (ECONNREFUSED)");
});

// F1: un emoji cortado en el límite deja un surrogate suelto; JSON.stringify lo manda
// tal cual y Telegram responde 400 porque no es UTF-8 válido.
test("sendTelegram normaliza surrogates sueltos antes de enviar", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:SECRET";
  process.env.TELEGRAM_CHAT_ID = "42";
  const fn = useFetch(async () => Response.json({ ok: true }));

  await sendTelegram("a\ud83d");

  const [, init] = fn.mock.calls[0]!;
  const body = JSON.parse(init.body as string) as { text: string };
  expect(body.text).toBe("a�");
});

// F3: DIGEST_TIMEZONE="" no debe colar un string vacío a Intl (rompería el digest programado).
test("telegramConfig usa el timezone por defecto si DIGEST_TIMEZONE viene vacío", () => {
  const prev = process.env.DIGEST_TIMEZONE;
  process.env.DIGEST_TIMEZONE = "";
  try {
    expect(telegramConfig().timezone).toBe("America/Mexico_City");
  } finally {
    if (prev === undefined) delete process.env.DIGEST_TIMEZONE;
    else process.env.DIGEST_TIMEZONE = prev;
  }
});

// F2: el fallback (sin PRs, sin LLM) debe escapar título/resumen/url de issues externas.
test("buildDigestMessages escapa HTML de issues externos en el fallback", async () => {
  const issue = {
    title: "<script>&",
    analysis_summary: "a<b",
    owner: "o",
    repo_name: "r",
    issue_number: 1,
    created_at: new Date().toISOString(),
    html_url: "https://x/?a=1&b=2",
  } as unknown as IssueWithRepo;

  const items: DigestItems = {
    prs: [],
    issues: [issue],
    truncatedPRs: 0,
    truncatedIssues: 0,
    totals: {
      repos: 0,
      openIssues: 0,
      analyzedIssues: 0,
      openPRs: 0,
      lastScan: null,
    },
  };

  const messages = await buildDigestMessages(items, {
    slot: "manual",
    timezone: "America/Mexico_City",
  });

  expect(messages).toHaveLength(1);
  const message = messages[0]!;
  expect(message).not.toContain("<script");
  expect(message).toContain("&lt;script&gt;&amp;");
  expect(message).toContain("a&lt;b");
  expect(message).toContain("?a=1&amp;b=2");
});
