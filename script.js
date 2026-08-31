function feature(num, name, type, color, coords) {
  return {
    type: "Feature",
    properties: {
      route_short_name: num,
      route_long_name: name,
      route_type: type,
      color: color,
    },
    geometry: {
      type: "LineString",
      coordinates: coords.map((c) => [c[1], c[0]]),
    }, // GeoJSON = [lng,lat]
  };
}

/* MAP SETUP */
const map = L.map("map", { zoomControl: false }).setView(
  [-37.8136, 144.9631],
  11,
);
L.control.zoom({ position: "bottomright" }).addTo(map);

L.tileLayer(
  "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=cb1_2k3x_1_695cbe2fee54ca100951c65c",
  {
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    maxZoom: 20,
  },
).addTo(map);

const legend = L.control({ position: "bottomleft" });
legend.onAdd = function () {
  const div = L.DomUtil.create("div", "");
  div.id = "legend";
  div.innerHTML = `<div><b>Route type</b></div>
    <div><span class="dot" style="background:#ff8a3d"></span> Bus</div>
    <div><span class="dot" style="background:#4d7cff"></span> Train</div>
    <div><span class="dot" style="background:#fff;border:2px solid #11111b"></span> Stop</div>
    <div><span class="dot" style="background:#fff;border:2px solid #4d7cff"></span> Station</div>
    <div><span class="exchange" style="width: 10px;height: 10px;background: #11111b;border: 2px solid #f9e2af;border-radius: 50%;box-shadow: 0 0 0 1px rgba(249, 226, 175, 0.35);"></span> Exchange</div>
    <div><span style="width:9px;height:9px;background:#fff;border:2px solid #f38ba8;border-radius:2px;display:inline-block;transform:rotate(45deg);margin:0 2px;"></span> Terminus</div>`;
  return div;
};
legend.addTo(map);

let routesLayer;
let stopsLayer = L.layerGroup();
let badgeLayer = L.layerGroup();
let exchangeLayer = L.layerGroup().addTo(map);
let stopFeatures = [];
let allFeatures = [];
let selectedId = null;
const activeTypes = new Set();
const NUMBER_ZOOM = 13; // route number badges appear once you zoom past this
const STOP_ZOOM = 15; // stop dots appear once you zoom past this
const BADGE_MIN_DIST = 55; // px - badges closer together than this get skipped

function routeId(props) {
  return props.route_short_name + "|" + props.route_long_name;
}

function styleFor(props, isSelected) {
  const isTrain = props.route_type === "train";
  return {
    color: isTrain ? "#4d7cff" : props.color || "#ff8a3d",
    weight: isSelected ? 7 : isTrain ? 5 : 3,
    opacity: isSelected ? 1 : isTrain ? 0.85 : 0.75,
  };
}

/* ---------------------------------------------------------------
   Route number badges: one per route, placed only where it's
   actually visible, skipped if it would collide with a badge
   already placed this pass.
--------------------------------------------------------------- */
function rebuildBadges() {
  badgeLayer.clearLayers();
  if (
    !routesLayer ||
    map.getZoom() < NUMBER_ZOOM ||
    !document.getElementById("toggle-numbers").checked
  )
    return;

  const bounds = map.getBounds();
  const placedPoints = [];
  const candidateRoutes = [];

  eachLayer((layer, p) => {
    if (layer.options.opacity === 0) return; // filtered out
    if (!layer.getBounds().intersects(bounds)) return;
    candidateRoutes.push({ layer, p });
  });

  // longer / currently-selected routes get first pick of clear space
  candidateRoutes.sort((a, b) => {
    if (routeId(a.p) === selectedId) return -1;
    if (routeId(b.p) === selectedId) return 1;
    return (
      b.layer
        .getBounds()
        .getNorthEast()
        .distanceTo(b.layer.getBounds().getSouthWest()) -
      a.layer
        .getBounds()
        .getNorthEast()
        .distanceTo(a.layer.getBounds().getSouthWest())
    );
  });

  candidateRoutes.forEach(({ layer, p }) => {
    const latlngs = layer.getLatLngs();
    const visible = latlngs.filter((ll) => bounds.contains(ll));
    const pool = visible.length ? visible : latlngs;
    const idxs = [0.5, 0.3, 0.7, 0.15, 0.85].map((f) =>
      Math.floor(f * (pool.length - 1)),
    );

    for (const idx of idxs) {
      const ll = pool[Math.max(0, Math.min(pool.length - 1, idx))];
      const pt = map.latLngToContainerPoint(ll);
      const tooClose = placedPoints.some(
        (pp) => pt.distanceTo(pp) < BADGE_MIN_DIST,
      );
      if (!tooClose) {
        placedPoints.push(pt);
        const icon = L.divIcon({
          className: "",
          iconSize: [0, 0],
          html: `<div class="route-badge" style="background:${p.color}">${p.route_short_name}</div>`,
        });
        L.marker(ll, { icon, interactive: false }).addTo(badgeLayer);
        return; // placed - move to next route
      }
    }
    // no clear spot found for this route in this pass - skip it
  });
}

