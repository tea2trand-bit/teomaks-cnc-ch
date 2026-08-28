import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name); else this.values.delete(name);
    return enabled;
  }
}

class FakeElement {
  constructor(ownerDocument, tagName = "div") {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.classList = new FakeClassList();
    this.style = {};
    this.listeners = new Map();
    this.textContent = "";
    this.value = "";
    this.files = [];
    this.hidden = false;
    this.disabled = false;
    this._innerHTML = "";
  }
  set innerHTML(value) {
    this._innerHTML = value;
    if (value === "") this.children = [];
  }
  get innerHTML() { return this._innerHTML; }
  set className(value) { this._className = value; }
  get className() { return this._className || ""; }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  querySelector(selector) {
    const match = /^\[data-date="([^"]+)"\]$/.exec(selector);
    return match ? this.children.find(child => child.dataset.date === match[1]) || null : null;
  }
  querySelectorAll() { return []; }
  focus() { this.ownerDocument.activeElement = this; }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.readyState = "complete";
    this.activeElement = null;
    this.documentElement = new FakeElement(this, "html");
  }
  getElementById(id) {
    if (!this.elements.has(id)) this.elements.set(id, new FakeElement(this));
    return this.elements.get(id);
  }
  createElement(tagName) { return new FakeElement(this, tagName); }
  querySelector(selector) {
    if (selector === '.contact-form input[name="termin"]') return this.getElementById("terminField");
    if (selector === 'form[name="contact"]') return this.getElementById("contactForm");
    return null;
  }
  querySelectorAll() { return []; }
  addEventListener() {}
}

function makeContext(fetch) {
  const document = new FakeDocument();
  const storage = new Map();
  const fixedNow = new Date("2026-08-28T12:00:00+02:00");
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow.getTime()])); }
    static now() { return fixedNow.getTime(); }
  }
  const context = {
    console,
    confirm: () => true,
    crypto,
    Date: FixedDate,
    FileReader: class {},
    FormData,
    Intl,
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    location: { reload() {} },
    Promise,
    Response,
    setTimeout,
    URL,
    URLSearchParams,
    document,
    fetch
  };
  context.window = context;
  return vm.createContext(context);
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

