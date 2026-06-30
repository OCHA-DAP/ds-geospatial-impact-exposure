"use strict";

const BREAKS = [1, 250, 1000, 5000, 20000, 50000];
const COLORS = ["#f3f3ef", "#ffffb2", "#fed976", "#feb24c", "#fd8d3c", "#f03b20", "#bd0026"];
const BASEMAP = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const fmt = new Intl.NumberFormat("en-US");

// metric = damage-aggregation method; sector = HNO need sector ("none" = no need overlay)
// mapShow = whether the choropleth shades total exposed or sector exposed-in-need
const state = {
  metric: "any", sector: "ALL", level: "adm1", mapShow: "total", showSources: false,
  data: null, geo: {}, recs: {}, sel: null,
};
const BAR_LIGHT = "#fdc6a8", BAR_DARK = "#cb181d";
// Venezuela extent — clamp the map so you can't zoom/pan far past the country
const VE_BOUNDS = [[-75, -0.5], [-58.5, 13.5]];

function colorExpr(prop) {
  const stops = [];
  for (let i = 0; i < BREAKS.length; i++) stops.push(BREAKS[i], COLORS[i + 1]);
  return ["step", ["coalesce", ["get", prop], -1], "rgba(0,0,0,0)", -0.5, COLORS[0], ...stops];
}

// PiN / population (uncapped — can exceed 100% in displacement areas)
function pinShare(r, sector) {
  if (sector === "none") return null;
  const nd = r.need;
  if (!nd || nd.pop == null || nd.pin[sector] == null) return null;
  return nd.pin[sector] / nd.pop;
}
function totalExp(r, source) { return r.sources[source].pop; }
// exposed AND in need for the current sector (prevalence capped at 100%)
function expInNeed(r, source) {
  if (state.sector === "none") return null;
  const s = pinShare(r, state.sector);
  return s == null ? null : Math.round(totalExp(r, source) * Math.min(1, s));
}
function mapVal(r) {
  return state.mapShow === "sector" ? expInNeed(r, state.metric) : totalExp(r, state.metric);
}

function bbox(fc) {
  let [x0, y0, x1, y1] = [180, 90, -180, -90];
  const walk = (c) => {
    if (typeof c[0] === "number") {
      x0 = Math.min(x0, c[0]); y0 = Math.min(y0, c[1]);
      x1 = Math.max(x1, c[0]); y1 = Math.max(y1, c[1]);
    } else c.forEach(walk);
  };
  fc.features.forEach((f) => walk(f.geometry.coordinates));
  return [[x0, y0], [x1, y1]];
}

function decorate(level) {
  const recs = state.recs[level];
  const idKey = level === "adm1" ? "adm1_id" : "adm2_id";
  state.geo[level].features.forEach((f) => {
    const r = recs[f.properties[idKey]];
    f.properties._rec = r ? JSON.stringify(r) : null;
    const v = r ? mapVal(r) : null;
    f.properties._disp = v == null ? -1 : v;
  });
}
function redecorate() {
  ["adm1", "adm2"].forEach((lvl) => {
    decorate(lvl);
    if (map && map.getSource(lvl)) map.getSource(lvl).setData(state.geo[lvl]);
  });
}