function loadGeoJSON(geojson) {
  if (routesLayer) map.removeLayer(routesLayer);
  allFeatures = geojson.features;

  routesLayer = L.geoJSON(geojson, {
    style: (f) => styleFor(f.properties, false),
    onEachFeature: (f, layer) => {
      const p = f.properties;
      layer.bindPopup(
        `<b>${p.route_short_name}</b><br>${p.route_long_name}<br><span style="color:#a6adc8">${p.route_type}</span>`,
      );
      layer.on("click", () => selectRoute(routeId(p)));
      layer.on("mouseover", () => {
        if (routeId(p) !== selectedId)
          layer.setStyle({ weight: 5, opacity: 1 });
      });
      layer.on("mouseout", () => {
        if (routeId(p) !== selectedId) layer.setStyle(styleFor(p, false));
      });
    },
  }).addTo(map);

  badgeLayer.addTo(map);
  rebuildBadges();
  buildTypeFilters();
  renderList();
}

function loadStops(geojson) {
  stopFeatures = geojson.features || [];
  rebuildStopsLayer();
  rebuildExchanges();
}

function rebuildStopsLayer() {
  stopsLayer.clearLayers();
  stopFeatures.forEach((f) => {
    const p = f.properties;
    const [lng, lat] = f.geometry.coordinates;
    const isTrain = p.mode === "train";
    if (p.is_terminal) {
      const icon = L.divIcon({
        className: "",
        iconSize: [13, 13],
        html: `<div class="terminal-diamond"></div>`,
      });
      const marker = L.marker([lat, lng], { icon });
      marker.bindPopup(
        `<div class="stop-popup"><h4>${p.stop_name}</h4><div class="routes"><b>Terminus</b> — ${isTrain ? "Lines" : "Routes"}: ${(p.routes || []).join(", ")}</div></div>`,
      );
      stopsLayer.addLayer(marker);
    } else if (isTrain) {
      // train stations get a bigger, blue-ringed dot so they read at a glance
      const marker = L.circleMarker([lat, lng], {
        radius: 6,
        weight: 3,
        color: "#4d7cff",
        fillColor: "#fff",
        fillOpacity: 1,
      });
      marker.bindPopup(
        `<div class="stop-popup"><h4>${p.stop_name}</h4><div class="routes"><b>Station</b> — Lines: ${(p.routes || []).join(", ")}</div></div>`,
      );
      stopsLayer.addLayer(marker);
    } else {
      const marker = L.circleMarker([lat, lng], {
        radius: 4,
        weight: 2,
        color: "#11111b",
        fillColor: "#fff",
        fillOpacity: 1,
      });
      marker.bindPopup(
        `<div class="stop-popup"><h4>${p.stop_name}</h4><div class="routes">Routes: ${(p.routes || []).join(", ")}</div></div>`,
      );
      stopsLayer.addLayer(marker);
    }
  });
}

