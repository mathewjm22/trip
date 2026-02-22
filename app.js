/* ==============================================================
   ROADREADY – Smart Trip Planner  (app.js)
   All client-side logic: geocoding, routing, weather, POI, map, UI
   ============================================================== */

// ─── CONFIGURATION ───────────────────────────────────────────────
const CFG = {
  ORS_BASE   : 'https://api.openrouteservice.org',
  OWM_BASE   : 'https://api.openweathermap.org/data/2.5',
  NWS_BASE   : 'https://api.weather.gov',
  NOM_BASE   : 'https://nominatim.openstreetmap.org',
  OVERPASS    : 'https://overpass-api.de/api/interpreter',
  OWM_ICON   : 'https://openweathermap.org/img/wn/',
  SAMPLE_KM_WX  : 120,   // weather sample every N km
  SAMPLE_KM_GAS : 60,    // gas query sample every N km
  GAS_RADIUS    : 5000,   // metres from route for gas search
  PARK_RADIUS   : 2500,   // metres from dest for parking
  DEBOUNCE_MS   : 400,
};

// ─── STATE ───────────────────────────────────────────────────────
const S = {
  map: null,
  routeLayer: null,
  markerLayers: { gas: null, parking: null, weather: null, waypoints: null },
  origin: null,       // { lat, lon, name }
  destination: null,
  stops: [],          // [{ lat, lon, name }]
  routeCoords: [],    // [[lat,lon],...]
  routeData: null,
  weatherData: [],
  alerts: [],
  gasStations: [],
  parkingSpots: [],
};

// ─── INIT ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadKeys();
  wireEvents();
  checkKeys();
});

function initMap() {
  S.map = L.map('map', {
    center: [39.8283, -98.5795],
    zoom: 4,
    zoomControl: false,
  });
  L.control.zoom({ position: 'bottomright' }).addTo(S.map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(S.map);

  // Layer groups
  S.markerLayers.waypoints = L.layerGroup().addTo(S.map);
  S.markerLayers.gas       = L.layerGroup().addTo(S.map);
  S.markerLayers.parking   = L.layerGroup().addTo(S.map);
  S.markerLayers.weather   = L.layerGroup().addTo(S.map);
}

// ─── KEY MANAGEMENT ──────────────────────────────────────────────
function loadKeys() {
  const k = JSON.parse(localStorage.getItem('rr_keys') || '{}');
  if (k.ors) document.getElementById('key-ors').value = k.ors;
  if (k.owm) document.getElementById('key-owm').value = k.owm;
}
function saveKeys() {
  const ors = document.getElementById('key-ors').value.trim();
  const owm = document.getElementById('key-owm').value.trim();
  if (!ors || !owm) { toast('Both keys are required', 'error'); return; }
  localStorage.setItem('rr_keys', JSON.stringify({ ors, owm }));
  closeModal();
  toast('Keys saved!', 'success');
  checkKeys();
}
function getKeys() {
  return JSON.parse(localStorage.getItem('rr_keys') || '{}');
}
function checkKeys() {
  const k = getKeys();
  if (!k.ors || !k.owm) openModal();
  updatePlanBtn();
}

// ─── EVENTS ──────────────────────────────────────────────────────
function wireEvents() {
  // Settings
  $('settings-btn').onclick  = openModal;
  $('close-modal').onclick   = closeModal;
  $('modal-backdrop').onclick= closeModal;
  $('save-keys-btn').onclick = saveKeys;

  // Inputs
  const origIn = $('origin-input');
  const destIn = $('dest-input');
  origIn.addEventListener('input', debounce(e => geocodeSuggest(e.target.value, 'origin-suggestions', v => { S.origin = v; updatePlanBtn(); }), CFG.DEBOUNCE_MS));
  destIn.addEventListener('input', debounce(e => geocodeSuggest(e.target.value, 'dest-suggestions', v => { S.destination = v; updatePlanBtn(); }), CFG.DEBOUNCE_MS));
  origIn.addEventListener('focus', () => { if(origIn.value.length > 2) origIn.dispatchEvent(new Event('input')); });
  destIn.addEventListener('focus', () => { if(destIn.value.length > 2) destIn.dispatchEvent(new Event('input')); });

  // Close suggestions on outside click
  document.addEventListener('click', e => {
    document.querySelectorAll('.suggestions, .stop-suggestions').forEach(ul => {
      if (!ul.contains(e.target) && !ul.previousElementSibling?.contains?.(e.target)) ul.classList.remove('open');
    });
  });

  // Locate me
  $('locate-btn').onclick = locateMe;

  // Stops
  $('add-stop-btn').onclick = addStopField;

  // Plan
  $('plan-btn').onclick = planTrip;

  // New trip
  $('new-trip-btn').onclick = resetTrip;

  // Tabs
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));

  // Map legend toggles
  $('toggle-gas-markers').onclick    = () => toggleLayer('gas', 'toggle-gas-markers');
  $('toggle-parking-markers').onclick= () => toggleLayer('parking', 'toggle-parking-markers');
  $('toggle-weather-markers').onclick= () => toggleLayer('weather', 'toggle-weather-markers');
  $('fit-route-btn').onclick         = fitRoute;
}

