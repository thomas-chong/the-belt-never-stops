// The belt page. One SSE stream from the server drives everything: the belt, the ADK graph,
// the Gemini panel, the timeline, the counters and the call log. Nothing here invents a model
// answer or its timing: a parcel is stamped only when its Jev response arrives.
"use strict";
const $ = (id) => document.getElementById(id);
const NAMES = { ship: "SHIP", spot_check: "SPOT CHECK", retape: "RETAPE", hold: "HOLD", return: "RETURN", file_claim: "FILE CLAIM", missed: "MISSED" };
const OPTS = ["ship", "retape", "hold", "return", "file_claim"];
const OPT_COLOR = { ship: "green", retape: "blue", hold: "yellow", return: "red", file_claim: "purple" };
const S = { mode: "workflow", running: false, lanes: {}, timeline: [], clock: null, lastServerT: 0,
            youTimes: [], cards: {}, calls: new Map(), parcels: [], gems: {}, panel: null,
            insp: { open: false, follow: true, id: null }, policy: null, photos: [] };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n) => (n == null ? "–" : Number(n).toLocaleString("en-US"));
const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

// ── fit 1920x1080 to any window ───────────────────────────────────────────
function fit() { const z = Math.min(innerWidth / 1920, innerHeight / 1080); document.body.style.transform = `scale(${z})`; }
addEventListener("resize", fit); fit();

// ── server clock: map server t (seconds since run start) to local time ────
function serverNow() { return S.clock ? (performance.now() - S.clock) / 1000 : 0; }
function syncClock(t) { const c = performance.now() - t * 1000; if (S.clock === null || c < S.clock) S.clock = c; }