let map;
function initMap() {
  map = new maplibregl.Map({
    container: "map", style: BASEMAP, center: [-66.5, 9.6], zoom: 5.6,
    minZoom: 5, maxBounds: VE_BOUNDS, attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.on("load", () => {
    ["adm2", "adm1"].forEach((lvl) => {
      map.addSource(lvl, { type: "geojson", data: state.geo[lvl] });
      map.addLayer({
        id: lvl + "-fill", type: "fill", source: lvl,
        paint: { "fill-color": colorExpr("_disp"), "fill-opacity": 0.78 },
        layout: { visibility: lvl === state.level ? "visible" : "none" },
      });
      map.addLayer({
        id: lvl + "-line", type: "line", source: lvl,
        paint: { "line-color": "#666", "line-width": lvl === "adm1" ? 0.6 : 0.3 },
        layout: { visibility: lvl === state.level ? "visible" : "none" },
      });
      map.addLayer({
        id: lvl + "-sel", type: "line", source: lvl,
        paint: { "line-color": "#000", "line-width": 2 },
        filter: ["==", lvl === "adm1" ? "adm1_id" : "adm2_id", "__none__"],
        layout: { visibility: lvl === state.level ? "visible" : "none" },
      });
      map.on("mousemove", lvl + "-fill", (e) => onHover(e, lvl));
      map.on("mouseleave", lvl + "-fill", () => { popup.remove(); map.getCanvas().style.cursor = ""; });
      map.on("click", lvl + "-fill", (e) =>
        select(e.features[0].properties[lvl === "adm1" ? "adm1_id" : "adm2_id"]));
    });
    fitToData(0);
  });
}

function fitToData(duration) {
  const dataFeats = state.geo.adm1.features.filter((f) => f.properties._rec);
  map.fitBounds(bbox({ features: dataFeats.length ? dataFeats : state.geo.adm1.features }),
    { padding: 24, duration });
}

const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "290px" });
function onHover(e, lvl) {
  map.getCanvas().style.cursor = "pointer";
  const p = e.features[0].properties;
  if (!p._rec) return;
  const r = JSON.parse(p._rec);
  const meta = state.data.meta;
  const rows = meta.metrics.map((m) => {
    const on = m === state.metric ? ' style="font-weight:650;color:#bd0026"' : "";
    return `<tr${on}><td class="k">${meta.labels[m]}</td><td>${fmt.format(totalExp(r, m))}</td></tr>`;
  }).join("");
  let needLine = "";
  if (state.sector !== "none") {
    const pin = r.need && r.need.pin ? r.need.pin[state.sector] : null;
    const share = pinShare(r, state.sector);
    const inNeed = expInNeed(r, state.metric);
    const lbl = sectorLabel(state.sector);
    needLine = `<div style="margin-top:5px;border-top:1px solid #eee;padding-top:4px;font-size:11px;color:#6b6b6b">` +
      (pin == null ? `${lbl}: no HNO data` :
        `${lbl}: ${fmt.format(pin)} PiN (${(share * 100).toFixed(0)}% of pop) → ` +
        `<b style="color:#cb181d">${fmt.format(inNeed)}</b> exposed &amp; in need`) +
      `</div>`;
  }
  popup.setLngLat(e.lngLat).setHTML(
    `<div class="popup"><h4>${r.name}</h4>` +
    `<div style="color:#6b6b6b;font-size:11px;margin-bottom:4px">people exposed by method</div>` +
    `<table>${rows}</table>${needLine}</div>`
  ).addTo(map);
}

function sectorLabel(code) {
  const s = state.data.meta.sectors.find((x) => x.code === code);
  return s ? s.label : code;
}

function setMetric(m) {
  state.metric = m; sortKey = null;
  document.getElementById("metric").value = m;
  redecorate(); renderTable(); renderBars();
}
function setSector(s) {
  state.sector = s;
  document.getElementById("sector").value = s;
  // if the map is showing the (now removed) sector but sector is none, fall back
  if (s === "none" && state.mapShow === "sector") setMapShow("total");
  else redecorate();
  renderTable(); renderBars(); renderLegend();
  document.querySelector('#mapshow button[data-show="sector"]').textContent =
    s === "none" ? "In need" : `In ${sectorLabel(s)} need`;
}
function setShowSources(on) {
  state.showSources = on; sortKey = null;
  renderTable();
}
function setMapShow(mode) {
  state.mapShow = mode;
  document.querySelectorAll("#mapshow button").forEach((b) =>
    b.classList.toggle("on", b.dataset.show === mode));
  redecorate(); renderLegend();
}
function setLevel(lvl) {
  state.level = lvl; state.sel = null;
  document.querySelectorAll("#level button").forEach((b) =>
    b.classList.toggle("on", b.dataset.level === lvl));
  ["adm1", "adm2"].forEach((l) => {
    const vis = l === lvl ? "visible" : "none";
    [l + "-fill", l + "-line", l + "-sel"].forEach((id) =>
      map.getLayer(id) && map.setLayoutProperty(id, "visibility", vis));
  });
  renderTable(); renderBars();
}

function select(pcode) {
  if (state.sel === pcode) { deselect(); return; } // click again -> unselect + zoom out
  state.sel = pcode;
  const lvl = state.level;
  const idKey = lvl === "adm1" ? "adm1_id" : "adm2_id";
  map.setFilter(lvl + "-sel", ["==", idKey, pcode || "__none__"]);
  document.querySelectorAll("#table tbody tr, #bars .vbar").forEach((el) =>
    el.classList.toggle("sel", el.dataset.pcode === pcode));
  const f = state.geo[lvl].features.find((x) => x.properties[idKey] === pcode);
  if (f) {
    const tr = document.querySelector(`#table tbody tr[data-pcode="${pcode}"]`);
    if (tr) tr.scrollIntoView({ block: "nearest" });
    map.fitBounds(bbox({ features: [f] }), { padding: 60, maxZoom: 10, duration: 600 });
  }
}

function deselect() {
  state.sel = null;
  const lvl = state.level;
  map.setFilter(lvl + "-sel", ["==", lvl === "adm1" ? "adm1_id" : "adm2_id", "__none__"]);
  document.querySelectorAll("#table tbody tr.sel, #bars .vbar.sel").forEach((el) => el.classList.remove("sel"));
  fitToData(600);
}

