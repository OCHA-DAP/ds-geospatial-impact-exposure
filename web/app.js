"use strict";

const BREAKS = [1, 250, 1000, 5000, 20000, 50000];
const COLORS = ["#f3f3ef", "#ffffb2", "#fed976", "#feb24c", "#fd8d3c", "#f03b20", "#bd0026"];
// pre-existing shelter-need tiers (purple, distinct from the red exposure ramp)
const TIER_COLORS = ["#cbc9e2", "#9e9ac8", "#756bb1", "#54278f"]; // Low..Very high
const TIER_NODATA = "#e3e3e3";
const BASEMAP = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const fmt = new Intl.NumberFormat("en-US");

const state = { metric: "any", level: "adm1", shade: "exposure", data: null, geo: {}, recs: {}, sel: null };

function colorExpr(prop) {
  const stops = [];
  for (let i = 0; i < BREAKS.length; i++) stops.push(BREAKS[i], COLORS[i + 1]);
  return ["step", ["coalesce", ["get", prop], 0], COLORS[0], ...stops];
}

function tierColorExpr() {
  return ["match", ["coalesce", ["get", "_tier"], -1],
    0, TIER_COLORS[0], 1, TIER_COLORS[1], 2, TIER_COLORS[2], 3, TIER_COLORS[3], TIER_NODATA];
}