/* ---------------------------------------------------------------
   Bus exchanges: a real interchange (Monash Uni, a shopping centre
   loop, a station forecourt) is usually several stop poles that
   all share the same stop_name, each only serving a few of the
   total routes. Group by name, count the UNION of routes across
   every pole with that name, and if it clears the threshold, draw
   one big marker at the centroid
--------------------------------------------------------------- */
const EXCHANGE_MIN_ROUTES = 5;

function rebuildExchanges() {
  exchangeLayer.clearLayers();
  const groups = {};
  stopFeatures.forEach((f) => {
    const p = f.properties;
    const name = p.stop_name;
    if (!groups[name])
      groups[name] = { routes: new Set(), latSum: 0, lngSum: 0, n: 0 };
    const g = groups[name];
    (p.routes || []).forEach((r) => g.routes.add(r));
    const [lng, lat] = f.geometry.coordinates;
    g.latSum += lat;
    g.lngSum += lng;
    g.n++;
  });
  Object.entries(groups).forEach(([name, g]) => {
    if (g.routes.size < EXCHANGE_MIN_ROUTES) return;
    const lat = g.latSum / g.n,
      lng = g.lngSum / g.n;
    const icon = L.divIcon({
      className: "",
      iconSize: [22, 22],
      html: `<div class="exchange-marker"></div>`,
    });
    const marker = L.marker([lat, lng], { icon, zIndexOffset: 1000 });
    const routeList = [...g.routes]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .join(", ");
    marker.bindTooltip(`${name} — ${g.routes.size} routes`, {
      direction: "top",
      offset: [0, -12],
    });
    marker.bindPopup(
      `<div class="stop-popup"><h4>${name}</h4><div class="routes"><b>Bus exchange</b> — ${g.routes.size} routes<br>${routeList}</div></div>`,
    );
    exchangeLayer.addLayer(marker);
  });
}

function eachLayer(cb) {
  routesLayer.eachLayer((layer) => cb(layer, layer.feature.properties));
}

function selectRoute(id) {
  selectedId = selectedId === id ? null : id;
  eachLayer((layer, p) => {
    const isSel = routeId(p) === selectedId;
    layer.setStyle(styleFor(p, isSel));
    if (isSel) layer.bringToFront();
  });
  if (selectedId) {
    eachLayer((layer, p) => {
      if (routeId(p) === selectedId)
        map.fitBounds(layer.getBounds(), { padding: [60, 60] });
    });
  }
  renderList();
  setTimeout(rebuildBadges, 350); // after fitBounds' pan/zoom animation settles
}

function buildTypeFilters() {
  const types = [...new Set(allFeatures.map((f) => f.properties.route_type))];
  types.forEach((t) => activeTypes.add(t));
  const wrap = document.getElementById("type-filters");
  wrap.innerHTML = "";
  types.forEach((t) => {
    const chip = document.createElement("div");
    chip.className = "chip active";
    chip.textContent = t;
    chip.onclick = () => {
      if (activeTypes.has(t)) activeTypes.delete(t);
      else activeTypes.add(t);
      chip.classList.toggle("active");
      applyFilters();
    };
    wrap.appendChild(chip);
  });
}

function applyFilters() {
  const q = document.getElementById("search").value.trim().toLowerCase();
  eachLayer((layer, p) => {
    const matchesType = activeTypes.has(p.route_type);
    const matchesSearch =
      !q ||
      p.route_short_name.toLowerCase().includes(q) ||
      p.route_long_name.toLowerCase().includes(q);
    const show = matchesType && matchesSearch;
    layer.setStyle({
      opacity: show ? (routeId(p) === selectedId ? 1 : 0.75) : 0,
      fillOpacity: 0,
    });
  });
  renderList();
  rebuildBadges();
}