// ─── GEOCODING (Nominatim) ───────────────────────────────────────
async function geocodeSuggest(query, ulId, onSelect) {
  const ul = $(ulId);
  if (query.length < 3) { ul.classList.remove('open'); return; }
  try {
    const res = await fetchJSON(`${CFG.NOM_BASE}/search?q=${enc(query)}&format=json&limit=5&addressdetails=1`);
    ul.innerHTML = '';
    if (!res.length) { ul.classList.remove('open'); return; }
    res.forEach(r => {
      const li = document.createElement('li');
      li.innerHTML = `<i class="fas fa-location-dot"></i><span>${r.display_name}</span>`;
      li.onclick = () => {
        const input = ul.closest('.field').querySelector('input') || ul.previousElementSibling;
        if (input) input.value = r.display_name;
        onSelect({ lat: +r.lat, lon: +r.lon, name: r.display_name });
        ul.classList.remove('open');
      };
      ul.appendChild(li);
    });
    ul.classList.add('open');
  } catch { ul.classList.remove('open'); }
}

async function geocodeAddress(query) {
  const res = await fetchJSON(`${CFG.NOM_BASE}/search?q=${enc(query)}&format=json&limit=1`);
  if (!res.length) throw new Error(`Could not find: "${query}"`);
  return { lat: +res[0].lat, lon: +res[0].lon, name: res[0].display_name };
}

