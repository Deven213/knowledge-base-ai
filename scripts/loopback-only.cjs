// Preload for Node: "this process may only talk to this computer".
//
//   node --require ./scripts/loopback-only.cjs ...        (the mock-testing launcher does this for the app under test)
//
// It wraps the one place every outgoing TCP connection in Node passes through (net.Socket.prototype.connect: fetch, http, https and
// tls all end up there) and refuses any connection whose target is not loopback (127.x.x.x, ::1, localhost) or a local pipe. The
// refusal happens BEFORE the name is looked up, so nothing leaves the computer, not even a DNS question.
//
// Why it exists: the mock-testing setup points the Gemini client at a stand-in on localhost with GOOGLE_GEMINI_BASE_URL. If a future
// SDK version ever stopped honouring that variable, a test recording would be sent to Google instead. With this preload in place the
// same mistake fails loudly ("blocked a connection to generativelanguage.googleapis.com") and nothing is sent.
//
// Limits (be honest about them): it covers connections made through Node's own networking. A native add-on that opens its own
// sockets, or a child process, is outside it. The app under test has no such code on its consultation path.

"use strict";

const net = require("node:net");

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?|\[?0{0,4}(:0{0,4}){6}:0{0,3}1\]?|\[?::ffff:127(\.\d{1,3}){3}\]?)$/i;

/** True for hosts that are this computer. Anything else (including 0.0.0.0, a LAN address, a public name) is not. */
function isLoopbackHost(host) {
  return LOOPBACK.test(String(host ?? "localhost").trim());
}

/** What a connect(...) call is aiming at, in any of the shapes Node accepts (options object, normalized array, (port, host), path). */
function targetOf(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") {
    if (typeof first.path === "string") return { path: first.path };
    return { host: first.host ?? "localhost", port: first.port };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return { path: first };
  return { host: typeof args[1] === "string" ? args[1] : "localhost", port: first };
}

const warned = new Set();

function install() {
  const proto = net.Socket.prototype;
  if (proto.connect.__loopbackOnly) return false;
  const original = proto.connect;
  function guardedConnect(...args) {
    const target = targetOf(args);
    if (target.path === undefined && !isLoopbackHost(target.host)) {
      const where = `${target.host}${target.port ? ":" + target.port : ""}`;
      const error = new Error(`loopback-only: blocked a connection to ${where}. This process may only talk to this computer.`);
      error.code = "ECONNBLOCKED";
      if (!warned.has(where)) {
        warned.add(where);
        console.error(`[loopback-only] ${error.message}`);
      }
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return original.apply(this, args);
  }
  guardedConnect.__loopbackOnly = true;
  proto.connect = guardedConnect;
  return true;
}

install();

module.exports = { install, isLoopbackHost };