function renderList() {
  const q = document.getElementById("search").value.trim().toLowerCase();
  const list = document.getElementById("route-list");
  list.innerHTML = "";
  const visible = allFeatures
    .filter((f) => {
      const p = f.properties;
      const matchesType = activeTypes.has(p.route_type);
      const matchesSearch =
        !q ||
        p.route_short_name.toLowerCase().includes(q) ||
        p.route_long_name.toLowerCase().includes(q);
      return matchesType && matchesSearch;
    })
    .sort((a, b) =>
      a.properties.route_short_name.localeCompare(
        b.properties.route_short_name,
        undefined,
        { numeric: true },
      ),
    );

  document.getElementById("route-count").textContent =
    `${visible.length} route${visible.length === 1 ? "" : "s"}`;

  visible.forEach((f) => {
    const p = f.properties;
    const item = document.createElement("div");
    item.className =
      "route-item" + (routeId(p) === selectedId ? " selected" : "");
    item.innerHTML = `<div class="swatch" style="background:${p.color}"></div>
      <div class="route-num">${p.route_short_name}</div>
      <div class="route-name">${p.route_long_name}</div>`;
    item.onclick = () => selectRoute(routeId(p));
    list.appendChild(item);
  });
}

/* recompute badge positions and stop visibility as the view changes */
map.on("moveend zoomend", () => {
  rebuildBadges();
  const z = map.getZoom();
  if (document.getElementById("toggle-stops").checked) {
    if (z >= STOP_ZOOM) {
      if (!map.hasLayer(stopsLayer)) stopsLayer.addTo(map);
    } else {
      if (map.hasLayer(stopsLayer)) map.removeLayer(stopsLayer);
    }
  }
});

document
  .getElementById("toggle-numbers")
  .addEventListener("change", rebuildBadges);
document.getElementById("toggle-stops").addEventListener("change", (e) => {
  if (e.target.checked && map.getZoom() >= STOP_ZOOM) stopsLayer.addTo(map);
  else map.removeLayer(stopsLayer);
});
document.getElementById("toggle-exchanges").addEventListener("change", (e) => {
  if (e.target.checked) exchangeLayer.addTo(map);
  else map.removeLayer(exchangeLayer);
});

document.getElementById("search").addEventListener("input", applyFilters);

/* ---------------------------------------------------------------
   Load every mode's files separately and merge client-side. Each
   mode is entirely optional
--------------------------------------------------------------- */
const MODES = ["bus", "train", "tram", "ferry"];

function fetchJSON(path) {
  return fetch(path)
    .then((r) => {
      if (!r.ok) throw new Error("missing");
      return r.json();
    })
    .catch(() => null);
}

Promise.all(MODES.map((m) => fetchJSON(`${m}-routes.geojson`))).then(
  (results) => {
    const features = results.filter(Boolean).flatMap((g) => g.features);
    if (features.length) {
      loadGeoJSON({ type: "FeatureCollection", features });
    } else {
      loadGeoJSON(SAMPLE_ROUTES);
    }
  },
);

Promise.all(MODES.map((m) => fetchJSON(`${m}-stops.geojson`))).then(
  (results) => {
    const features = results.filter(Boolean).flatMap((g) => g.features);
    if (features.length) loadStops({ type: "FeatureCollection", features });
  },
);

const SAMPLE_ROUTES = {
  type: "FeatureCollection",
  features: [
    feature("246", "Clifton Hill – Elsternwick", "bus", "#ff8a3d", [
      [-37.7986, 144.9958],
      [-37.81, 144.99],
      [-37.825, 144.988],
      [-37.84, 144.991],
      [-37.86, 144.995],
      [-37.877, 144.999],
    ]),
    feature("903", "SmartBus: Altona – Mordialloc", "bus", "#3dd6ff", [
      [-37.867, 144.833],
      [-37.85, 144.88],
      [-37.83, 144.92],
      [-37.86, 144.97],
      [-37.91, 145.02],
      [-37.98, 145.08],
    ]),
  ],
};
