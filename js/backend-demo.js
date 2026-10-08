// Demo backend: same interface as backend-firebase.js, but everything lives in
// the browser. Used automatically until real Firebase keys are configured.
const STORE_KEY = "parkit-demo";
const listeners = { auth: new Set(), lots: new Set(), bookings: new Set() };

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}
function save(state) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable: demo still works for this page view */
  }
}

let state = load();
state.bookings ||= [];
let lots = null;

const LOT_NAMES = [
  "Central Plaza Garage", "Riverside Parking", "Main Street Lot", "City Hall Garage",
  "Market Square Parking", "Station Park & Ride", "Harbor View Lot", "Museum Garage",
  "Tech Park Parking", "Stadium Lot B", "Old Town Garage", "Mall East Parking",
];
const AMENITIES = ["Covered", "EV charging", "24/7", "CCTV", "Accessible", "Valet"];

// Deterministic pseudo-random so demo lots stay put between reloads.
function rng(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

function generateLots(center) {
  const rand = rng(42);
  return LOT_NAMES.map((name, i) => {
    const total = 20 + Math.floor(rand() * 180);
    return {
      id: `demo-${i}`,
      name,
      address: `${100 + Math.floor(rand() * 900)} Demo Ave`,
      lat: center.lat + (rand() - 0.5) * 0.06,
      lng: center.lng + (rand() - 0.5) * 0.08,
      totalSpots: total,
      availableSpots: Math.floor(rand() * total * 0.6),
      pricePerHour: Math.round((2 + rand() * 8) * 2) / 2,
      amenities: AMENITIES.filter(() => rand() > 0.6),
    };
  });
}

const emitLots = () => listeners.lots.forEach((cb) => cb(lots.map((l) => ({ ...l }))));
const myBookings = () =>
  state.bookings
    .filter((b) => b.userId === state.user?.uid)
    .map((b) => ({ ...b, start: new Date(b.start), end: new Date(b.end), createdAt: new Date(b.createdAt) }))
    .sort((a, b) => b.start - a.start);
const emitBookings = () => listeners.bookings.forEach((cb) => cb(myBookings()));
const emitAuth = () => listeners.auth.forEach((cb) => cb(state.user || null));
const delay = (ms = 300) => new Promise((r) => setTimeout(r, ms));

export const isDemo = true;

// Lots are generated around wherever the user first looks.
export function setDemoCenter(center) {
  if (lots) return;
  lots = generateLots(center);
  emitLots();
  // Simulate cars arriving and leaving so real-time updates are visible.
  setInterval(() => {
    const lot = lots[Math.floor(Math.random() * lots.length)];
    const change = Math.random() > 0.5 ? 1 : -1;
    lot.availableSpots = Math.min(lot.totalSpots, Math.max(0, lot.availableSpots + change));
    emitLots();
  }, 4000);
}

export function onAuth(cb) {
  listeners.auth.add(cb);
  cb(state.user || null);
  return () => listeners.auth.delete(cb);
}

function setUser(user) {
  state.user = user;
  save(state);
  emitAuth();
}

export async function signIn(email, password) {
  await delay();
  if (!email || password.length < 6) throw new Error("Enter an email and a password of 6+ characters.");
  setUser({ uid: email.toLowerCase(), email, name: email.split("@")[0] });
}
export async function signUp(name, email, password) {
  await delay();
  if (!email || password.length < 6) throw new Error("Enter an email and a password of 6+ characters.");
  setUser({ uid: email.toLowerCase(), email, name: name || email });
}
export async function signInWithGoogle() {
  await delay();
  setUser({ uid: "demo-google", email: "demo@example.com", name: "Demo User" });
}
export async function resetPassword() {
  await delay();
}
export async function signOut() {
  setUser(null);
}

export async function getSettings() {
  return { requirePayment: false };
}

export function subscribeLots(cb) {
  listeners.lots.add(cb);
  if (lots) cb(lots.map((l) => ({ ...l })));
  return () => listeners.lots.delete(cb);
}

export async function createBooking({ lot, start, hours, plate }) {
  await delay();
  if (!state.user) throw new Error("Please sign in first.");
  const live = lots.find((l) => l.id === lot.id);
  if (!live || live.availableSpots < 1) throw new Error("Sorry, this lot just filled up.");
  live.availableSpots -= 1;
  const booking = {
    id: `bk-${Date.now()}`,
    userId: state.user.uid,
    lotId: lot.id,
    lotName: lot.name,
    start: start.toISOString(),
    end: new Date(start.getTime() + hours * 3600_000).toISOString(),
    hours,
    plate,
    amount: Math.round(hours * lot.pricePerHour * 100) / 100,
    currency: self.APP_CONFIG.currency,
    status: "confirmed",
    paymentStatus: "pay_on_site",
    createdAt: new Date().toISOString(),
  };
  state.bookings.push(booking);
  save(state);
  emitLots();
  emitBookings();
  return { id: booking.id };
}

export function subscribeMyBookings(cb) {
  listeners.bookings.add(cb);
  cb(myBookings());
  return () => listeners.bookings.delete(cb);
}

export async function cancelBooking(booking) {
  await delay();
  const stored = state.bookings.find((b) => b.id === booking.id);
  if (!stored || !["confirmed", "pending_payment"].includes(stored.status)) {
    throw new Error("This booking can no longer be cancelled.");
  }
  stored.status = "cancelled";
  save(state);
  const live = lots?.find((l) => l.id === booking.lotId);
  if (live) live.availableSpots = Math.min(live.totalSpots, live.availableSpots + 1);
  emitLots();
  emitBookings();
}

export async function startCheckout() {
  throw new Error("Payments are disabled in demo mode.");
}

export async function enablePush() {
  if (!("Notification" in window)) throw new Error("Notifications aren't supported in this browser.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted.");
  return "demo-token";
}

export async function onForegroundMessage() {}