// ─── LOCATE ME ───────────────────────────────────────────────────
function locateMe() {
  if (!navigator.geolocation) { toast('Geolocation not supported', 'error'); return; }
  toast('Getting your location…');
  navigator.geolocation.getCurrentPosition(
    async pos => {
      const { latitude: lat, longitude: lon } = pos.coords;
      try {
        const res = await fetchJSON(`${CFG.NOM_BASE}/reverse?lat=${lat}&lon=${lon}&format=json`);
        const name = res.display_name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
        $('origin-input').value = name;
        S.origin = { lat, lon, name };
        updatePlanBtn();
        toast('Location set!', 'success');
      } catch { 
        $('origin-input').value = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        S.origin = { lat, lon, name: 'My Location' };
        updatePlanBtn();
      }
    },
    () => toast('Could not get location', 'error'),
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ─── STOPS ───────────────────────────────────────────────────────
let stopCounter = 0;
function addStopField() {
  const id = stopCounter++;
  const div = document.createElement('div');
  div.className = 'stop-row';
  div.dataset.id = id;
  div.innerHTML = `
    <input type="text" placeholder="Enter stop address…" autocomplete="off" id="stop-input-${id}">
    <button class="stop-remove" title="Remove"><i class="fas fa-xmark"></i></button>
    <ul class="stop-suggestions" id="stop-sug-${id}"></ul>
  `;
  $('stops-list').appendChild(div);

  const inp = div.querySelector('input');
  const removeBtn = div.querySelector('.stop-remove');

  // Geocode suggestions for this stop
  inp.addEventListener('input', debounce(e => {
    geocodeSuggestStop(e.target.value, `stop-sug-${id}`, id, inp);
  }, CFG.DEBOUNCE_MS));

  removeBtn.onclick = () => {
    S.stops = S.stops.filter(s => s._id !== id);
    div.remove();
    updatePlanBtn();
  };
}

function geocodeSuggestStop(query, ulId, stopId, inputEl) {
  const ul = $(ulId);
  if (query.length < 3) { ul.classList.remove('open'); return; }
  fetchJSON(`${CFG.NOM_BASE}/search?q=${enc(query)}&format=json&limit=5`).then(res => {
    ul.innerHTML = '';
    if (!res.length) { ul.classList.remove('open'); return; }
    res.forEach(r => {
      const li = document.createElement('li');
      li.textContent = r.display_name;
      li.onclick = () => {
        inputEl.value = r.display_name;
        const existing = S.stops.findIndex(s => s._id === stopId);
        const stop = { lat: +r.lat, lon: +r.lon, name: r.display_name, _id: stopId };
        if (existing >= 0) S.stops[existing] = stop; else S.stops.push(stop);
        ul.classList.remove('open');
        updatePlanBtn();
      };
      ul.appendChild(li);
    });
    ul.classList.add('open');
  }).catch(() => {});
}

// ─── PLAN TRIP (orchestrator) ────────────────────────────────────
async function planTrip() {
  const keys = getKeys();
  if (!keys.ors || !keys.owm) { openModal(); return; }
  if (!S.origin || !S.destination) { toast('Enter origin and destination', 'error'); return; }

  try {
    showLoading('Calculating toll-free route…');

    // 1. If user typed but didn't pick a suggestion, geocode now
    if (!S.origin.lat) S.origin = await geocodeAddress($('origin-input').value);
    if (!S.destination.lat) S.destination = await geocodeAddress($('dest-input').value);

    // Also geocode any stops that were typed but not selected
    const stopInputs = document.querySelectorAll('#stops-list .stop-row input');
    for (const inp of stopInputs) {
      const id = +inp.closest('.stop-row').dataset.id;
      if (inp.value.trim() && !S.stops.find(s => s._id === id)) {
        const geo = await geocodeAddress(inp.value.trim());
        S.stops.push({ ...geo, _id: id });
      }
    }

    // 2. Optimize stop order
    if (S.stops.length > 1) {
      showLoading('Optimizing stop order…');
      S.stops = optimizeStops(S.origin, S.destination, S.stops);
    }

    // 3. Build waypoints [origin, ...stops, destination]
    const waypoints = [S.origin, ...S.stops, S.destination];
    const coords = waypoints.map(w => [w.lon, w.lat]); // ORS uses [lon,lat]

    // 4. Get route (toll-free)
    showLoading('Getting toll-free directions…');
    S.routeData = await fetchRoute(coords, keys.ors);
    const geojson = S.routeData;
    const feat = geojson.features[0];
    S.routeCoords = feat.geometry.coordinates.map(c => [c[1], c[0]]); // [lat,lon] for Leaflet

    // 5. Draw on map
    clearMapLayers();
    drawRoute(feat.geometry);
    addWaypointMarkers(waypoints);
    fitRoute();

    // 6. Render directions
    renderDirections(feat.properties.segments, waypoints);

    // 7. Weather (parallel)
    showLoading('Checking weather & alerts…');
    await fetchAllWeather(S.routeCoords, keys.owm);

    // 8. Gas stations
    showLoading('Finding gas stations…');
    await fetchGasStations(S.routeCoords);

    // 9. Parking
    showLoading('Finding parking at destination…');
    await fetchParking(S.destination);

    // 10. Summary
    renderSummary(feat.properties, waypoints);

    // 11. Show results UI
    $('plan-panel').classList.add('collapsed');
    $('results-panel').classList.remove('hidden');
    $('new-trip-btn').classList.remove('hidden');
    $('map-legend').classList.remove('hidden');
    $('sidebar').classList.add('trip-active');
    switchTab('directions');
    hideLoading();

  } catch (err) {
    hideLoading();
    console.error(err);
    toast(err.message || 'Something went wrong', 'error');
  }
}

// ─── ROUTING (OpenRouteService) ──────────────────────────────────
async function fetchRoute(coords, apiKey) {
  const body = {
    coordinates: coords,
    instructions: true,
    preference: 'recommended',
    units: 'mi',
    language: 'en',
    options: {
      avoid_features: ['tollways']
    }
  };
  const res = await fetch(`${CFG.ORS_BASE}/v2/directions/driving-car/geojson`, {
    method: 'POST',
    headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Route error (${res.status})`);
  }
  return res.json();
}

// ─── WEATHER ─────────────────────────────────────────────────────
async function fetchAllWeather(routeCoords, owmKey) {
  // Sample points along route
  const pts = samplePoints(routeCoords, CFG.SAMPLE_KM_WX);
  // Always include start & end
  if (pts.length === 0) {
    pts.push(routeCoords[0]);
    pts.push(routeCoords[routeCoords.length - 1]);
  }

  // Fetch weather for each point
  const promises = pts.map(p =>
    fetchJSON(`${CFG.OWM_BASE}/weather?lat=${p[0]}&lon=${p[1]}&appid=${owmKey}&units=imperial`)
      .catch(() => null)
  );
  const results = await Promise.all(promises);
  S.weatherData = results.filter(Boolean);

  // Fetch NWS alerts for unique zones (US only)
  S.alerts = [];
  const alertPts = pts.filter(p => isInUS(p[0], p[1]));
  const alertPromises = alertPts.map(p =>
    fetchJSON(`${CFG.NWS_BASE}/alerts/active?point=${p[0].toFixed(4)},${p[1].toFixed(4)}`, {
      headers: { 'User-Agent': 'RoadReady-TripPlanner' }
    }).catch(() => ({ features: [] }))
  );
  const alertResults = await Promise.all(alertPromises);
  const seen = new Set();
  alertResults.forEach(r => {
    (r.features || []).forEach(f => {
      const id = f.properties?.id || f.properties?.headline;
      if (!seen.has(id)) { seen.add(id); S.alerts.push(f.properties); }
    });
  });

  renderWeather();
  addWeatherMarkers(pts);
}

// ─── GAS STATIONS (Overpass) ─────────────────────────────────────
async function fetchGasStations(routeCoords) {
  const pts = samplePoints(routeCoords, CFG.SAMPLE_KM_GAS);
  if (!pts.length) return;

  // Build Overpass polyline "around" filter
  const polyStr = pts.map(p => `${p[0]},${p[1]}`).join(',');
  const query = `[out:json][timeout:30];node["amenity"="fuel"](around:${CFG.GAS_RADIUS},${polyStr});out body;`;

  try {
    const data = await fetchJSON(CFG.OVERPASS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${enc(query)}`
    });
    // Deduplicate by id
    const seen = new Set();
    S.gasStations = (data.elements || []).filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
  } catch {
    S.gasStations = [];
  }

  renderGas();
  addGasMarkers();
}

// ─── PARKING (Overpass) ──────────────────────────────────────────
async function fetchParking(dest) {
  const query = `[out:json][timeout:25];(node["amenity"="parking"](around:${CFG.PARK_RADIUS},${dest.lat},${dest.lon});way["amenity"="parking"](around:${CFG.PARK_RADIUS},${dest.lat},${dest.lon}););out center body;`;
  try {
    const data = await fetchJSON(CFG.OVERPASS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${enc(query)}`
    });
    S.parkingSpots = (data.elements || []).map(e => ({
      id: e.id,
      lat: e.lat || e.center?.lat,
      lon: e.lon || e.center?.lon,
      name: e.tags?.name || 'Parking',
      fee: e.tags?.fee,
      capacity: e.tags?.capacity,
      type: e.tags?.parking,
      access: e.tags?.access,
      covered: e.tags?.covered,
    })).filter(p => p.lat && p.lon);
  } catch {
    S.parkingSpots = [];
  }

  renderParking();
  addParkingMarkers();
}

// ─── ROUTE OPTIMIZER (nearest-neighbor + 2-opt) ──────────────────
function optimizeStops(origin, destination, stops) {
  if (stops.length <= 1) return [...stops];

  // Nearest-neighbor from origin
  const remaining = [...stops];
  const ordered = [];
  let current = origin;

  while (remaining.length) {
    let bestIdx = 0, bestDist = haversine(current, remaining[0]);
    for (let i = 1; i < remaining.length; i++) {
      const d = haversine(current, remaining[i]);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    ordered.push(remaining[bestIdx]);
    current = remaining[bestIdx];
    remaining.splice(bestIdx, 1);
  }

  // 2-opt improvement
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < ordered.length - 1; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const before = segDist(i === 0 ? origin : ordered[i-1], ordered[i])
                     + segDist(ordered[j], j === ordered.length-1 ? destination : ordered[j+1]);
        const after  = segDist(i === 0 ? origin : ordered[i-1], ordered[j])
                     + segDist(ordered[i], j === ordered.length-1 ? destination : ordered[j+1]);
        if (after < before) {
          // Reverse segment i..j
          let left = i, right = j;
          while (left < right) { [ordered[left], ordered[right]] = [ordered[right], ordered[left]]; left++; right--; }
          improved = true;
        }
      }
    }
  }
  return ordered;
}
function segDist(a, b) { return haversine(a, b); }

// ─── MAP DRAWING ─────────────────────────────────────────────────
function clearMapLayers() {
  if (S.routeLayer) { S.map.removeLayer(S.routeLayer); S.routeLayer = null; }
  Object.values(S.markerLayers).forEach(lg => lg.clearLayers());
}

function drawRoute(geometry) {
  S.routeLayer = L.geoJSON(geometry, {
    style: { color: '#2563eb', weight: 5, opacity: 0.85, lineJoin: 'round' }
  }).addTo(S.map);
}

function addWaypointMarkers(waypoints) {
  waypoints.forEach((wp, i) => {
    let cls = 'stop', icon = 'fa-map-pin';
    if (i === 0) { cls = 'origin'; icon = 'fa-play'; }
    else if (i === waypoints.length - 1) { cls = 'dest'; icon = 'fa-flag-checkered'; }
    const marker = L.marker([wp.lat, wp.lon], { icon: makeIcon(cls, icon) })
      .bindPopup(`<div class="popup-title">${i === 0 ? 'Start' : i === waypoints.length-1 ? 'Destination' : 'Stop ' + i}</div><div class="popup-meta">${wp.name}</div>`);
    S.markerLayers.waypoints.addLayer(marker);
  });
}

function addGasMarkers() {
  S.gasStations.forEach(gs => {
    const name = gs.tags?.name || gs.tags?.brand || 'Gas Station';
    const marker = L.marker([gs.lat, gs.lon], { icon: makeIcon('gas', 'fa-gas-pump') })
      .bindPopup(`<div class="popup-title">${name}</div><div class="popup-meta">${gs.tags?.brand || ''} ${gs.tags?.opening_hours ? '· ' + gs.tags.opening_hours : ''}</div>`);
    S.markerLayers.gas.addLayer(marker);
  });
}

function addParkingMarkers() {
  S.parkingSpots.forEach(p => {
    const marker = L.marker([p.lat, p.lon], { icon: makeIcon('parking', 'fa-square-parking') })
      .bindPopup(`<div class="popup-title">${p.name}</div><div class="popup-meta">${p.fee === 'yes' ? 'Paid' : p.fee === 'no' ? 'Free' : ''} ${p.capacity ? '· ' + p.capacity + ' spots' : ''} ${p.type ? '· ' + p.type : ''}</div>`);
    S.markerLayers.parking.addLayer(marker);
  });
}

function addWeatherMarkers(pts) {
  S.weatherData.forEach((w, i) => {
    if (!w) return;
    const coord = w.coord || (pts[i] ? { lat: pts[i][0], lon: pts[i][1] } : null);
    if (!coord) return;
    const marker = L.marker([coord.lat, coord.lon], { icon: makeIcon('weather', 'fa-cloud-sun') })
      .bindPopup(`<div class="popup-title">${w.name || 'Weather'}</div><div class="popup-meta">${Math.round(w.main.temp)}°F – ${w.weather[0].description}</div>`);
    S.markerLayers.weather.addLayer(marker);
  });
}

function makeIcon(cls, faIcon) {
  return L.divIcon({
    className: 'custom-marker',
    html: `<div class="marker-pin ${cls}"><i class="fas ${faIcon}"></i></div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -18],
  });
}

