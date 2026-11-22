// Driving the built Tauri app through tauri-driver and the platform's WebDriver
// (WebKitWebDriver on Linux, msedgedriver on Windows), for the end-to-end journeys.
import { spawn } from "node:child_process";

const DRIVER = "http://127.0.0.1:4444";

export function check(ok, what) {
  if (!ok) throw new Error(`Failed: ${what}`);
  console.log(`  ok  ${what}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function wd(method, path, body) {
  const response = await fetch(`${DRIVER}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data.value)}`);
  return data.value;
}

async function waitForDriver() {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${DRIVER}/status`);
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error("tauri-driver did not start");
}

/**
 * Starts the app with `env` (tauri-driver passes its environment on to it) and opens a session.
 * The licence server is pointed at a port nothing listens on, so no journey reaches the real one.
 */
export async function launch(app, env) {
  const driver = spawn("tauri-driver", [], {
    stdio: "inherit",
    env: { ...process.env, MANAGER_PLUS_LICENCE_URL: "http://127.0.0.1:9", ...env },
  });
  try {
    await waitForDriver();
    const { sessionId } = await wd("POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application: app }, "webkitgtk:browserOptions": { args: [] } } },
    });
    return {
      session: sessionId,
      async close() {
        await wd("DELETE", `/session/${sessionId}`).catch(() => {});
        driver.kill();
      },
    };
  } catch (error) {
    driver.kill();
    throw error;
  }
}

/** Runs `fn` in the page with `args` (async functions are awaited). */
export const run = (session, fn, ...args) =>
  wd("POST", `/session/${session}/execute/async`, {
    script: `const done = arguments[arguments.length - 1]; Promise.resolve((${fn})(...Array.from(arguments).slice(0, -1))).then(done, (e) => done({ error: String(e) }));`,
    args,
  });

/** Waits until `fn` returns something truthy in the page. */
export async function until(session, what, fn, ...args) {
  for (let i = 0; i < 100; i++) {
    const value = await run(session, fn, ...args);
    if (value && !value.error) return value;
    await sleep(150);
  }
  throw new Error(`Timed out: ${what}`);
}

/** Keys WebDriver knows by code. */
export const KEY = { Enter: "", F10: "", F12: "" };

/** Types `text` into whatever has the focus, as a keyboard (or a barcode scanner) would. */
export async function type(session, text) {
  const actions = [...text].flatMap((value) => [
    { type: "keyDown", value },
    { type: "keyUp", value },
  ]);
  await wd("POST", `/session/${session}/actions`, { actions: [{ type: "key", id: "keyboard", actions }] });
}

// In the page: fill a field by its label, and click a button by its text, the way a person would.
export const fill = (label, value) => {
  const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim().startsWith(label));
  const input = l && (l.control ?? l.querySelector("input, select, textarea"));
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
};

export const click = (text) => {
  const b = [...document.querySelectorAll("button, [role=tab], a")].find((x) => x.textContent.trim() === text);
  if (!b) return false;
  b.click();
  return true;
};