// ── ADK graph ─────────────────────────────────────────────────────────────
const N = {
  START:        { x: 38,  y: 128, w: 64,  kind: "code" },
  enter:        { x: 128, y: 128, w: 84,  kind: "code" },
  read_label:   { x: 272, y: 62,  w: 122, kind: "code" },
  claims_clerk: { x: 438, y: 62,  w: 170, kind: "gem", sub: "Gemini LlmAgent" },
  claim_ready:  { x: 600, y: 62,  w: 124, kind: "code" },
  rest:         { x: 700, y: 62,  w: 54,  kind: "code" },
  tick:         { x: 272, y: 192, w: 122, kind: "jev", sub: "Jev 1.14 · image" },
  check_claim:  { x: 438, y: 192, w: 150, kind: "code" },
  summarise:    { x: 272, y: 262, w: 122, kind: "code" },
  shift_lead:   { x: 438, y: 262, w: 170, kind: "gem", sub: "Gemini LlmAgent" },
  finish:       { x: 600, y: 262, w: 90,  kind: "code" },
};
const H = 40;
const EDGES = [
  ["START", "enter"], ["enter", "read_label", ""], ["enter", "tick", ""],
  ["read_label", "claims_clerk"], ["claims_clerk", "claim_ready"], ["claim_ready", "rest", ""],
  ["claim_ready", "read_label", "retry", "over"], ["tick", "check_claim", "next"], ["check_claim", "tick", "again", "under"],
  ["tick", "read_label", "recast", "mid"], ["tick", "summarise", "done"], ["summarise", "shift_lead"], ["shift_lead", "finish"],
];
function edgePath(a, b, how) {
  const A = N[a], B = N[b];
  if (how === "over") return `M${A.x},${A.y - H / 2} C${A.x},${A.y - 62} ${B.x},${B.y - 62} ${B.x},${B.y - H / 2}`;
  if (how === "under") return `M${A.x},${A.y + H / 2} C${A.x},${A.y + 44} ${B.x + 30},${B.y + 44} ${B.x + 30},${B.y + H / 2}`;
  if (how === "mid") return `M${A.x - 30},${A.y - H / 2} C${A.x - 50},${A.y - 70} ${B.x - 50},${B.y + 70} ${B.x - 30},${B.y + H / 2}`;
  const ax = A.x + (B.x > A.x + 10 ? A.w / 2 : 0), ay = A.y + (B.y > A.y + 10 ? H / 2 : B.y < A.y - 10 ? -H / 2 : 0);
  const bx = B.x - (B.x > A.x + 10 ? B.w / 2 : 0), by = B.y + (B.y > A.y + 10 ? -H / 2 : B.y < A.y - 10 ? H / 2 : 0);
  if (Math.abs(ay - by) < 2 || Math.abs(ax - bx) < 2) return `M${ax},${ay} L${bx},${by}`;
  return `M${ax},${ay} C${(ax + bx) / 2},${ay} ${(ax + bx) / 2},${by} ${bx},${by}`;
}
function drawGraph() {
  const svg = $("graph"); const ns = "http://www.w3.org/2000/svg"; svg.innerHTML = "";
  const el = (tag, attrs, parent = svg) => { const e = document.createElementNS(ns, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.appendChild(e); return e; };
  const defs = el("defs", {});
  const m = el("marker", { id: "arr", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, defs);
  el("path", { d: "M0,0 L10,5 L0,10 z", fill: "#80868b" }, m);
  el("text", { x: 6, y: 66, class: "lane-label", fill: "#5b21c4" }).textContent = "SLOW";
  el("text", { x: 6, y: 196, class: "lane-label" }).textContent = "FAST";
  for (const [a, b, label, how] of EDGES) {
    const p = el("path", { d: edgePath(a, b, how), class: "edge", id: `e-${a}-${b}`, "marker-end": "url(#arr)" });
    if (label) {
      const len = p.getTotalLength(), pt = p.getPointAtLength(len * (how === "mid" ? 0.5 : 0.5));
      const pos = how === "over" ? { x: pt.x, y: pt.y + 16, "text-anchor": "middle" } : how === "under" ? { x: pt.x + 40, y: pt.y + 4, "text-anchor": "start" }
        : how === "mid" ? { x: pt.x - 8, y: pt.y + 4, "text-anchor": "end" } : a === "tick" && b === "summarise" ? { x: pt.x - 8, y: pt.y + 5, "text-anchor": "end" }
        : { x: pt.x, y: N[a].y - H / 2 - 5, "text-anchor": "middle" };
      el("text", { ...pos, class: "elabel" }).textContent = label;
    }
  }
  // the shared claim slot: state, never a call
  const slot = el("g", { class: "slot", id: "slot" });
  el("rect", { x: 528, y: 112, width: 196, height: 32 }, slot);
  el("text", { x: 626, y: 128, id: "slottext" }, slot).textContent = "state: claim = empty";
  el("path", { d: "M600,82 L600,112", class: "edge state" });
  el("path", { d: "M560,144 C556,160 540,168 513,176", class: "edge state", "marker-end": "url(#arr)" });
  for (const [name, n] of Object.entries(N)) {
    const g = el("g", { class: `node ${n.kind}`, id: `n-${name}` });
    el("rect", { x: n.x - n.w / 2, y: n.y - H / 2, width: n.w, height: H }, g);
    el("text", { x: n.x, y: n.y - (n.sub ? 7 : 0) }, g).textContent = name;
    if (n.sub) el("text", { x: n.x, y: n.y + 12, class: "sub" }, g).textContent = n.sub;
  }
}
function flash(name, ms = 380) { const g = $(`n-${name}`); if (!g) return; g.classList.add("flash"); clearTimeout(g._t); g._t = setTimeout(() => g.classList.remove("flash"), ms); }
function litEdge(a, b) {
  const e = $(`e-${a}-${b}`); if (!e) return;
  e.classList.add("lit"); clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove("lit"), 450);
  const len = e.getTotalLength(); const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("r", 6); dot.setAttribute("class", "pulse"); $("graph").appendChild(dot);
  const t0 = performance.now();
  (function step(now) { const k = Math.min(1, (now - t0) / 420); const p = e.getPointAtLength(len * k);
    dot.setAttribute("cx", p.x); dot.setAttribute("cy", p.y); if (k < 1) requestAnimationFrame(step); else dot.remove(); })(t0);
}
function thinking(name, on) { const g = $(`n-${name}`); if (g) g.classList.toggle("thinking", on); }
const nodeOf = (path) => { const m = /\/([a-z_]+)@\d+$/.exec(path || ""); return m ? m[1] : null; };
let lastNode = "START";
function onAdk(e) {
  const node = nodeOf(e.node); if (!node) return;
  if (!e.partial) {
    flash(node, node === "tick" ? 260 : 500);
    if (lastNode && $(`e-${lastNode}-${node}`)) litEdge(lastNode, node);
    if (node === "tick" || node === "check_claim" || node === "enter") lastNode = node;
  }
}

// ── belt: a card arrives on "parcel", is stamped only on "decision" ───────
function laneY(action) { const lane = document.querySelector(`.lane[data-a=${action}]`); return lane.offsetTop + lane.offsetHeight / 2 - 73; }
function newCard(id, url, waitingFor = "Jev") {
  const c = document.createElement("div"); c.className = "pcard";
  c.innerHTML = `<img src="${esc(url)}" alt=""><div class="wait"><span>${waitingFor === "you" ? "your call" : "→ Jev, waiting"}</span><span class="el"></span></div><span class="tag">${esc(id)}</span><span class="chip"></span>`;
  $("parcels").appendChild(c); S.cards[id] = c; c._t0 = performance.now();
  requestAnimationFrame(() => requestAnimationFrame(() => c.classList.add("at")));
  $("scanner").classList.add("flash"); setTimeout(() => $("scanner").classList.remove("flash"), 300);
  return c;
}
setInterval(() => { for (const c of Object.values(S.cards)) if (!c.classList.contains("stamped")) { const el = c.querySelector(".el"); if (el) el.textContent = `${Math.round(performance.now() - c._t0)} ms`; } }, 50);
function stampCard(id, action, label) {
  const c = S.cards[id]; if (!c) return;
  const chip = c.querySelector(".chip"); chip.textContent = NAMES[action]; chip.className = `chip ${action}`;
  if (label) c.querySelector(".wait").innerHTML = `<span>${esc(label)}</span>`;
  c.classList.add("stamped");
  setTimeout(() => { c.style.left = `${$("lanes").offsetLeft - 150}px`; c.style.top = `${laneY(action === "missed" ? "hold" : action)}px`; c.classList.add("gone"); }, 650);
  setTimeout(() => { c.remove(); delete S.cards[id]; }, 1400);
  const laneKey = action === "missed" ? "hold" : action;
  S.lanes[laneKey] = (S.lanes[laneKey] || 0) + 1;
  const lane = document.querySelector(`.lane[data-a=${laneKey}]`);
  setTimeout(() => { lane.querySelector("i").textContent = S.lanes[laneKey]; lane.classList.add("hit"); setTimeout(() => lane.classList.remove("hit"), 500); }, 1000);
}

// ── the current parcel panel ──────────────────────────────────────────────
let PHOTO_CREDITS = {};
function showPhoto(id, url, declared) {
  const c = PHOTO_CREDITS[id]; const cn = document.getElementById("credit-now");
  if (cn) cn.textContent = c ? ` · this photo (${id}): ${c}` : "";
  $("photo-img").src = url; $("pid").textContent = id; $("declared").textContent = `Declared: ${declared}`;
  $("stamp").hidden = true; $("boxov").hidden = true; $("jevmeta").textContent = "waiting for Jev…";
}
function placeBox(ov, confEl, box, img) {
  if (!box) { ov.hidden = true; return; }
  const b = box.box; ov.hidden = false;
  const fw = img.parentElement.clientWidth, fh = img.parentElement.clientHeight;
  const iw = img.naturalWidth || 4, ih = img.naturalHeight || 3; const s = Math.min(fw / iw, fh / ih);
  const ox = (fw - iw * s) / 2, oy = (fh - ih * s) / 2;
  ov.style.left = `${ox + b.left * iw * s}px`; ov.style.top = `${oy + b.top * ih * s}px`;
  ov.style.width = `${(b.right - b.left) * iw * s}px`; ov.style.height = `${(b.bottom - b.top) * ih * s}px`;
  confEl.textContent = box.confidence == null ? "damage (Box)" : `damage (Box) ${box.confidence.toFixed(2)}`;
}
function probRows(container, d) {
  const keys = OPTS.filter((k) => k in d.probabilities);
  container.innerHTML = keys.map((k) => `<div class="row ${k === d.model_choice ? "top" : ""}"><span>${NAMES[k]}</span>
    <div class="track"><div class="fill ${OPT_COLOR[k]}" data-k="${k}"></div></div><b>${d.probabilities[k].toFixed(2)}</b></div>`).join("");
  requestAnimationFrame(() => container.querySelectorAll(".fill").forEach((f) => { f.style.width = `${d.probabilities[f.dataset.k] * 100}%`; }));
}
function showDecision(p) {
  const d = p.decision;
  $("photo-img").src = p.url; $("pid").textContent = p.id; $("declared").textContent = `Declared: ${p.declared}`;
  probRows($("probs"), d);
  $("confv").textContent = d.confidence.toFixed(2);
  const cf = $("conff"); cf.style.width = `${d.confidence * 100}%`;
  cf.className = `fill ${d.confidence < 0.4 ? "red" : d.confidence < 0.8 ? "yellow" : "green"}`;
  $("why").innerHTML = d.action === d.model_choice ? `Jev chose <b>${NAMES[d.action]}</b> (confidence ${d.confidence.toFixed(2)}) · choose() agrees`
                                                    : `Jev said <b>${NAMES[d.model_choice]}</b> → choose() says <b>${NAMES[d.action]}</b>: ${esc(d.why)}`;
  $("jevmeta").textContent = `${p.replay ? "REPLAY · " : "Jev "}${p.ms} ms · ${fmt(p.tokens)} tok`;
  const st = $("stamp"); st.textContent = NAMES[d.action]; st.className = `stamp ${d.action}`; st.hidden = false;
  const img = $("photo-img"); const put = () => placeBox($("boxov"), $("boxconf"), d.box, img);
  if (img.complete) put(); else img.onload = put;
  document.querySelectorAll(".hthumb").forEach((h) => h.classList.toggle("sel", h.dataset.id === p.id && h.dataset.call === p.call_id));
}
function addHistory(p) {
  S.parcels.push(p);
  const h = document.createElement("button"); h.className = `hthumb ${p.decision.action}${p.replay ? " rp" : ""}`;
  h.dataset.id = p.id; h.dataset.call = p.call_id || "";
  h.title = `${p.id} · ${NAMES[p.decision.action]} · click to inspect`;
  h.innerHTML = `<img src="${esc(p.url)}" alt=""><span>${esc(p.id.replace("P-0", ""))}</span>`;
  h.addEventListener("click", () => { showDecision(p); S.insp.follow = false; openInspector(p.call_id); });
  const box = $("history"); box.insertBefore(h, box.children[0] || null);
  while (box.children.length > 13) box.lastChild.remove();
}

// ── counters ──────────────────────────────────────────────────────────────
function setTile(id, v) { const b = $(id); if (b.textContent !== String(v)) { b.textContent = v; b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop"); } }
function showScore(s) {
  setTile("c-parcels", s.parcels); setTile("c-ms", s.jev_ms_avg || "–");
  setTile("c-cost", `$${s.jev_cost_usd.toFixed(5)}`); setTile("c-claims", s.claims_filed);
  setTile("c-near", s.near_miss); $("c-near").parentElement.classList.toggle("bad", s.near_miss > 0);
  setTile("c-correct", s.parcels ? `${Math.round(((s.correct + s.safe) / s.parcels) * 100)}%` : "–");
  setTile("c-gem", s.gemini_calls); $("c-gtok").textContent = fmt(s.gemini_tokens);
}
function resetUI() {
  S.lanes = {}; document.querySelectorAll(".lane i").forEach((i) => (i.textContent = "0"));
  $("parcels").innerHTML = ""; S.cards = {}; S.timeline = []; S.clock = null; S.gems = {}; S.panel = null; S.parcels = []; $("history").innerHTML = "";
  showScore({ parcels: 0, jev_ms_avg: 0, jev_cost_usd: 0, claims_filed: 0, near_miss: 0, correct: 0, safe: 0, gemini_calls: 0, gemini_tokens: 0 });
  $("c-ms").textContent = "–"; $("c-correct").textContent = "–";
  $("final").hidden = true; $("gjson").textContent = ""; $("gthought").textContent = "";
  $("gverdict").textContent = ""; $("gstate").textContent = "waiting for a damaged parcel"; $("gtime").textContent = ""; $("glabel").removeAttribute("src");
  $("slottext").textContent = "state: claim = empty"; $("slot").classList.remove("ready");
  ["claims_clerk", "shift_lead"].forEach((n) => thinking(n, false)); $("gemini").classList.remove("thinking"); setBadge($("gbadge"), null, true);
}

// ── LIVE / REPLAY badges: always from the server's call record ───────────
function setBadge(el, call, small) {
  const sm = small ? " sm" : "";
  if (!call) { el.className = `badge idle${sm}`; el.textContent = small ? "idle" : "no calls yet"; return; }
  if (call.status === "pending" && call.live) { el.className = `badge live${sm}`; el.textContent = "LIVE"; return; }
  if (call.status === "error") { el.className = `badge replay${sm}`; el.textContent = "ERROR"; return; }
  el.className = `badge ${call.live ? "live" : "replay"}${sm}`; el.textContent = call.live ? "LIVE" : "REPLAY";
}

// ── call log (server events, newest first) ────────────────────────────────
let logDirty = false;
function onCall(c) {
  const prev = S.calls.get(c.id); S.calls.set(c.id, { ...(prev || {}), ...c });
  while (S.calls.size > 300) S.calls.delete(S.calls.keys().next().value);
  if (c.status !== "pending") setBadge($("livebadge"), c);
  if (c.kind === "gemini" && S.gems[c.agent]) { S.gems[c.agent].call = c.id; setBadge($("gbadge"), c, true); }
  if (S.insp.open && S.insp.id === c.id && c.status !== "pending") loadInspector(c.id);
  if (!logDirty) { logDirty = true; requestAnimationFrame(renderLog); }
}
function renderLog() {
  logDirty = false;
  const rows = [...S.calls.values()].reverse().slice(0, 5);
  $("calllog").innerHTML = rows.map((c) => {
    const badge = c.status === "pending" ? `<span class="badge sm ${c.live ? "live" : "replay"}">${c.live ? "LIVE" : "REPLAY"}</span>`
      : `<span class="badge sm ${c.status === "error" ? "replay" : c.live ? "live" : "replay"}">${c.status === "error" ? "ERROR" : c.live ? "LIVE" : "REPLAY"}</span>`;
    const what = c.kind === "jev" ? `${c.parcel || ""}${c.decision ? " → " + (NAMES[c.decision] || c.decision) : ""}` : `${c.agent} · ${c.parcel || ""}`;
    const ms = c.status === "pending" ? "…" : c.ms != null ? `${fmt(c.ms)} ms` : "–";
    const tok = c.kind === "jev" ? (c.input_tokens != null ? `${fmt(c.input_tokens)} t` : "") : (c.total_tokens != null ? `${fmt(c.total_tokens)} t` : "");
    return `<div class="crow ${c.kind}${S.insp.id === c.id ? " sel" : ""}" data-id="${c.id}" title="${esc(c.purpose || "")}"><span class="ts">${esc(c.at)}</span>${badge}
      <span class="mdl">${esc(c.model || "")} <span style="color:var(--ink);font-weight:400">${esc(what)}</span></span><span class="ms">${ms}</span><span class="tok">${tok}</span></div>`;
  }).join("") || `<p class="muted" style="margin:6px;font-size:19px">No calls yet. Every Jev and Gemini call the server makes will appear here.</p>`;
}
$("calllog").addEventListener("click", (ev) => { const r = ev.target.closest(".crow"); if (r) { S.insp.follow = false; openInspector(r.dataset.id); } });

// ── Inspector: the exact request and the verbatim response ───────────────
function jsonHtml(text) {
  let pretty = text; try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* not JSON: show as is */ }
  return esc(pretty).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(-?\d+(?:\.\d+)?)\b/g, (m, str, colon, num) =>
    str ? `<span class="${colon ? "k" : "s"}">${str}</span>${colon || ""}` : `<span class="n">${num}</span>`);
}
function openInspector(id) {
  S.insp.open = true; $("inspector").hidden = false; $("t-inspect").classList.add("on"); document.body.classList.add("insp");
  $("i-follow").classList.toggle("on", S.insp.follow); $("i-follow").textContent = S.insp.follow ? "following live" : "pinned · click to follow";
  const target = id || S.insp.id || [...S.calls.values()].reverse().find((c) => c.kind === "jev")?.id;
  if (target) loadInspector(target);
}
function closeInspector() { S.insp.open = false; $("inspector").hidden = true; $("t-inspect").classList.remove("on"); document.body.classList.remove("insp"); }
async function loadInspector(id) {
  S.insp.id = id; renderLog();
  const r = await fetch(`/api/call/${encodeURIComponent(id)}`); if (!r.ok) { $("i-body").innerHTML = `<p class="muted">Call ${esc(id)} is gone from the server's memory.</p>`; return; }
  const c = await r.json(); if (S.insp.id !== id) return;
  setBadge($("i-badge"), c);
  if (c.kind === "jev") renderJev(c); else renderGemini(c);
}
function stat(v, label, cls = "") { return `<div class="istat ${cls}"><b>${v}</b><span>${label}</span></div>`; }
function renderJev(c) {
  $("i-title").textContent = `${c.model || "jev"} · ${c.parcel} · ${c.purpose}${c.decision ? " → " + (NAMES[c.decision] || c.decision) : ""}`;
  $("i-stats").innerHTML = (c.status === "pending" ? stat("…", "in flight") :
    stat(`${fmt(c.ms)} ms`, c.live ? "round trip (server)" : "recorded round trip") +
    (c.wire_ms != null ? stat(`${fmt(Math.round(c.wire_ms))} ms`, "HTTP on the wire") : "") +
    stat(`${fmt(c.input_tokens)} / ${fmt(c.output_tokens)}`, "tokens in / out") +
    stat(c.cost_usd != null ? `$${c.cost_usd.toFixed(6)}` : "$0", c.live ? "cost ($0.042 / 1M in)" : "replay, not billed") +
    stat(c.policy_version ? `v${c.policy_version}` : "custom", "policy version"));
  const req = c.request, res = c.response;
  let left = `<div class="icol"><h3>Request <small>exactly what Jev received</small></h3>`;
  if (req) {
    left += `<div class="reqline">${esc(req.method)} ${esc(req.url)}</div><div class="hdrs">${Object.entries(req.headers).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join("<br>")}</div>`;
    for (const p of req.parts) {
      if (p.json_text != null) left += `<div class="part">part "${esc(p.name)}" · ${esc(p.content_type)} · ${fmt(p.bytes)} bytes (questions + state)</div><pre class="code-j">${jsonHtml(p.json_text)}</pre>`;
      else left += `<div class="part">part "${esc(p.name)}" · ${esc(p.content_type)}</div><div class="asset"><img src="${c.thumb || c.photo_url || ""}" alt=""><div><b>${fmt(p.bytes)} bytes</b> of image, sent as raw bytes in this multipart part<br>as base64: ${esc(p.base64_head)}… truncated (${fmt(p.base64_bytes)} chars)</div></div>`;
    }
  } else {
    left += `<div class="note">${esc(c.replay_note || "No request captured.")}${c.error ? `<br>Reason: ${esc(c.error)}` : ""}</div>${c.thumb ? `<div class="asset"><img src="${c.thumb}" alt=""><div><b>${fmt(c.image_bytes)} bytes</b> image (not sent)</div></div>` : ""}`;
  }
  left += `</div>`;
  let right = `<div class="icol"><h3>Response <small>${res ? `HTTP ${res.status} · ${fmt(res.bytes)} bytes · verbatim` : "no HTTP response"}</small></h3>`;
  if (res) right += `<pre class="code-j">${jsonHtml(res.body_text)}</pre>`;
  else if (c.answers) right += `<div class="note">REPLAY: the answers below come from belt/replay.json, recorded in a rehearsal.</div><pre class="code-j">${jsonHtml(JSON.stringify(c.answers))}</pre>`;
  if (c.decision) right += `<div class="hdrs" style="font-size:16px">choose() in code → <b style="color:var(--ink)">${esc(NAMES[c.decision] || c.decision)}</b> · ${esc(c.why || "")}</div>`;
  right += `</div>`;
  $("i-body").className = "ibody"; $("i-body").innerHTML = left + right;
}
function renderGemini(c) {
  $("i-title").textContent = `${c.model} · ${c.agent} · ${c.parcel || ""}`;
  $("i-stats").innerHTML = c.status === "pending" ? stat("…", "Gemini is thinking", "gem") :
    stat(`${fmt(c.ms)} ms`, "model call, measured by the server", "gem") + stat(fmt(c.input_tokens), "prompt tokens", "gem") +
    stat(fmt(c.thought_tokens), "thinking tokens", "gem") + stat(fmt(c.output_tokens), "output tokens", "gem") + stat(fmt(c.total_tokens), "total tokens", "gem");
  const rq = c.request || {};
  let left = `<div class="icol"><h3>Request <small>built by ADK for ${esc(c.agent)}</small></h3><div class="hdrs">model: ${esc(rq.model)}<br>response_schema: ${esc(rq.response_schema)}<br>${esc(rq.thinking || "")}</div>
    <div class="part">system instruction</div><pre class="code-j" style="flex:0 1 auto;min-height:70px;max-height:230px">${esc(rq.system_instruction)}</pre><div class="part">user content</div><pre class="code-j">${(rq.contents || []).map((p) =>
      p.inline_data ? `[${esc(p.role)}] ${esc(p.inline_data)} · ${fmt(p.bytes)} bytes (the label image)` : `[${esc(p.role)}] ${esc(p.text)}`).join("\n\n")}</pre></div>`;
  let right = `<div class="icol"><h3>Response <small>raw text, verbatim${c.live ? "" : " · REPLAY"}</small></h3>`;
  if (c.thoughts) right += `<div class="part">thought summary (streamed)</div><pre class="code-j" style="flex:0 1 auto;min-height:60px;max-height:150px;font-style:italic">${esc(c.thoughts.slice(-1200))}</pre>`;
  const live = c.status === "pending" ? (S.gems[c.agent]?.json || "") : "";
  right += `<pre class="code-j" id="i-stream" style="min-height:70px">${esc(c.raw_text || live || (c.status === "pending" ? "…waiting for the first token" : ""))}</pre>`;
  if (c.parsed) right += `<div class="part">parsed ${c.agent === "claims_clerk" ? "ClaimPacket" : "ShiftReport"}</div><pre class="code-j" style="flex:0 1 auto;min-height:90px;max-height:300px">${jsonHtml(JSON.stringify(c.parsed))}</pre>`;
  if (c.error) right += `<div class="note">Gemini error, answered from the recording: ${esc(c.error)}</div>`;
  right += `</div>`;
  $("i-body").className = "ibody"; $("i-body").innerHTML = left + right;
}
$("t-inspect").addEventListener("click", () => (S.insp.open ? closeInspector() : openInspector()));
$("i-follow").addEventListener("click", () => {
  S.insp.follow = !S.insp.follow; $("i-follow").classList.toggle("on", S.insp.follow); $("i-follow").textContent = S.insp.follow ? "following live" : "pinned · click to follow";
  const last = S.parcels[S.parcels.length - 1]; if (S.insp.follow && last) { showDecision(last); loadInspector(last.call_id); }
});

// ── Gemini panel (claims_clerk and shift_lead can run at the same time) ─
function gemStart(agent, labelUrl, smudged) {
  S.gems[agent] = { t0: serverNow(), json: "", thought: "", call: null }; S.panel = agent;
  $("gname").textContent = agent; $("gstate").textContent = "thinking…"; $("gjson").textContent = ""; $("gthought").textContent = "";
  $("gboxhead").textContent = "Gemini output, streamed as it arrives";
  $("gverdict").textContent = ""; $("gverdict").className = "gverdict";
  if (labelUrl) $("glabel").src = labelUrl; $("gsmudge").hidden = !smudged;
  $("gemini").classList.add("thinking"); thinking(agent, true); flash(agent, 600);
  $("gbadge").className = "badge sm pending"; $("gbadge").textContent = "calling";
  S.timeline.push({ lane: "gem", start: serverNow(), end: null, agent });
}
function gemText(agent, thought, text) {
  const g = S.gems[agent]; if (!g) return;
  if (thought) g.thought += thought; if (text) g.json += text;
  if (text && S.insp.open && g.call && S.insp.id === g.call && $("i-stream")) $("i-stream").textContent = g.json;
  if (agent === "shift_lead" && text) $("rbody").textContent = g.json;
  if (S.panel !== agent) return;
  if (thought) $("gthought").textContent = "thinking: " + g.thought.replace(/\*\*/g, "").replace(/\s+/g, " ").slice(-140);
  if (text) { $("gjson").textContent = g.json; $("gstate").textContent = "streaming…"; }
}
function gemStop(agent, verdict, ok, packet) {
  const span = S.timeline.findLast((x) => x.lane === "gem" && x.agent === agent && x.end === null); if (span) span.end = serverNow();
  delete S.gems[agent]; thinking(agent, false);
  if (!Object.keys(S.gems).length) $("gemini").classList.remove("thinking");
  if (S.panel === agent) {
    $("gstate").textContent = "done";
    if (packet) { $("gboxhead").textContent = "parsed ClaimPacket (the raw text is in the Inspector)";
      $("gjson").innerHTML = Object.entries(packet).filter(([k]) => k !== "claim_note").map(([k, v]) => `<span><b>${esc(k)}</b>: ${esc(Array.isArray(v) ? v.join(", ") : v)}</span>`).join(""); }
    if (verdict) { $("gverdict").textContent = verdict; $("gverdict").className = `gverdict ${ok ? "ok" : "bad"}`; }
  }
}
setInterval(() => { const g = S.gems[S.panel]; if (g) $("gtime").textContent = `${(serverNow() - g.t0).toFixed(1)} s`; }, 100);
$("gemini").addEventListener("click", () => { const id = [...S.calls.values()].reverse().find((c) => c.kind === "gemini")?.id; if (id) { S.insp.follow = false; openInspector(id); } });

// ── timeline ──────────────────────────────────────────────────────────────
function drawTimeline() {
  const svg = $("timeline"), W = 1110, L = 130, win = 40, now = S.running ? serverNow() : S.lastServerT;
  const t0 = Math.max(0, now - win * 0.9), x = (t) => L + ((t - t0) / win) * (W - L);
  let h = `<defs><linearGradient id="gemgrad"><stop offset="0" stop-color="#7e3ff2"/><stop offset="1" stop-color="#d9c6ff"/></linearGradient></defs>
    <rect class="lanebg" x="${L}" y="6" width="${W - L}" height="48" rx="6"/><rect class="lanebg" x="${L}" y="64" width="${W - L}" height="48" rx="6"/>
    <text class="lname" x="4" y="36" fill="#1a73e8">Jev · fast</text><text class="lname" x="4" y="94">Gemini · slow</text>`;
  for (let s = Math.ceil(t0); s < t0 + win; s += 5) h += `<text class="tick" x="${x(s)}" y="130">${s}s</text>`;
  for (const sp of S.timeline) {
    const end = sp.end ?? now; if (end < t0) continue;
    const xs = Math.max(L, x(sp.start)), w = Math.max(4, x(end) - xs);
    if (sp.lane === "jev") h += `<rect class="jev" x="${xs}" y="10" width="${w}" height="40" rx="3"><title>${esc(sp.label)}</title></rect>`;
    else h += `<rect class="gem ${sp.agent === "shift_lead" ? "lead" : ""} ${sp.end === null ? "run" : ""}" x="${xs}" y="68" width="${w}" height="40" rx="5"/>` +
              (w > 120 ? `<text x="${xs + 8}" y="94" fill="#fff" font-size="16" font-weight="600">${sp.agent} ${(end - sp.start).toFixed(1)} s</text>` : "");
  }
  h += `<line class="now" x1="${x(now)}" x2="${x(now)}" y1="2" y2="114"/>`;
  svg.innerHTML = h; requestAnimationFrame(drawTimeline);
}

// ── events from the server ────────────────────────────────────────────────
function onEvent(e) {
  if (typeof e.t === "number" && e.type !== "run_error" && e.type !== "run_stopped") { syncClock(e.t); S.lastServerT = e.t; }
  switch (e.type) {
    case "call": onCall(e); break;
    case "run_start": $("status").textContent = `${e.jev_model} + ${e.mode === "workflow" ? e.gemini_model : "no LLM"} · pace ${e.pace} s`; break;
    case "adk": onAdk(e); if (e.thought || e.text) gemText(e.author, e.thought, e.text); break;
    case "parcel": newCard(e.id, e.url); if (S.insp.follow) showPhoto(e.id, e.url, e.declared); $("status").textContent = `parcel ${e.n} of ${e.total}`; break;
    case "jev_start": flash("tick", 260); break;
    case "decision": {
      S.timeline.push({ lane: "jev", start: e.started, end: e.started + e.ms / 1000, label: `${e.id} ${e.ms} ms` });
      const p = { id: e.id, url: e.url, declared: e.declared, decision: e.decision, call_id: e.call_id, ms: e.ms, tokens: e.tokens, replay: e.replay, model: e.model, outcome: e.outcome };
      stampCard(e.id, e.decision.action, `${e.replay ? "REPLAY" : "Jev"} ${e.ms} ms`); addHistory(p); showScore(e.score);
      if (S.insp.follow) { showDecision(p); if (S.insp.open) loadInspector(e.call_id); }
      if (e.claim_used) { $("slottext").textContent = "state: claim = empty"; $("slot").classList.remove("ready"); }
      break; }
    case "check": flash("check_claim", 200); break;
    case "wait_slow": $("status").textContent = "last parcel sorted · waiting for claims_clerk"; break;
    case "gemini_start": gemStart("claims_clerk", e.url, e.smudged); litEdge("enter", "read_label"); break;
    case "gemini_replay": break;   // the call record (live=false) sets the badge
    case "claim": {
      const g = e.graded; const ok = e.ok;
      gemStop("claims_clerk", ok ? `code checked it: CORRECT → claim ready (${e.took} s)` : `code checked it: WRONG (${!g.zip_ok ? "ZIP" : !g.tracking_ok ? "tracking" : "marks"}) → ${e.retry ? "retry" : "stop"}`, ok, e.packet);
      flash("claim_ready", 700);
      if (ok) { $("slottext").textContent = "state: claim = READY"; $("slot").classList.add("ready"); flash("rest"); }
      else if (e.retry) litEdge("claim_ready", "read_label");
      break; }
    case "summary_start": showScore(e.score); gemStart("shift_lead", null, false); $("glabel").removeAttribute("src"); openFinal(e.score, true); break;
    case "run_end": S.running = false; document.body.classList.remove("running"); setGo();
      Object.keys(S.gems).forEach((a) => gemStop(a)); showScore(e.score); openFinal(e.score, false, e.report); $("status").textContent = "shift over"; flash("finish", 1200); break;
    case "run_error": S.running = false; document.body.classList.remove("running"); setGo(); $("status").textContent = "error · see terminal"; console.error(e.error); break;
    case "run_stopped": S.running = false; document.body.classList.remove("running"); setGo(); $("status").textContent = "stopped"; break;
    case "policy": showPolicy(e); break;
  }
}
function openFinal(s, writing, report) {
  $("final").hidden = false;
  $("score").innerHTML = [["parcels", s.parcels], ["correct or safe", `${s.correct + s.safe}`], ["near-miss ships", s.near_miss], ["claims filed", s.claims_filed],
    ["ms per decision (Jev)", s.jev_ms_avg], ["Jev cost", `$${s.jev_cost_usd.toFixed(5)}`], ["Gemini calls", s.gemini_calls], ["wrong", s.wrong]]
    .map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join("");
  if (S.mode !== "workflow") { $("rhead").textContent = "No LLM in this mode"; $("rbody").textContent = "Jev sorted every parcel. Nobody read the labels, so no claims were filed."; $("rstate").textContent = ""; return; }
  $("rstate").textContent = writing ? "writing…" : "done";
  if (writing) { $("rhead").textContent = ""; $("rbody").textContent = ""; }
  if (report) { $("rhead").textContent = report.headline || ""; $("rbody").textContent = report.report || ""; }
}

const es = new EventSource("/api/events");
es.onmessage = (m) => onEvent(JSON.parse(m.data));

// ── controls ──────────────────────────────────────────────────────────────
function setGo() { const b = $("go"); b.textContent = S.running ? "STOP" : "START"; b.classList.toggle("stop", S.running); }
const CRUMB = { you: "Demo 1 · a person sorts", workflow: "Google ADK Workflow · Jev 1.14 + Gemini" };
function setMode(m) {
  if (S.running) return;
  S.mode = m; document.body.dataset.mode = m; $("crumb-mode").textContent = CRUMB[m];
  document.querySelectorAll("#modes button").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  $("manual").hidden = m !== "you";
  $("c-ms-l").textContent = m === "you" ? "ms per decision (you)" : "ms per decision (Jev)";
  document.querySelector(".graph").style.opacity = m === "you" ? 0.35 : 1;
  document.querySelector(".gemini").style.opacity = m === "workflow" ? 1 : 0.35;
  setGo();
}
document.querySelectorAll("#modes button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
$("go").addEventListener("click", () => {
  if (S.running) { if (S.mode === "you") S.running = false; else post("/api/stop"); setGo(); return; }
  resetUI(); S.running = true; document.body.classList.add("running"); setGo();
  if (S.mode === "you") return youSort();
  const q = new URLSearchParams(location.search);
  post("/api/run", { mode: S.mode, limit: q.get("limit") ? +q.get("limit") : null, pace: +$("pace").value });
});
const typing = (k) => ["INPUT", "TEXTAREA", "SELECT"].includes(k.target.tagName);
addEventListener("keydown", (k) => {
  if (k.key === "Escape") { $("final").hidden = true; $("context").hidden = true; $("policy").hidden = true; closeInspector(); return; }
  if (typing(k)) return;
  if (!S.running && (k.key === "1" || k.key === "3")) return setMode(k.key === "1" ? "you" : "workflow");
  if (S.mode === "you" && S.pending) { const a = { s: "ship", r: "retape", h: "hold", x: "return" }[k.key.toLowerCase()]; if (a) return S.pending(a); }
  const key = k.key.toLowerCase();
  if (key === "i") return S.insp.open ? closeInspector() : openInspector();
  if (key === "c") return openContext();
  if (key === "p") return openPolicy();
});
document.querySelectorAll("#manual button").forEach((b) => b.addEventListener("click", () => S.pending && S.pending(b.dataset.a)));
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => (b.dataset.close === "inspector" ? closeInspector() : ($(b.dataset.close).hidden = true))));

