/**
 * Sentinel VM bridge.
 *
 * Runs the real OpenAI Sentinel SDK inside jsdom to derive:
 *   - t  : the turnstile proof   (openai-sentinel-token's "t" field)
 *   - so : the session-observer  (openai-sentinel-so-token's "so" field)
 *
 * The pure-Python layer already computes the PoW "p"; this bridge only fills
 * the two values that require executing the obfuscated SDK bytecode.
 *
 * I/O contract (kept deliberately dumb so the Python side is trivial):
 *   stdin  : JSON { chatReq, cachedProof, flow, deviceId, userAgent, fingerprint? }
 *   stdout : EXACTLY one line of compact JSON { "t": <str|"">, "so": <str|""> }
 *   stderr : all human-readable diagnostics (never parsed)
 *
 * On any failure we still print {"t":"","so":""} and exit 0, so the caller can
 * fall back to token-only behaviour without special-casing crashes.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");

function readInput() {
  // Prefer a file path arg (avoids Windows stdin quirks); fall back to stdin.
  try {
    if (process.argv[2]) return JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));
  } catch (e) {
    process.stderr.write("input file read error: " + e.message + "\n");
  }
  try {
    return JSON.parse(fs.readFileSync(0, "utf-8"));
  } catch (e) {
    process.stderr.write("stdin read error: " + e.message + "\n");
    return {};
  }
}

function emit(t, so) {
  process.stdout.write(JSON.stringify({ t: t || "", so: so || "" }));
}

// The VM returns base64. A rejected/exception path base64-encodes a string that
// looks like "<n>: SomeError: ...". Treat those (and anything too short) as invalid.
function validToken(v) {
  if (!v || typeof v !== "string" || v.length < 40) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(v, "base64").toString("utf-8");
  } catch {
    return false;
  }
  return !/Error|not valid JSON|Unexpected token/i.test(decoded);
}

function loadSdk() {
  const sdkPath = process.env.SENTINEL_SDK_PATH || path.join(__dirname, "sentinel_sdk_full.js");
  let code = fs.readFileSync(sdkPath, "utf-8");
  // Some copies of the SDK are stored as a quoted/escaped JS string literal.
  code = code
    .replace(/^"var SentinelSDK/, "var SentinelSDK")
    .replace(/\\n"$/, "")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
  // Expose the internal helpers we need right before the IIFE returns `t`.
  //   _n : turnstile VM (N)      Nt : session-observer snapshot VM
  //   D  : WeakMap(chatReq->p)   jt : low-level VM runner (collector)
  const hooked = code.replace(
    "t.token=ye,t}({});",
    "t.___n=_n,t.__Nt=Nt,t.__D=D,t.___jt=jt,t.token=ye,t}({});"
  );
  if (hooked === code) {
    throw new Error("SDK hook anchor 't.token=ye,t}({});' not found -- SDK layout changed");
  }
  return hooked;
}

async function main() {
  const input = readInput();
  const { chatReq, cachedProof, fingerprint, pageUrl } = input;
  if (!chatReq || !cachedProof) {
    process.stderr.write("missing chatReq/cachedProof\n");
    return emit("", "");
  }

  const FP = fingerprint || null;
  if (FP && FP.timezone) {
    try {
      process.env.TZ = FP.timezone;
    } catch {
      /* ignore */
    }
  }

  const { JSDOM } = require("jsdom");
  const ua =
    (FP && FP.userAgent) ||
    input.userAgent ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

  const page = String(pageUrl || "https://auth.openai.com/about-you").trim() || "https://auth.openai.com/about-you";
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url: page,
    referrer: page,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    userAgent: ua,
  });
  const { window } = dom;

  const def = (obj, prop, value) => {
    try {
      Object.defineProperty(obj, prop, { value, configurable: true });
    } catch {
      /* ignore */
    }
  };
  def(window.navigator, "userAgent", ua);
  def(window.navigator, "appVersion", ua.replace(/^Mozilla\//, ""));
  if (FP) {
    if (FP.platform) def(window.navigator, "platform", FP.platform);
    if (FP.hardwareConcurrency) def(window.navigator, "hardwareConcurrency", FP.hardwareConcurrency);
    if (FP.deviceMemory) def(window.navigator, "deviceMemory", FP.deviceMemory);
    if (FP.language) def(window.navigator, "language", FP.language);
    if (FP.languages) def(window.navigator, "languages", Object.freeze(String(FP.languages).split(",")));
    const s = FP.screen || {};
    if (s.width) {
      def(window.screen, "width", s.width);
      def(window.screen, "availWidth", s.availWidth || s.width);
    }
    if (s.height) {
      def(window.screen, "height", s.height);
      def(window.screen, "availHeight", s.availHeight || s.height);
    }
    if (s.colorDepth) {
      def(window.screen, "colorDepth", s.colorDepth);
      def(window.screen, "pixelDepth", s.pixelDepth || s.colorDepth);
    }
  }

  if (!window.crypto) window.crypto = {};
  window.crypto.getRandomValues = (arr) => {
    const buf = crypto.randomBytes(arr.length);
    for (let i = 0; i < arr.length; i++) arr[i] = buf[i];
    return arr;
  };
  if (!window.crypto.randomUUID) window.crypto.randomUUID = () => crypto.randomUUID();
  if (!window.performance.memory) {
    window.performance.memory = {
      jsHeapSizeLimit: 4294705152,
      totalJSHeapSize: 35000000,
      usedJSHeapSize: 25000000,
    };
  }

  const context = dom.getInternalVMContext();
  vm.runInContext(loadSdk(), context, { filename: "sentinel_sdk.js" });

  const S = window.SentinelSDK;
  if (!S || typeof S.___n !== "function" || typeof S.__Nt !== "function" || typeof S.__D !== "function") {
    process.stderr.write("SDK internals not exposed\n");
    return emit("", "");
  }

  // Bind the challenge -> proof so the VM can XOR-decrypt the bytecode.
  S.__D(chatReq, cachedProof);

  // 1) turnstile proof (t) -- independent VM state, safe to run first.
  let t = "";
  try {
    const dx = chatReq.turnstile && chatReq.turnstile.dx;
    if (dx) {
      const r = await S.___n(chatReq, dx);
      if (validToken(r)) t = String(r);
      else process.stderr.write("turnstile invalid: " + String(r).slice(0, 60) + "\n");
    }
  } catch (e) {
    process.stderr.write("turnstile error: " + e.message + "\n");
  }

  // 2) session observer (so): run collector first (initializes shared VM map),
  //    then read the snapshot -- mirrors the SDK's sessionObserverToken lifecycle.
  let so = "";
  try {
    const soInfo = chatReq.so || {};
    if (soInfo.required && soInfo.collector_dx && soInfo.snapshot_dx) {
      if (typeof S.___jt === "function") {
        await S.___jt(soInfo.collector_dx, cachedProof); // collector (= Et)
      }
      const r = await S.__Nt(soInfo.snapshot_dx); // snapshot reuses collector state
      if (validToken(r)) so = String(r);
      else process.stderr.write("so invalid: " + String(r).slice(0, 60) + "\n");
    }
  } catch (e) {
    process.stderr.write("so error: " + e.message + "\n");
  }

  emit(t, so);
}

const guard = setTimeout(() => {
  process.stderr.write("timeout 30s\n");
  emit("", "");
  process.exit(0);
}, 30000);
guard.unref && guard.unref();

main()
  .then(() => process.exit(0))
  .catch((e) => {
    process.stderr.write("fatal: " + (e && e.message) + "\n");
    emit("", "");
    process.exit(0);
  });
