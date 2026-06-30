"use strict";

const BREAKS = [1, 250, 1000, 5000, 20000, 50000];
const COLORS = ["#f3f3ef", "#ffffb2", "#fed976", "#feb24c", "#fd8d3c", "#f03b20", "#bd0026"];
const BASEMAP = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const fmt = new Intl.NumberFormat("en-US");

// metric = exposure source (any/agree2/4 sources); sector = HNO need sector ("none" = plain exposure)
const state = { metric: "any", sector: "none", level: "adm1", data: null, geo: {}, recs: {}, sel: null };

function colorExpr(prop) {
  const stops = [];
  for (let i = 0; i < BREAKS.length; i++) stops.push(BREAKS[i], COLORS[i + 1]);
  return ["step", ["coalesce", ["get", prop], -1], "rgba(0,0,0,0)",
    -0.5, COLORS[0], ...stops];
}

// prevalence = sector PiN / population (uniform assumption), capped at 1; null if no data
function prevalence(r, sector) {
  if (sector === "none") return 1;
  const nd = r.need;
  if (!nd || nd.pop == null) return null;
  const pin = nd.pin[sector];
  if (pin == null) return null;
  return Math.min(1, pin / nd.pop);
}
// exposed (& in need for the current sector) for a given source
function expInNeed(r, source) {
  const exp = r.sources[source].pop;
  if (state.sector === "none") return exp;
  const p = prevalence(r, state.sector);
  return p == null ? null : Math.round(exp * p);
}
function dispVal(r) { return expInNeed(r, state.metric); }
function natVal(source) {
  return state.data.adm1.reduce((s, r) => s + (expInNeed(r, source) || 0), 0);
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

// recompute the displayed value per feature and push to the map source
function decorate(level) {
  const recs = state.recs[level];
  const idKey = level === "adm1" ? "adm1_id" : "adm2_id";
  state.geo[level].features.forEach((f) => {
    const r = recs[f.properties[idKey]];
    f.properties._rec = r ? JSON.stringify(r) : null;
    const v = r ? dispVal(r) : null;
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
    attributionControl: { compact: true },
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
    const dataFeats = state.geo.adm1.features.filter((f) => f.properties._rec);
    map.fitBounds(bbox({ features: dataFeats.length ? dataFeats : state.geo.adm1.features }),
      { padding: 24, duration: 0 });
  });
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
    const v = expInNeed(r, m);
    return `<tr${on}><td class="k">${meta.labels[m]}</td><td>${v == null ? "·" : fmt.format(v)}</td></tr>`;
  }).join("");
  let needLine = "";
  if (state.sector !== "none") {
    const pin = r.need && r.need.pin ? r.need.pin[state.sector] : null;
    const prev = prevalence(r, state.sector);
    const lbl = sectorLabel(state.sector);
    needLine = `<div style="margin-top:5px;border-top:1px solid #eee;padding-top:4px;font-size:11px;color:#6b6b6b">` +
      (pin == null ? `${lbl}: no HNO data` :
        `${lbl} need: ${fmt.format(pin)} in need (${(prev * 100).toFixed(0)}% of ${fmt.format(r.need.pop)})`) +
      `</div>`;
  }
  const head = state.sector === "none"
    ? `${fmt.format(r.pop_total)} people · ${fmt.format(r.n_buildings)} buildings`
    : `exposed & in ${sectorLabel(state.sector)} need`;
  popup.setLngLat(e.lngLat).setHTML(
    `<div class="popup"><h4>${r.name}</h4>` +
    `<div style="color:#6b6b6b;font-size:11px;margin-bottom:4px">${head}</div>` +
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
  redecorate(); renderCards(); renderTable(); renderPanel();
}
function setSector(s) {
  state.sector = s;
  document.getElementById("sector").value = s;
  redecorate(); renderCards(); renderTable(); renderPanel(); renderLegend();
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
  renderTable(); renderPanel();
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
  const sub = (m) => state.sector === "none"
    ? `${fmt.format(nat[m].n)} buildings`
    : `in ${sectorLabel(state.sector)} need`;
  document.getElementById("cards").innerHTML = order.map((m) =>
    `<div class="card ${m === state.metric ? "hi" : ""}" data-m="${m}">
       <div class="lbl">${labels[m]}</div>
       <div class="val">${fmt.format(natVal(m))}</div>
       <div class="sub2">${sub(m)}</div>
     </div>`).join("");
  document.querySelectorAll(".card").forEach((c) => (c.onclick = () => setMetric(c.dataset.m)));
}