// ── You sort: a person at the belt, 2.5 s per parcel ──────────────────────
async function youSort() {
  const { parcels } = await (await fetch("/api/manifest")).json();
  const per = 2500; S.youTimes = []; let correct = 0, n = 0;
  for (const p of parcels.slice(0, 20)) {
    if (!S.running) break;
    newCard(p.id, p.url, "you"); showPhoto(p.id, p.url, p.declared); $("jevmeta").textContent = "a person decides";
    const t0 = performance.now(); const bar = $("mtimer"); bar.style.transition = "none"; bar.style.width = "0";
    requestAnimationFrame(() => { bar.style.transition = `width ${per}ms linear`; bar.style.width = "100%"; });
    const action = await new Promise((res) => { S.pending = res; setTimeout(() => res("missed"), per); });
    S.pending = null; n++;
    if (action !== "missed") {
      S.youTimes.push(performance.now() - t0);
      const r = await (await post("/api/judge", { id: p.id, action })).json();
      if (r.outcome === "correct" || r.outcome === "safe") correct++;
    }
    stampCard(p.id, action, action === "missed" ? "too slow" : `you ${Math.round(performance.now() - t0)} ms`);
    const st = $("stamp"); st.textContent = NAMES[action]; st.className = `stamp ${action}`; st.hidden = false;
    setTile("c-parcels", n); setTile("c-correct", `${Math.round((correct / n) * 100)}%`);
    if (S.youTimes.length) setTile("c-ms", Math.round(S.youTimes.reduce((a, b) => a + b, 0) / S.youTimes.length));
    await new Promise((r) => setTimeout(r, Math.max(0, per - (performance.now() - t0))));
  }
  S.running = false; document.body.classList.remove("running"); setGo(); $("status").textContent = "your shift is over";
}