// fill expression for the current shade mode
function fillExpr() {
  return state.shade === "need" ? tierColorExpr() : colorExpr("m_" + state.metric);
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

// merge per-metric pop into geojson props so the fill expr can read m_<metric>
function decorate(level) {
  const recs = state.recs[level];
  const idKey = level === "adm1" ? "adm1_id" : "adm2_id";
  state.geo[level].features.forEach((f) => {
    const r = recs[f.properties[idKey]];
    f.properties._rec = r ? JSON.stringify(r) : null;
    f.properties._tier = r && r.pre && r.pre.tier != null ? r.pre.tier : -1;
    state.data.meta.metrics.forEach((m) => {
      f.properties["m_" + m] = r ? r.sources[m].pop : 0;
    });
  });
}

let map;
function initMap() {
  map = new maplibregl.Map({
    container: "map", style: BASEMAP, center: [-66.5, 9.6], zoom: 5.6,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.on("load", () => {
    ["adm2", "adm1"].forEach((lvl) => {
      map.addSource(lvl, { type: "geojson", data: state.geo[lvl] });
      map.addLayer({
        id: lvl + "-fill", type: "fill", source: lvl,
        paint: { "fill-color": fillExpr(), "fill-opacity": 0.78 },
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
      map.on("click", lvl + "-fill", (e) => {
        const p = e.features[0].properties;
        select(p[lvl === "adm1" ? "adm1_id" : "adm2_id"]);
      });
    });
    // Fit to the assessed area (admin units that actually carry data), not the
    // whole country — the damage footprint is a north-central coastal band.
    const dataFeats = state.geo.adm1.features.filter((f) => f.properties._rec);
    map.fitBounds(bbox({ features: dataFeats.length ? dataFeats : state.geo.adm1.features }),
      { padding: 24, duration: 0 });
  });
}

const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "280px" });
function onHover(e, lvl) {
  map.getCanvas().style.cursor = "pointer";
  const p = e.features[0].properties;
  if (!p._rec) return;
  const r = JSON.parse(p._rec);
  const rows = state.data.meta.metrics.map((m) => {
    const on = m === state.metric ? ' style="font-weight:650;color:#bd0026"' : "";
    return `<tr${on}><td class="k">${state.data.meta.labels[m]}</td><td>${fmt.format(r.sources[m].pop)}</td></tr>`;
  }).join("");
  const pre = r.pre || {};
  const sh = state.data.meta.shelter;
  const preLine = pre.pin != null
    ? `<div style="margin-top:5px;border-top:1px solid #eee;padding-top:4px;font-size:11px;color:#6b6b6b">` +
      `pre-existing PiN ${fmt.format(pre.pin)} · shelter need: ` +
      `<b style="color:${pre.tier != null ? TIER_COLORS[pre.tier] : "#999"}">${pre.tier != null ? sh.labels[pre.tier] : "n/a"}</b></div>`
    : "";
  popup.setLngLat(e.lngLat).setHTML(
    `<div class="popup"><h4>${r.name}</h4>` +
    `<div style="color:#6b6b6b;font-size:11px;margin-bottom:4px">${fmt.format(r.pop_total)} people · ${fmt.format(r.n_buildings)} buildings</div>` +
    `<table>${rows}</table>${preLine}</div>`
  ).addTo(map);
}

function repaint() {
  ["adm1", "adm2"].forEach((lvl) =>
    map.getLayer(lvl + "-fill") && map.setPaintProperty(lvl + "-fill", "fill-color", fillExpr()));
}

function setMetric(m) {
  state.metric = m;
  sortKey = null; // table follows the selected source unless the user re-sorts
  repaint();
  document.getElementById("metric").value = m;
  renderCards(); renderTable(); renderLegend(); renderSeverity();
}

function setShade(mode) {
  state.shade = mode;
  document.querySelectorAll("#shade button").forEach((b) =>
    b.classList.toggle("on", b.dataset.shade === mode));
  repaint(); renderLegend();
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
  renderTable(); renderSeverity();
}

function select(pcode) {
  state.sel = pcode;
  const lvl = state.level;
  const idKey = lvl === "adm1" ? "adm1_id" : "adm2_id";
  map.setFilter(lvl + "-sel", ["==", idKey, pcode || "__none__"]);
  document.querySelectorAll("#table tbody tr").forEach((tr) =>
    tr.classList.toggle("sel", tr.dataset.pcode === pcode));
  const f = state.geo[lvl].features.find((x) => x.properties[idKey] === pcode);
  if (f) {
    const tr = document.querySelector(`#table tbody tr[data-pcode="${pcode}"]`);
    if (tr) tr.scrollIntoView({ block: "nearest" });
    map.fitBounds(bbox({ features: [f] }), { padding: 60, maxZoom: 10, duration: 600 });
  }
}

function renderCards() {
  const nat = state.data.meta.national, labels = state.data.meta.labels;
  const order = ["agree2", "any", "microsoft", "copernicus_ems", "impact_initiatives", "osu"];
  document.getElementById("cards").innerHTML = order.map((m) =>
    `<div class="card ${m === state.metric ? "hi" : ""}" data-m="${m}">
       <div class="lbl">${labels[m]}</div>
       <div class="val">${fmt.format(nat[m].pop)}</div>
       <div class="sub2">${fmt.format(nat[m].n)} buildings</div>
     </div>`).join("");
  document.querySelectorAll(".card").forEach((c) =>
    c.onclick = () => setMetric(c.dataset.m));
}

function tierChip(t, labels) {
  if (t == null) return '<span class="chip t-1">n/a</span>';
  return `<span class="chip" style="background:${TIER_COLORS[t]}">${labels[t]}</span>`;
}

let sortKey = null, sortDir = -1;
function renderTable() {
  const recs = state.data[state.level];
  const metrics = state.data.meta.metrics, labels = state.data.meta.labels;
  const shl = state.data.meta.shelter.labels;
  const key = sortKey || state.metric;
  const val = (r) =>
    key === "pin" ? (r.pre.pin ?? -1)
      : key === "tier" ? (r.pre.tier ?? -1)
        : (r.sources[key]?.pop ?? 0);
  const sorted = [...recs].sort((a, b) =>
    key === "name" ? sortDir * a.name.localeCompare(b.name) : sortDir * (val(b) - val(a)));
  const thead = document.querySelector("#table thead");
  thead.innerHTML = "<tr>" +
    `<th data-k="name" class="${key === "name" ? "sorted" : ""}">${state.level === "adm1" ? "State" : "Municipality"}</th>` +
    metrics.map((m) =>
      `<th data-k="${m}" class="${m === state.metric ? "metric-on" : ""} ${key === m ? "sorted" : ""}" title="${labels[m]}">${shortLabel(m)}</th>`).join("") +
    `<th data-k="pin" class="${key === "pin" ? "sorted" : ""}" title="Pre-existing People in Need (HNO 2025)">Pre-PiN</th>` +
    `<th data-k="tier" class="${key === "tier" ? "sorted" : ""}" title="Pre-existing shelter need tier">Shelter need</th>` +
    "</tr>";
  const tbody = document.querySelector("#table tbody");
  tbody.innerHTML = sorted.map((r) =>
    `<tr data-pcode="${r.pcode}" class="${r.pcode === state.sel ? "sel" : ""}">
       <td title="${r.name}">${r.name}</td>` +
    metrics.map((m) =>
      `<td class="${m === state.metric ? "metric-on" : ""}">${r.sources[m].pop ? fmt.format(r.sources[m].pop) : "·"}</td>`).join("") +
    `<td>${r.pre.pin != null ? fmt.format(r.pre.pin) : "·"}</td>` +
    `<td style="text-align:left">${tierChip(r.pre.tier, shl)}</td>` +
    "</tr>").join("");
  thead.querySelectorAll("th").forEach((th) => th.onclick = () => {
    const k = th.dataset.k;
    if (sortKey === k) sortDir *= -1;
    else { sortKey = k; sortDir = k === "name" ? 1 : -1; }
    renderTable();
  });
  tbody.querySelectorAll("tr").forEach((tr) =>
    tr.onclick = () => select(tr.dataset.pcode));
}

const SHORT = {
  microsoft: "MS", copernicus_ems: "CEMS", impact_initiatives: "SAR", osu: "OSU",
  any: "Any", agree2: "≥2",
};
function shortLabel(m) { return SHORT[m] || m; }

function renderLegend() {
  const swatch = (c, lbl) => `<i style="background:${c}"></i>${lbl ? `<span>${lbl}</span>` : ""}`;
  if (state.shade === "need") {
    const labels = state.data.meta.shelter.labels;
    const parts = TIER_COLORS.map((c, i) => swatch(c, labels[i]));
    parts.push(swatch(TIER_NODATA, "no data"));
    document.getElementById("legend").innerHTML =
      `<span style="margin-right:4px">shelter need</span>` + parts.join("");
    return;
  }
  const parts = [swatch(COLORS[0], "0")];
  BREAKS.forEach((b, i) => parts.push(swatch(COLORS[i + 1], fmt.format(b))));
  document.getElementById("legend").innerHTML =
    `<span style="margin-right:4px">people exposed</span>` + parts.join("");
}

function renderSeverity() {
  const recs = state.data[state.level];
  const sh = state.data.meta.shelter, m = state.metric, mlabel = state.data.meta.labels[m];
  const sums = {}, counts = {};
  recs.forEach((r) => {
    const t = r.pre && r.pre.tier != null ? r.pre.tier : -1;
    sums[t] = (sums[t] || 0) + (r.sources[m].pop || 0);
    counts[t] = (counts[t] || 0) + 1;
  });
  const order = [0, 1, 2, 3];
  if (counts[-1]) order.push(-1);
  const max = Math.max(1, ...order.map((t) => sums[t] || 0));
  const color = (t) => (t === -1 ? TIER_NODATA : TIER_COLORS[t]);
  const label = (t) => (t === -1 ? "No HNO data" : sh.labels[t]);
  document.getElementById("sev-title").textContent =
    `${mlabel} by pre-existing shelter need — ${state.level === "adm2" ? "municipios" : "states"}`;
  document.getElementById("sev-note").textContent = sh.note;
  document.getElementById("sev-bars").innerHTML = order.map((t) => {
    const v = sums[t] || 0, w = ((v / max) * 100).toFixed(1);
    return `<div class="sev-row"><span class="lab"><i style="background:${color(t)}"></i>${label(t)} ` +
      `<span style="color:#aaa">(${counts[t] || 0})</span></span>` +
      `<span class="sev-track"><span class="sev-fill" style="width:${w}%;background:${color(t)}"></span></span>` +
      `<span class="num">${fmt.format(Math.round(v))}</span></div>`;
  }).join("");
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
  sel.innerHTML = data.meta.metrics.map((m) =>
    `<option value="${m}">${data.meta.labels[m]}</option>`).join("");
  sel.value = state.metric;
  sel.onchange = () => setMetric(sel.value);
  document.querySelectorAll("#level button").forEach((b) =>
    b.onclick = () => setLevel(b.dataset.level));
  document.querySelectorAll("#shade button").forEach((b) =>
    b.onclick = () => setShade(b.dataset.shade));

  renderCards(); renderTable(); renderLegend(); renderSeverity();
  initMap();
}

boot();