function fitRoute() {
  if (S.routeLayer) S.map.fitBounds(S.routeLayer.getBounds().pad(0.05));
}

function toggleLayer(name, btnId) {
  const btn = $(btnId);
  const lg = S.markerLayers[name];
  if (S.map.hasLayer(lg)) { S.map.removeLayer(lg); btn.classList.add('off'); }
  else { S.map.addLayer(lg); btn.classList.remove('off'); }
}

// ─── UI RENDERING ────────────────────────────────────────────────

// Summary bar
function renderSummary(props, waypoints) {
  const seg = props.segments || [];
  let totalDist = 0, totalDur = 0;
  seg.forEach(s => { totalDist += s.distance; totalDur += s.duration; });

  let html = `
    <div class="summary-item"><i class="fas fa-road"></i> <strong>${totalDist.toFixed(1)} mi</strong></div>
    <div class="summary-item"><i class="fas fa-clock"></i> <strong>${fmtDuration(totalDur)}</strong></div>
    <div class="summary-item"><i class="fas fa-map-pin"></i> <strong>${waypoints.length - 2} stops</strong></div>
    <div class="summary-item"><i class="fas fa-ban"></i> Toll-free</div>
  `;
  if (S.alerts.length) {
    S.alerts.forEach(a => {
      const sev = (a.severity || '').toLowerCase();
      const cls = sev === 'extreme' || sev === 'severe' ? 'danger' : 'warn';
      html += `<div class="summary-alert ${cls}"><i class="fas fa-triangle-exclamation"></i> ${a.event || a.headline}</div>`;
    });
  }
  $('trip-summary-bar').innerHTML = html;
}