// ── Context test: same photo, two declared contents ──────────────────────
async function loadPhotos() { if (!S.photos.length) S.photos = (await (await fetch("/api/photos")).json()).photos; return S.photos; }
let ctxPhoto = "DEMO-DENTED";
async function openContext() {
  $("context").hidden = false; const photos = await loadPhotos();
  const pick = photos.filter((p) => p.id.startsWith("DEMO") || ["dented", "crushed", "clean", "fragile"].includes(p.kind)).slice(0, 12);
  $("ctx-pick").innerHTML = pick.map((p) => `<button data-id="${p.id}" class="${p.id === ctxPhoto ? "on" : ""}" title="${esc(p.id)}"><img src="${esc(p.url)}" alt=""></button>`).join("");
  $("ctx-img").src = `/api/photo/${ctxPhoto}.jpg`;
  for (const t of "AB") if (!$(`ctx-${t}`).innerHTML) $(`ctx-${t}`).innerHTML = `<h3>${t} · press RUN BOTH</h3>`;
}
$("ctx-pick").addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (!b) return; ctxPhoto = b.dataset.id; $("ctx-img").src = `/api/photo/${ctxPhoto}.jpg`;
  document.querySelectorAll("#ctx-pick button").forEach((x) => x.classList.toggle("on", x === b)); });