let sortKey = null, sortDir = -1;
function renderTable() {
  const recs = state.data[state.level];
  const labels = state.data.meta.labels;
  const showNeed = state.sector !== "none";
  const sLbl = sectorLabel(state.sector);
  const dash = "·";

  // build column descriptors
  const cols = [];
  if (state.showSources) {
    state.data.meta.metrics.filter((m) => m !== "agree2").forEach((m) => cols.push({
      k: m, on: m === state.metric, title: `${labels[m]} — total people exposed`,
      head: shortLabel(m), val: (r) => totalExp(r, m),
      fmt: (r) => (totalExp(r, m) ? fmt.format(totalExp(r, m)) : dash),
    }));
  } else {
    cols.push({
      k: "exp", title: `${labels[state.metric]} — total people exposed`,
      head: `<span class="sw" style="background:${BAR_LIGHT}"></span>People exposed`,
      val: (r) => totalExp(r, state.metric),
      fmt: (r) => (totalExp(r, state.metric) ? fmt.format(totalExp(r, state.metric)) : dash),
    });
  }
  if (showNeed) {
    cols.push({
      k: "pinexp", cls: "pin-exp", title: `${sLbl}: exposed & in need (${labels[state.metric]})`,
      head: `<span class="sw" style="background:${BAR_DARK}"></span>${sLbl} PiN exposed`,
      val: (r) => expInNeed(r, state.metric) ?? -1,
      fmt: (r) => { const v = expInNeed(r, state.metric); return v ? fmt.format(v) : dash; },
    });
    cols.push({
      k: "pin", title: `${sLbl} total People in Need (HNO 2025)`, head: "Total PiN",
      val: (r) => (r.need && r.need.pin ? (r.need.pin[state.sector] ?? -1) : -1),
      fmt: (r) => (r.need && r.need.pin && r.need.pin[state.sector] != null ? fmt.format(r.need.pin[state.sector]) : dash),
    });
    cols.push({
      k: "prev", title: "sector PiN as a share of the admin's total population", head: "PiN as % of total pop.",
      val: (r) => pinShare(r, state.sector) ?? -1,
      fmt: (r) => { const s = pinShare(r, state.sector); return s == null ? dash : (s * 100).toFixed(0) + "%"; },
    });
  }

  const defKey = state.showSources ? state.metric : "exp";
  const key = sortKey || defKey;
  const col = cols.find((c) => c.k === key);
  const valFn = col ? col.val : (r) => totalExp(r, state.metric);
  // value columns default to DESCENDING (sortDir -1 -> largest first); name asc
  const sorted = [...recs].sort((a, b) =>
    key === "name" ? sortDir * a.name.localeCompare(b.name) : sortDir * (valFn(a) - valFn(b)));

  const thead = document.querySelector("#table thead");
  thead.innerHTML = "<tr>" +
    `<th data-k="name" class="${key === "name" ? "sorted" : ""}">${state.level === "adm1" ? "State" : "Municipality"}</th>` +
    cols.map((c) =>
      `<th data-k="${c.k}" class="${c.on ? "metric-on" : ""} ${key === c.k ? "sorted" : ""}" title="${c.title}">${c.head}</th>`).join("") +
    "</tr>";
  const tbody = document.querySelector("#table tbody");
  tbody.innerHTML = sorted.map((r) =>
    `<tr data-pcode="${r.pcode}" class="${r.pcode === state.sel ? "sel" : ""}">` +
    `<td title="${r.name}">${r.name}</td>` +
    cols.map((c) => `<td class="${c.cls || ""} ${c.on ? "metric-on" : ""}">${c.fmt(r)}</td>`).join("") +
    "</tr>").join("");

  thead.querySelectorAll("th").forEach((th) => (th.onclick = () => {
    const k = th.dataset.k;
    if (sortKey === k) sortDir *= -1;
    else { sortKey = k; sortDir = k === "name" ? 1 : -1; }
    renderTable();
  }));
  tbody.querySelectorAll("tr").forEach((tr) => (tr.onclick = () => select(tr.dataset.pcode)));
}

const SHORT = {
  microsoft: "MS", copernicus_ems: "CEMS", impact_initiatives: "SAR", osu: "OSU",
  any: "Any", agree2: "≥2",
};
function shortLabel(m) { return SHORT[m] || m; }