// Directions
function renderDirections(segments, waypoints) {
  const pane = $('pane-directions');
  let html = '';
  let stepNum = 0;

  segments.forEach((seg, si) => {
    // Segment header for multi-stop routes
    if (segments.length > 1) {
      const fromName = shorten(waypoints[si]?.name, 40);
      const toName = shorten(waypoints[si + 1]?.name, 40);
      html += `<div style="padding:10px 0 4px;font-size:.78rem;font-weight:700;color:var(--primary);border-top:2px solid var(--border);margin-top:8px;">
        <i class="fas fa-route"></i> ${fromName} → ${toName}
        <span style="float:right;font-weight:500;color:var(--text3)">${seg.distance.toFixed(1)} mi · ${fmtDuration(seg.duration)}</span>
      </div>`;
    }

    seg.steps.forEach(step => {
      stepNum++;
      const iconInfo = dirIcon(step.type);
      const cls = step.type === 10 ? 'arrive' : step.type === 11 ? 'depart' : '';
      const wpIndex = step.way_points ? step.way_points[0] : null;

      html += `
        <div class="dir-step" data-wp="${wpIndex}" data-seg="${si}">
          <div class="dir-icon ${cls}"><i class="fas ${iconInfo}"></i></div>
          <div class="dir-info">
            <div class="dir-instruction">${step.instruction}</div>
            <div class="dir-meta">
              <span><i class="fas fa-ruler"></i> ${step.distance < 0.1 ? Math.round(step.distance * 5280) + ' ft' : step.distance.toFixed(1) + ' mi'}</span>
              <span><i class="fas fa-clock"></i> ${fmtDuration(step.duration)}</span>
            </div>
          </div>
        </div>`;
    });
  });

  pane.innerHTML = html;

  // Click to pan map
  pane.querySelectorAll('.dir-step').forEach(el => {
    el.onclick = () => {
      const segIdx = +el.dataset.seg;
      const wpIdx = +el.dataset.wp;
      const feat = S.routeData.features[0];
      const allCoords = feat.geometry.coordinates;
      // Get the step coordinate from the route geometry
      // ORS segments reference way_points which index into the overall geometry
      let actualIdx = wpIdx;
      // Sum up waypoints from previous segments
      for (let i = 0; i < segIdx; i++) {
        const prevSegSteps = feat.properties.segments[i].steps;
        // The waypoints in each segment are relative to that segment's start in the geometry
        // Actually ORS indexes way_points globally in the coordinates array
      }
      if (actualIdx !== null && actualIdx < allCoords.length) {
        const c = allCoords[actualIdx];
        S.map.setView([c[1], c[0]], 15, { animate: true });
      }
    };
  });
}