function sideHtml(s) {
  const d = s.decision, top = d.model_choice;
  return `<h3>${s.tag} · declared contents</h3><div class="decl">“${esc(s.declared)}”</div>
    <div class="bigstamp stamp-static chip ${d.action}">${NAMES[d.action]}</div>
    <div class="probs">${OPTS.filter((k) => k in d.probabilities).map((k) => `<div class="row ${k === top ? "top" : ""}"><span>${NAMES[k]}</span><div class="track"><div class="fill ${OPT_COLOR[k]}" style="width:${d.probabilities[k] * 100}%"></div></div><b>${d.probabilities[k].toFixed(2)}</b></div>`).join("")}</div>
    <div class="whyline">confidence ${d.confidence.toFixed(2)} · ${d.action === top ? "choose() agrees" : esc(d.why)}</div>
    <div class="meta"><span class="badge sm ${s.live ? "live" : "replay"}">${s.live ? "LIVE" : "REPLAY"}</span>${esc(s.model)} · ${s.ms} ms · ${fmt(s.input_tokens)} tok · <a data-call="${s.call_id}">inspect request</a></div>`;
}
$("ctx-run").addEventListener("click", async () => {
  $("ctx-run").disabled = true; for (const t of "AB") { $(`ctx-${t}`).classList.add("wait"); $(`ctx-${t}`).innerHTML = `<h3>${t} · asking Jev…</h3>`; }
  const r = await post("/api/context-test", { photo: ctxPhoto, a: $("ctx-a").value, b: $("ctx-b").value });
  $("ctx-run").disabled = false;
  if (!r.ok) { $("ctx-A").innerHTML = `<h3>error ${r.status}</h3>${esc(await r.text())}`; return; }
  const j = await r.json();
  j.sides.forEach((s) => { const el = $(`ctx-${s.tag}`); el.classList.remove("wait"); el.innerHTML = sideHtml(s); });
  $("ctx-note").innerHTML = j.different
    ? `<b>Same pixels, two different decisions.</b> A fixed-class detector (YOLO) would output the same boxes for both photos. Jev read the declared contents: one call each, same policy (${esc(j.policy)}), same code.`
    : `Same decision for both this time (${NAMES[j.sides[0].decision.action]}). Compare the probabilities: they still moved with the words. Try a dented box.`;
});
$("policy").addEventListener("click", (ev) => { const a = ev.target.closest("a[data-call]"); if (a) { $("policy").hidden = true; S.insp.follow = false; openInspector(a.dataset.call); } });
$("context").addEventListener("click", (ev) => { const a = ev.target.closest("a[data-call]"); if (a) { $("context").hidden = true; S.insp.follow = false; openInspector(a.dataset.call); } });