let sortKey = null, sortDir = -1;
function renderTable() {
  const recs = state.data[state.level];
  const metrics = state.data.meta.metrics, labels = state.data.meta.labels;
  const showNeed = state.sector !== "none";
  const key = sortKey || state.metric;
  const val = (r) =>
    key === "pin" ? (r.need && r.need.pin ? (r.need.pin[state.sector] ?? -1) : -1)
      : key === "prev" ? (prevalence(r, state.sector) ?? -1)
        : (expInNeed(r, key) ?? -1);
  const sorted = [...recs].sort((a, b) =>
    key === "name" ? sortDir * a.name.localeCompare(b.name) : sortDir * (val(b) - val(a)));

  const thead = document.querySelector("#table thead");
  thead.innerHTML = "<tr>" +
    `<th data-k="name" class="${key === "name" ? "sorted" : ""}">${state.level === "adm1" ? "State" : "Municipality"}</th>` +
    metrics.map((m) =>
      `<th data-k="${m}" class="${m === state.metric ? "metric-on" : ""} ${key === m ? "sorted" : ""}" title="${labels[m]}">${shortLabel(m)}</th>`).join("") +
    (showNeed
      ? `<th data-k="pin" class="${key === "pin" ? "sorted" : ""}" title="${sectorLabel(state.sector)} People in Need (HNO 2025)">PiN</th>` +
        `<th data-k="prev" class="${key === "prev" ? "sorted" : ""}" title="share of the admin population in need">% need</th>`
      : "") +
    "</tr>";

  const cell = (r, m) => { const v = expInNeed(r, m); return v ? fmt.format(v) : "·"; };
  const tbody = document.querySelector("#table tbody");
  tbody.innerHTML = sorted.map((r) => {
    const prev = prevalence(r, state.sector);
    return `<tr data-pcode="${r.pcode}" class="${r.pcode === state.sel ? "sel" : ""}">` +
      `<td title="${r.name}">${r.name}</td>` +
      metrics.map((m) => `<td class="${m === state.metric ? "metric-on" : ""}">${cell(r, m)}</td>`).join("") +
      (showNeed
        ? `<td>${r.need && r.need.pin && r.need.pin[state.sector] != null ? fmt.format(r.need.pin[state.sector]) : "·"}</td>` +
          `<td>${prev == null ? "·" : (prev * 100).toFixed(0) + "%"}</td>`
        : "") +
      "</tr>";
  }).join("");

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

// national exposed-&-in-need for the current source, across every sector
function renderPanel() {
  const src = state.metric, srcLabel = state.data.meta.labels[src];
  const sectors = state.data.meta.sectors;
  const vals = sectors.map((s) => ({
    code: s.code, label: s.label,
    v: Math.round(state.data.adm1.reduce((acc, r) => {
      const p = prevalence(r, s.code);
      return p == null ? acc : acc + r.sources[src].pop * p;
    }, 0)),
  }));
  const max = Math.max(1, ...vals.map((x) => x.v));
  document.getElementById("sev-title").textContent = `${srcLabel}: also pre-existing in need, by sector`;
  document.getElementById("sev-note").textContent = state.data.meta.need_note;
  document.getElementById("sev-bars").innerHTML = vals.map((x) => {
    const on = x.code === state.sector;
    const w = ((x.v / max) * 100).toFixed(1);
    const c = on ? "#bd0026" : "#9e9ac8";
    return `<div class="sev-row sev-click" data-sec="${x.code}" style="${on ? "font-weight:650" : ""}">` +
      `<span class="lab"><i style="background:${c}"></i>${x.label}</span>` +
      `<span class="sev-track"><span class="sev-fill" style="width:${w}%;background:${c}"></span></span>` +
      `<span class="num">${fmt.format(x.v)}</span></div>`;
  }).join("");
  document.querySelectorAll(".sev-click").forEach((el) =>
    (el.onclick = () => setSector(el.dataset.sec)));
}

function renderLegend() {
  const swatch = (c, lbl) => `<i style="background:${c}"></i>${lbl ? `<span>${lbl}</span>` : ""}`;
  const parts = [swatch(COLORS[0], "0")];
  BREAKS.forEach((b, i) => parts.push(swatch(COLORS[i + 1], fmt.format(b))));
  document.getElementById("legend").innerHTML =
    `<span style="margin-right:4px">people${state.sector === "none" ? " exposed" : " exposed &amp; in need"}</span>` + parts.join("");
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
  sectorSel.innerHTML = `<option value="none">— exposure only —</option>` +
    data.meta.sectors.map((s) => `<option value="${s.code}">${s.label}</option>`).join("");
  sectorSel.value = state.sector;
  sectorSel.onchange = () => setSector(sectorSel.value);

  document.querySelectorAll("#level button").forEach((b) => (b.onclick = () => setLevel(b.dataset.level)));

  renderCards(); renderTable(); renderLegend(); renderPanel();
  initMap();
}

boot();