const BAR_NAME_H = 58; // px reserved for the (fixed-height) name row under each column
const fmtK = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
function renderBars() {
  const recs = state.data[state.level], m = state.metric;
  const hasSector = state.sector !== "none";
  const rows = recs.map((r) => ({ r, total: totalExp(r, m), sec: hasSector ? (expInNeed(r, m) || 0) : 0 }))
    .sort((a, b) => b.total - a.total);
  const max = Math.max(1, ...rows.map((x) => x.total));
  const nat = state.data.meta.national[m].pop;
  document.getElementById("bc-title").innerHTML =
    `<span class="sw" style="background:${BAR_LIGHT}"></span>${state.data.meta.labels[m]}: ${fmt.format(nat)} exposed` +
    (hasSector ? ` · <span class="sw" style="background:${BAR_DARK}"></span>in ${sectorLabel(state.sector)} need` : "") +
    ` · per ${state.level === "adm1" ? "state" : "municipality"}`;
  const barsEl = document.getElementById("bars");
  const valH = hasSector ? 30 : 16; // headroom for one or two value lines
  const plotPx = Math.max(30, (barsEl.clientHeight || 360) - BAR_NAME_H - valH);
  barsEl.innerHTML = rows.map((x) => {
    const h = Math.max(1, (x.total / max) * plotPx);
    const sh = x.total > 0 ? ((x.sec / x.total) * 100).toFixed(2) : 0;
    const t = `${x.r.name}: ${fmt.format(x.total)} exposed` +
      (hasSector ? ` · ${fmt.format(Math.round(x.sec))} also in need` : "");
    const valHtml = `<span class="vv-total">${fmtK.format(x.total)}</span>` +
      (hasSector ? `<span class="vv-sec">${fmtK.format(Math.round(x.sec))}</span>` : "");
    return `<div class="vbar ${x.r.pcode === state.sel ? "sel" : ""}" data-pcode="${x.r.pcode}" title="${t}">` +
      `<div class="vbar-val">${valHtml}</div>` +
      `<div class="vbar-col" style="height:${h.toFixed(1)}px"><div class="vbar-sec" style="height:${sh}%"></div></div>` +
      `<div class="vbar-name">${x.r.name}</div></div>`;
  }).join("");
  document.querySelectorAll("#bars .vbar").forEach((el) => (el.onclick = () => select(el.dataset.pcode)));
}

function renderLegend() {
  const swatch = (c, lbl) => `<i style="background:${c}"></i>${lbl ? `<span>${lbl}</span>` : ""}`;
  const parts = [swatch(COLORS[0], "0")];
  BREAKS.forEach((b, i) => parts.push(swatch(COLORS[i + 1], fmt.format(b))));
  const what = state.mapShow === "sector" && state.sector !== "none"
    ? `exposed &amp; in ${sectorLabel(state.sector)} need` : "people exposed";
  document.getElementById("legend").innerHTML = `<span style="margin-right:4px">${what}</span>` + parts.join("");
}

async function boot() {
  const [data, g1, g2] = await Promise.all([
    fetch("./data/exposure.json").then((r) => r.json()),
    fetch("./data/adm1.geojson").then((r) => r.json()),
    fetch("./data/adm2.geojson").then((r) => r.json()),
  ]);
  state.data = data;
  state.geo = { adm1: g1, adm2: g2 };
  state.recs = {
    adm1: Object.fromEntries(data.adm1.map((r) => [r.pcode, r])),
    adm2: Object.fromEntries(data.adm2.map((r) => [r.pcode, r])),
  };
  decorate("adm1"); decorate("adm2");

  document.getElementById("event").textContent = data.meta.event;
  document.getElementById("note").textContent = data.meta.note;
  document.getElementById("popsrc").textContent = data.meta.population;

  const sel = document.getElementById("metric");
  sel.innerHTML = data.meta.metrics.map((m) => `<option value="${m}">${data.meta.labels[m]}</option>`).join("");
  sel.value = state.metric;
  sel.onchange = () => setMetric(sel.value);

  const sectorSel = document.getElementById("sector");
  sectorSel.innerHTML = data.meta.sectors.map((s) => `<option value="${s.code}">${s.label}</option>`).join("") +
    `<option value="none">— none —</option>`;
  sectorSel.value = state.sector;
  sectorSel.onchange = () => setSector(sectorSel.value);

  document.querySelectorAll("#level button").forEach((b) => (b.onclick = () => setLevel(b.dataset.level)));
  document.querySelectorAll("#mapshow button").forEach((b) => (b.onclick = () => setMapShow(b.dataset.show)));
  document.querySelector('#mapshow button[data-show="sector"]').textContent = `In ${sectorLabel(state.sector)} need`;
  const chk = document.getElementById("showsrc");
  chk.checked = state.showSources;
  chk.onchange = () => setShowSources(chk.checked);

  renderTable(); renderLegend(); renderBars();
  initMap();
  let rz;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(renderBars, 150); });
}

boot();