// ── Policy editor ─────────────────────────────────────────────────────────
const PROBE_FOR = { hazmat: "DEMO-BATTERY", peak: "DEMO-DENTED" };
let probePhoto = "DEMO-BATTERY", draftPreset = null;
function showPolicy(p) {
  S.policy = p;
  $("polchip").textContent = `policy v${p.version}: ${p.name}`; $("polchip").classList.toggle("changed", p.changed.length > 0);
  $("pol-secs").textContent = p.first_decision_s != null ? `${p.first_decision_s.toFixed(1)} s` : p.applied_at ? "… waiting for the next Jev call" : "–";
  $("pol-secs-l").textContent = p.applied_at ? " (Apply → first Jev answer)" : "";
}
function codeHtml(t) {
  return `<span class="c"># belt/reflex.py · choose() · thresholds stay in code</span>
TRUST_CONFIDENCE = <span class="t">${t.TRUST_CONFIDENCE.toFixed(2)}</span>
AUTO_SHIP        = <span class="t">${t.AUTO_SHIP.toFixed(2)}</span>
SEVERE_RISK      = <span class="t">${t.SEVERE_RISK.toFixed(2)}</span>
CLAIM_ON_DAMAGE  = <span class="t">${t.CLAIM_ON_DAMAGE.toFixed(2)}</span>

if confidence &lt; TRUST and risk &gt;= SEVERE: hold
if claim ready and hold/return and damaged &gt;= 0.60:
    file_claim
if ship and confidence &lt; AUTO_SHIP: spot_check
if retape and handling is fragile: hold
<span class="c"># the policy editor changes only the option text</span>`;
}
function renderOpts(options, base) {
  $("opts").innerHTML = ["ship", "retape", "hold", "return", "file_claim"].map((k) =>
    `<div class="opt ${options[k] !== base[k] ? "changed" : ""}" data-k="${k}"><b class="chip ${k}" style="border:0;background:none">${NAMES[k]}</b><textarea data-k="${k}">${esc(options[k])}</textarea></div>`).join("");
}
$("opts").addEventListener("input", (ev) => { const t = ev.target; if (t.dataset.k && S.policy) { t.parentElement.classList.toggle("changed", t.value !== S.policy.default[t.dataset.k]); draftPreset = null; $("pol-msg").textContent = "edited by hand · press APPLY"; } });
async function openPolicy() {
  $("policy").hidden = false;
  const p = await (await fetch("/api/policy")).json(); showPolicy(p);
  $("presets").innerHTML = Object.entries(p.presets).map(([k, v]) => `<button data-p="${k}" class="${k === p.preset ? "on" : ""}">${esc(v.name.replace("->", "→"))}</button>`).join("");
  renderOpts(p.options, p.default); $("pol-code").innerHTML = codeHtml(p.thresholds);
  const photos = await loadPhotos();
  $("probe-pick").innerHTML = photos.filter((x) => x.id.startsWith("DEMO")).map((x) => `<button data-id="${x.id}" class="${x.id === probePhoto ? "on" : ""}"><img src="${esc(x.url)}" alt=""></button>`).join("");
  $("probe-img").src = `/api/photo/${probePhoto}.jpg`;
  if (!$("probe-before").innerHTML) runProbe("probe-before", "now");
}
$("presets").addEventListener("click", (ev) => {
  const b = ev.target.closest("button"); if (!b || !S.policy) return;
  draftPreset = b.dataset.p; document.querySelectorAll("#presets button").forEach((x) => x.classList.toggle("on", x === b));
  renderOpts(S.policy.presets[draftPreset].options, S.policy.default); $("pol-msg").textContent = "preset loaded · press APPLY";
  if (PROBE_FOR[draftPreset] && PROBE_FOR[draftPreset] !== probePhoto) { probePhoto = PROBE_FOR[draftPreset]; setProbePhoto(); }
});
function setProbePhoto() {
  $("probe-img").src = `/api/photo/${probePhoto}.jpg`; document.querySelectorAll("#probe-pick button").forEach((x) => x.classList.toggle("on", x.dataset.id === probePhoto));
  $("probe-after").innerHTML = ""; runProbe("probe-before", "now");
}
$("probe-pick").addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) { probePhoto = b.dataset.id; setProbePhoto(); } });
async function runProbe(slot, label) {
  $(slot).innerHTML = `<h4>${esc(label)} · asking Jev…</h4>`;
  const r = await post("/api/policy/probe", { photo: probePhoto });
  if (!r.ok) { $(slot).innerHTML = `<h4>error ${r.status}</h4>`; return; }
  const j = await r.json(); const d = j.decision;
  $(slot).innerHTML = `<h4>${esc(label)} · policy v${j.policy_version}: ${esc(j.policy.replace("->", "→"))}</h4>
    <div class="row2"><span class="st chip ${d.action}">${NAMES[d.action]}</span><span>${esc(d.model_choice)} ${d.probabilities[d.model_choice].toFixed(2)} · confidence ${d.confidence.toFixed(2)}</span></div>
    <div class="row2"><span class="badge sm ${j.live ? "live" : "replay"}">${j.live ? "LIVE" : "REPLAY"}</span><span>${esc(j.model)} · ${j.ms} ms · <a data-call="${j.call_id}" style="color:var(--blue-d);text-decoration:underline;cursor:pointer">inspect</a></span></div>`;
  if (j.first_decision_s != null) $("pol-secs").textContent = `${j.first_decision_s.toFixed(1)} s`;
}
$("pol-apply").addEventListener("click", async () => {
  const options = {}; document.querySelectorAll("#opts textarea").forEach((t) => { options[t.dataset.k] = t.value; });
  const body = draftPreset ? { preset: draftPreset } : { options, name: "Edited on stage" };
  const r = await post("/api/policy", body);
  if (!r.ok) { $("pol-msg").textContent = `not applied: ${(await r.json()).detail}`; return; }
  const p = await r.json(); showPolicy(p); renderOpts(p.options, p.default);
  $("pol-msg").textContent = `applied v${p.version} · ${new Date().toLocaleTimeString()} · the next Jev call uses it`;
  runProbe("probe-after", "after Apply");
});

// ── photo credit ──────────────────────────────────────────────────────────
fetch("/api/photo-source").then((r) => r.json()).then((p) => {
  PHOTO_CREDITS = p.per_photo || {};
  $("credit").innerHTML = `Photos: <b>${p.real ? "real" : "synthetic placeholders"}</b> · ${esc(p.credit)}${p.credits_file ? ` · ${esc(p.credits_file)}` : ""}<span id="credit-now"></span>`;
});
fetch("/api/calls").then((r) => r.json()).then((j) => j.calls.forEach(onCall));
fetch("/api/policy").then((r) => r.json()).then(showPolicy);

drawGraph(); requestAnimationFrame(drawTimeline); renderLog();
setMode(new URLSearchParams(location.search).get("mode") || "workflow");
