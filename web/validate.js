"use strict";

const BASEMAP = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
// damaged-building people ramp = warm/red (stands out on top)
const B_COLORS = ["#ffffb2", "#fecc5c", "#fd8d3c", "#f03b20", "#bd0026"];
// WorldPop background ramp = cool blue (must match build_validation_layers RAMP),
// deliberately different from the building colours so it doesn't read as damage
const WP_COLORS = ["#deebf7", "#9ecae1", "#6baed6", "#3182bd", "#08519c"];
const fmt = new Intl.NumberFormat("en-US");
const SRC = [["ms", "Microsoft"], ["cems", "Copernicus EMS"], ["sar", "IMPACT SAR"], ["osu", "OSU S1"]];

function buildingColor(breaks) {
  const stops = [];
  for (let i = 0; i < breaks.length; i++) stops.push(breaks[i], B_COLORS[Math.min(i + 1, B_COLORS.length - 1)]);
  return ["step", ["coalesce", ["get", "pop"], 0], B_COLORS[0], ...stops];
}

async function boot() {
  const meta = await fetch("./data/validate.json").then((r) => r.json());
  document.getElementById("note").textContent = meta.note;

  // pmtiles protocol for the building vector tiles
  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);

  const map = new maplibregl.Map({
    container: "map", style: BASEMAP,
    center: meta.center, zoom: meta.zoom, maxZoom: 18,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120 }), "bottom-left");

  map.on("load", () => {
    // WorldPop raster overlay (cache-bust by content hash so a recolor refetches)
    const wpUrl = "./data/worldpop.png?v=" + (meta.worldpop.v || "1");
    map.addSource("wp", { type: "image", url: wpUrl, coordinates: meta.worldpop.coordinates });
    map.addLayer({ id: "wp", type: "raster", source: "wp",
      paint: { "raster-opacity": 0.7, "raster-resampling": "nearest", "raster-fade-duration": 0 } });

    // damaged building footprints from PMTiles
    map.addSource("bld", { type: "vector", url: "pmtiles://./data/buildings.pmtiles" });
    map.addLayer({
      id: "bld-fill", type: "fill", source: "bld", "source-layer": "buildings",
      paint: { "fill-color": buildingColor(meta.building_breaks),
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.55, 14, 0.85] },
    });
    map.addLayer({
      id: "bld-line", type: "line", source: "bld", "source-layer": "buildings",
      minzoom: 14,
      paint: { "line-color": "#7a0019", "line-width": 0.4, "line-opacity": 0.6 },
    });

    wireControls(map, meta);
    wireHover(map);
  });
}

function wireControls(map, meta) {
  document.getElementById("t-wp").onchange = (e) =>
    map.setLayoutProperty("wp", "visibility", e.target.checked ? "visible" : "none");
  document.getElementById("wp-op").oninput = (e) =>
    map.setPaintProperty("wp", "raster-opacity", +e.target.value / 100);
  document.getElementById("t-bld").onchange = (e) => {
    const v = e.target.checked ? "visible" : "none";
    map.setLayoutProperty("bld-fill", "visibility", v);
    map.setLayoutProperty("bld-line", "visibility", v);
  };

  const sw = (cols, labels) => cols.map((c, i) =>
    `<i style="background:${c}"></i>${labels[i] != null ? `<span>${labels[i]}</span>` : ""}`).join("");
  document.getElementById("bld-leg").innerHTML =
    `<span style="margin-right:3px">ppl / building</span>` +
    sw(B_COLORS, ["0", ...meta.building_breaks.map((b) => fmt.format(b))]);
  const wpMax = meta.worldpop.max_per_cell;
  document.getElementById("wp-leg").innerHTML =
    `<span style="margin-right:3px">ppl / cell</span>` +
    sw(WP_COLORS, ["low", "", "", "", fmt.format(wpMax)]);
}

const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "260px" });
function wireHover(map) {
  map.on("mousemove", "bld-fill", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const p = e.features[0].properties;
    const flags = SRC.filter(([k]) => +p[k] === 1).map(([, lbl]) => lbl);
    popup.setLngLat(e.lngLat).setHTML(
      `<div class="popup"><h4>≈ ${fmt.format(Math.round(p.pop))} ${Math.round(p.pop) === 1 ? "person" : "people"}</h4>` +
      `<table>` +
      `<tr><td class="k">footprint</td><td>${fmt.format(p.area)} m²</td></tr>` +
      `<tr><td class="k">flagged by</td><td>${flags.length} of 4</td></tr>` +
      `<tr><td class="k">sources</td><td>${flags.join(", ") || "—"}</td></tr>` +
      `</table></div>`
    ).addTo(map);
  });
  map.on("mouseleave", "bld-fill", () => { popup.remove(); map.getCanvas().style.cursor = ""; });
}

boot();