// Weather
function renderWeather() {
  const pane = $('pane-weather');
  let html = '';

  // Alerts first
  if (S.alerts.length) {
    html += '<h3 style="font-size:.85rem;margin-bottom:8px;color:var(--red)"><i class="fas fa-triangle-exclamation"></i> Active Alerts</h3>';
    S.alerts.forEach(a => {
      const sev = (a.severity || '').toLowerCase();
      const cls = sev === 'extreme' || sev === 'severe' ? 'extreme' : '';
      html += `
        <div class="wx-alert ${cls}">
          <div class="wx-alert-title"><i class="fas fa-exclamation-circle"></i> ${a.event || 'Weather Alert'}</div>
          <div class="wx-alert-body">${a.headline || ''}<br><small>${a.description ? a.description.substring(0, 300) + '…' : ''}</small></div>
        </div>`;
    });
  }

  if (S.weatherData.length) {
    html += '<h3 style="font-size:.85rem;margin:12px 0 8px;color:var(--text2)"><i class="fas fa-cloud-sun"></i> Weather Along Route</h3>';
    S.weatherData.forEach(w => {
      if (!w) return;
      const icon = w.weather[0]?.icon || '01d';
      html += `
        <div class="wx-card">
          <div class="wx-icon"><img src="${CFG.OWM_ICON}${icon}@2x.png" alt="${w.weather[0]?.description || ''}"></div>
          <div class="wx-details">
            <div class="wx-city">${w.name || 'Unknown'}</div>
            <div class="wx-desc">${w.weather[0]?.description || ''}</div>
            <div class="wx-stats">
              <span><i class="fas fa-wind"></i> ${Math.round(w.wind?.speed || 0)} mph</span>
              <span><i class="fas fa-droplet"></i> ${w.main?.humidity || 0}%</span>
              <span><i class="fas fa-eye"></i> ${w.visibility ? (w.visibility / 1609).toFixed(1) + ' mi' : 'N/A'}</span>
            </div>
          </div>
          <div class="wx-temp">${Math.round(w.main.temp)}°</div>
        </div>`;
    });
  }

  if (!html) html = emptyState('fa-cloud-sun', 'No weather data available');
  pane.innerHTML = html;
}

