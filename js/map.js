// Thin map adapter: Google Maps when an API key is configured, otherwise a
// free OpenStreetMap map via Leaflet. Both expose the same small interface.
const LEAFLET = "https://unpkg.com/leaflet@1.9.4/dist";

function availabilityClass(lot) {
  if (lot.availableSpots <= 0) return "full";
  return lot.availableSpots / lot.totalSpots < 0.15 ? "low" : "open";
}

function markerHtml(lot) {
  return `<div class="pin pin--${availabilityClass(lot)}">${lot.availableSpots > 0 ? lot.availableSpots : "Full"}</div>`;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function createGoogleMap(el, center, apiKey, onSelect) {
  await loadScript(
    `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&loading=async&v=weekly`
  );
  // With loading=async, the bootstrap finishes asynchronously after onload.
  while (!window.google?.maps?.importLibrary) await new Promise((r) => setTimeout(r, 50));
  const { Map, Circle } = await google.maps.importLibrary("maps");
  const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");

  const map = new Map(el, {
    center,
    zoom: 14,
    mapId: "DEMO_MAP_ID",
    streetViewControl: false,
    mapTypeControl: false,
  });
  const markers = new globalThis.Map();
  let userMarker = null;
  let radiusCircle = null;

  return {
    setCenter(c) {
      map.panTo(c);
    },
    setUser(c, radiusKm) {
      if (!userMarker) {
        const dot = document.createElement("div");
        dot.className = "user-dot";
        userMarker = new AdvancedMarkerElement({ map, position: c, content: dot, title: "You are here" });
      }
      userMarker.position = c;
      radiusCircle ||= new Circle({ map, strokeColor: "#2563eb", strokeOpacity: 0.4, fillColor: "#2563eb", fillOpacity: 0.06, clickable: false });
      radiusCircle.setCenter(c);
      radiusCircle.setRadius(radiusKm * 1000);
    },
    setLots(lots) {
      const seen = new Set();
      for (const lot of lots) {
        seen.add(lot.id);
        let m = markers.get(lot.id);
        if (!m) {
          const content = document.createElement("div");
          m = new AdvancedMarkerElement({ map, position: { lat: lot.lat, lng: lot.lng }, content, title: lot.name });
          m.addListener("click", () => onSelect(lot.id));
          markers.set(lot.id, m);
        }
        m.content.innerHTML = markerHtml(lot);
      }
      for (const [id, m] of markers) {
        if (!seen.has(id)) {
          m.map = null;
          markers.delete(id);
        }
      }
    },
    focusLot(lot) {
      map.panTo({ lat: lot.lat, lng: lot.lng });
      map.setZoom(16);
    },
  };
}

async function createLeafletMap(el, center, onSelect) {
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = `${LEAFLET}/leaflet.css`;
  document.head.appendChild(css);
  await loadScript(`${LEAFLET}/leaflet.js`);

  const map = L.map(el).setView([center.lat, center.lng], 14);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  const markers = new Map();
  let userMarker = null;
  let radiusCircle = null;
  const icon = (lot) => L.divIcon({ className: "", html: markerHtml(lot), iconSize: null });

  return {
    setCenter(c) {
      map.panTo([c.lat, c.lng]);
    },
    setUser(c, radiusKm) {
      const ll = [c.lat, c.lng];
      userMarker ||= L.marker(ll, { icon: L.divIcon({ className: "", html: '<div class="user-dot"></div>', iconSize: null }), title: "You are here" }).addTo(map);
      userMarker.setLatLng(ll);
      radiusCircle ||= L.circle(ll, { color: "#2563eb", weight: 1, fillOpacity: 0.06, interactive: false }).addTo(map);
      radiusCircle.setLatLng(ll).setRadius(radiusKm * 1000);
    },
    setLots(lots) {
      const seen = new Set();
      for (const lot of lots) {
        seen.add(lot.id);
        let m = markers.get(lot.id);
        if (!m) {
          m = L.marker([lot.lat, lot.lng], { title: lot.name }).addTo(map);
          m.on("click", () => onSelect(lot.id));
          markers.set(lot.id, m);
        }
        m.setIcon(icon(lot));
      }
      for (const [id, m] of markers) {
        if (!seen.has(id)) {
          m.remove();
          markers.delete(id);
        }
      }
    },
    focusLot(lot) {
      map.setView([lot.lat, lot.lng], 16);
    },
  };
}

export async function createMap(el, center, onSelect) {
  const key = self.APP_CONFIG.googleMapsApiKey;
  if (key && !key.startsWith("YOUR_")) {
    try {
      return await createGoogleMap(el, center, key, onSelect);
    } catch (err) {
      console.warn("Google Maps failed to load, falling back to OpenStreetMap.", err);
      el.innerHTML = "";
    }
  }
  return createLeafletMap(el, center, onSelect);
}
