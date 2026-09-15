import { afterEach, expect, mock, test } from "bun:test";
import { escapeHtml, fitTelegramLimit, sendTelegram } from "./telegram";

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