// Gas stations
function renderGas() {
  const pane = $('pane-gas');
  if (!S.gasStations.length) { pane.innerHTML = emptyState('fa-gas-pump', 'No gas stations found along route'); return; }

  // Sort by distance from route start
  const sorted = [...S.gasStations].sort((a, b) => {
    const da = haversine(S.origin, { lat: a.lat, lon: a.lon });
    const db = haversine(S.origin, { lat: b.lat, lon: b.lon });
    return da - db;
  });

  let html = `<p style="font-size:.78rem;color:var(--text3);margin-bottom:10px">${sorted.length} gas station${sorted.length !== 1 ? 's' : ''} found near your route</p>`;
  sorted.forEach(gs => {
    const name = gs.tags?.name || gs.tags?.brand || 'Gas Station';
    const brand = gs.tags?.brand || '';
    const hours = gs.tags?.opening_hours || '';
    const distFromStart = (haversine(S.origin, { lat: gs.lat, lon: gs.lon }) / 1609.34).toFixed(1);
    html += `
      <div class="poi-item" data-lat="${gs.lat}" data-lon="${gs.lon}">
        <div class="poi-icon gas"><i class="fas fa-gas-pump"></i></div>
        <div class="poi-info">
          <div class="poi-name">${name}</div>
          <div class="poi-detail">${brand}${hours ? ' · ' + hours : ''}</div>
        </div>
        <div class="poi-dist">${distFromStart} mi</div>
      </div>`;
  });
  pane.innerHTML = html;
  addPoiClickHandlers(pane);
}

// Parking
function renderParking() {
  const pane = $('pane-parking');
  if (!S.parkingSpots.length) { pane.innerHTML = emptyState('fa-square-parking', 'No parking found near destination'); return; }

  // Sort by distance from destination
  const sorted = [...S.parkingSpots].sort((a, b) =>
    haversine(S.destination, a) - haversine(S.destination, b)
  );

  let html = `<p style="font-size:.78rem;color:var(--text3);margin-bottom:10px">${sorted.length} parking option${sorted.length !== 1 ? 's' : ''} near destination</p>`;
  sorted.forEach(p => {
    const dist = (haversine(S.destination, p) / 1609.34).toFixed(2);
    const details = [];
    if (p.fee === 'yes') details.push('Paid');
    else if (p.fee === 'no') details.push('Free');
    if (p.capacity) details.push(p.capacity + ' spots');
    if (p.type) details.push(p.type.replace(/_/g, ' '));
    if (p.covered === 'yes') details.push('Covered');
    if (p.access) details.push(p.access);

    html += `
      <div class="poi-item" data-lat="${p.lat}" data-lon="${p.lon}">
        <div class="poi-icon park"><i class="fas fa-square-parking"></i></div>
        <div class="poi-info">
          <div class="poi-name">${p.name}</div>
          <div class="poi-detail">${details.join(' · ') || 'Parking available'}</div>
        </div>
        <div class="poi-dist">${dist} mi</div>
      </div>`;
  });
  pane.innerHTML = html;
  addPoiClickHandlers(pane);
}