test("public calendar fails closed when authoritative availability fails", async () => {
  const code = await readFile(new URL("script.js", root), "utf8");
  const requests = [];
  const context = makeContext(async url => {
    requests.push(String(url));
    if (String(url).includes("availability")) return new Response("db error", { status: 500 });
    return new Response(JSON.stringify({ logos: [], projects: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });

  vm.runInContext(code, context);
  await settle();

  assert.equal(context.document.getElementById("calendarDays").children.length, 0);
  assert.match(context.document.getElementById("monthTitle").textContent, /nicht verfügbar/);
  assert.equal(requests.some(url => url.includes("availability.json")), false);
});

test("public calendar exposes only future, unbooked dates as enabled controls", async () => {
  const code = await readFile(new URL("script.js", root), "utf8");
  const context = makeContext(async url => {
    if (String(url).includes("availability")) {
      return new Response(JSON.stringify({ booked: ["2026-08-27", "2026-08-29"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ logos: [], projects: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });

  vm.runInContext(code, context);
  await settle();

  const days = context.document.getElementById("calendarDays");
  const past = days.children.find(day => day.dataset.date === "2026-08-27");
  const busy = days.children.find(day => day.dataset.date === "2026-08-29");
  const free = days.children.find(day => day.dataset.date === "2026-08-30");
  assert.match(past.className, /\bpast\b/);
  assert.doesNotMatch(past.className, /\bbusy\b/);
  assert.equal(past.getAttribute("role"), "button");
  assert.equal(past.getAttribute("aria-disabled"), "true");
  assert.match(past.getAttribute("aria-label"), /vergangener Termin/);
  assert.equal(busy.getAttribute("role"), "button");
  assert.equal(busy.getAttribute("aria-disabled"), "true");
  assert.match(busy.getAttribute("aria-label"), /ausgebucht/);
  assert.equal(free.getAttribute("role"), "button");
  assert.equal(free.getAttribute("aria-disabled"), null);
  assert.equal(free.getAttribute("aria-pressed"), "false");

  context.selectDay("2026-08-30");
  assert.equal(context.document.activeElement?.dataset.date, "2026-08-30");
  assert.equal(
    context.document.getElementById("calendarDays").querySelector('[data-date="2026-08-30"]').getAttribute("aria-pressed"),
    "true"
  );
});

test("public past calendar days retain WCAG AA text contrast", async () => {
  const css = await readFile(new URL("styles.css", root), "utf8");
  const rule = css.match(/\.day\.past\{([^}]*)\}/)?.[1] || "";
  const background = rule.match(/background:\s*(#[0-9a-f]{6})/i)?.[1];
  const color = rule.match(/color:\s*(#[0-9a-f]{6})/i)?.[1];
  const channel = value => {
    const srgb = value / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  const luminance = hex => {
    const values = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
    return 0.2126 * channel(values[0]) + 0.7152 * channel(values[1]) + 0.0722 * channel(values[2]);
  };

  assert.ok(background && color, "past-day foreground and background colors should be explicit");
  assert.doesNotMatch(rule, /opacity\s*:/i);
  const lighter = Math.max(luminance(background), luminance(color));
  const darker = Math.min(luminance(background), luminance(color));
  assert.ok((lighter + 0.05) / (darker + 0.05) >= 4.5);
});

async function adminScript() {
  const html = await readFile(new URL("admin/index.html", root), "utf8");
  return html.match(/<script>([\s\S]*)<\/script>/)?.[1] || "";
}

test("admin blocks schedule POST after a failed authoritative load", async () => {
  const requests = [];
  const context = makeContext(async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method || "GET" });
    return new Response("db error", { status: 500 });
  });
  context.document.getElementById("saveBtn").disabled = true;
  vm.runInContext(await adminScript(), context);

  await context.loadAvailability();
  await context.save();

  assert.equal(context.document.getElementById("saveBtn").disabled, true);
  assert.equal(requests.some(request => request.method === "POST"), false);
});

test("admin sends the loaded base snapshot with a schedule save", async () => {
  const requests = [];
  const context = makeContext(async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ booked: ["2026-09-21"] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });
  context.document.getElementById("saveBtn").disabled = true;
  vm.runInContext(await adminScript(), context);

  await context.loadAvailability();
  await context.save();

  const post = requests.find(request => request.options.method === "POST");
  assert.ok(post);
  assert.deepEqual(JSON.parse(post.options.body), {
    booked: ["2026-09-21"],
    baseBooked: ["2026-09-21"]
  });
});

test("admin calendar keeps focus on the toggled date", async () => {
  const context = makeContext(async () => new Response(JSON.stringify({ booked: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  }));
  context.document.getElementById("saveBtn").disabled = true;
  vm.runInContext(await adminScript(), context);
  await context.loadAvailability();

  const day = context.document.getElementById("calendarDays").querySelector('[data-date="2026-08-30"]');
  day.listeners.get("click")();

  assert.equal(context.document.activeElement?.dataset.date, "2026-08-30");
  assert.equal(
    context.document.getElementById("calendarDays").querySelector('[data-date="2026-08-30"]').getAttribute("aria-pressed"),
    "true"
  );
  assert.match(context.document.getElementById("saveMsg").textContent, /30\. August 2026 ist jetzt ausgebucht\./);
});

test("admin calendar announces one concise toggle status instead of making the day grid live", async () => {
  const html = await readFile(new URL("admin/index.html", root), "utf8");
  const calendarDays = html.match(/<div class="days" id="calendarDays"([^>]*)>/)?.[1] || "";

  assert.doesNotMatch(calendarDays, /aria-live/);
  assert.match(html, /id="saveMsg" role="status" aria-live="polite" aria-atomic="true"/);
});

test("admin enforces the 4 MiB project upload budget before encoding", async () => {
  const context = makeContext(async () => new Response("{}", { status: 200 }));
  vm.runInContext(await adminScript(), context);
  const limit = 4 * 1024 * 1024;

  assert.equal(context.projectFilesFit([{ size: limit }]), true);
  assert.equal(context.projectFilesFit([{ size: limit + 1 }]), false);
  assert.equal(context.projectFilesFit([{ size: limit / 2 }, { size: limit / 2 }]), true);
  assert.equal(context.projectFilesFit([{ size: limit / 2 }, { size: limit / 2 + 1 }]), false);
});