function addPoiClickHandlers(pane) {
  pane.querySelectorAll('.poi-item').forEach(el => {
    el.onclick = () => {
      const lat = +el.dataset.lat, lon = +el.dataset.lon;
      S.map.setView([lat, lon], 16, { animate: true });
      // On mobile, scroll up to show map
      if (window.innerWidth < 768) {
        document.getElementById('map-container').scrollIntoView({ behavior: 'smooth' });
      }
    };
  });
}

// Tabs
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + name));
}

// ─── RESET ───────────────────────────────────────────────────────
function resetTrip() {
  S.origin = null;
  S.destination = null;
  S.stops = [];
  S.routeCoords = [];
  S.routeData = null;
  S.weatherData = [];
  S.alerts = [];
  S.gasStations = [];
  S.parkingSpots = [];
  clearMapLayers();
  S.map.setView([39.8283, -98.5795], 4);

  $('origin-input').value = '';
  $('dest-input').value = '';
  $('stops-list').innerHTML = '';
  stopCounter = 0;

  $('plan-panel').classList.remove('collapsed');
  $('results-panel').classList.add('hidden');
  $('new-trip-btn').classList.add('hidden');
  $('map-legend').classList.add('hidden');
  $('sidebar').classList.remove('trip-active');
  updatePlanBtn();
}

// ─── UTILITY ─────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function enc(s) { return encodeURIComponent(s); }

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function debounce(fn, ms) {
  let timer;
  return function (...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), ms); };
}

function haversine(a, b) {
  const R = 6371000;
  const toR = d => d * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
  const x = Math.sin(dLat/2)**2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

function samplePoints(coords, intervalKm) {
  // coords: [[lat,lon], ...]
  if (coords.length < 2) return [...coords];
  const pts = [coords[0]];
  let accum = 0;
  for (let i = 1; i < coords.length; i++) {
    accum += haversine({ lat: coords[i-1][0], lon: coords[i-1][1] }, { lat: coords[i][0], lon: coords[i][1] });
    if (accum >= intervalKm * 1000) { pts.push(coords[i]); accum = 0; }
  }
  const last = coords[coords.length - 1];
  if (pts[pts.length-1] !== last) pts.push(last);
  return pts;
}

function isInUS(lat, lon) {
  return lat >= 24.3 && lat <= 49.4 && lon >= -125.0 && lon <= -66.9;
}

function fmtDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m} min`;
  return `${h}h ${m}m`;
}

function shorten(str, max) {
  if (!str) return '';
  return str.length > max ? str.substring(0, max) + '…' : str;
}

function dirIcon(type) {
  const map = {
    0: 'fa-arrow-left', 1: 'fa-arrow-right', 2: 'fa-arrow-left',
    3: 'fa-arrow-right', 4: 'fa-arrow-up', 5: 'fa-arrow-up',
    6: 'fa-arrow-up', 7: 'fa-rotate-right', 8: 'fa-right-from-bracket',
    9: 'fa-arrow-rotate-left', 10: 'fa-flag-checkered',
    11: 'fa-diamond-turn-right', 12: 'fa-arrow-up', 13: 'fa-arrow-up',
  };
  return map[type] || 'fa-arrow-up';
}

function emptyState(icon, msg) {
  return `<div class="empty-state"><i class="fas ${icon}"></i><p>${msg}</p></div>`;
}

// Loading
function showLoading(msg) {
  $('loading-msg').textContent = msg || 'Loading…';
  $('loading-overlay').classList.remove('hidden');
}
function hideLoading() { $('loading-overlay').classList.add('hidden'); }

// Modal
function openModal() { $('settings-modal').classList.remove('hidden'); $('modal-backdrop').classList.remove('hidden'); }
function closeModal() { $('settings-modal').classList.add('hidden'); $('modal-backdrop').classList.add('hidden'); }

// Toast
function toast(msg, type) {
  const el = $('toast');
  el.textContent = msg;
  el.className = type || '';
  setTimeout(() => el.classList.add('hidden'), 3500);
}

// Enable plan button
function updatePlanBtn() {
  const ok = ($('origin-input').value.trim().length > 2) && ($('dest-input').value.trim().length > 2) && getKeys().ors;
  $('plan-btn').disabled = !ok;
}