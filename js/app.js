import { distanceKm, formatDistance, getCurrentPosition } from "./geo.js";
import { createMap } from "./map.js";

const cfg = self.APP_CONFIG;
const demo = cfg.firebase.apiKey.startsWith("YOUR_");
const api = await import(demo ? "./backend-demo.js" : "./backend-firebase.js");

const $ = (sel) => document.querySelector(sel);
const money = (n) => new Intl.NumberFormat(undefined, { style: "currency", currency: cfg.currency }).format(n);
const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const state = {
  user: null,
  settings: { requirePayment: false },
  center: cfg.defaultCenter,
  radiusKm: cfg.defaultRadiusKm,
  lots: [],
  selectedLotId: null,
  bookingLot: null,
  reminderTimers: [],
};

let map;
let unsubBookings = () => {};

// ---- Toasts -----------------------------------------------------------------

function toast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  el.textContent = message;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// ---- Lots list & map ----------------------------------------------------------

function visibleLots() {
  const onlyAvailable = $("#only-available").checked;
  const sort = $("#sort").value;
  const lots = state.lots
    .map((lot) => ({ ...lot, distance: distanceKm(state.center, lot) }))
    .filter((lot) => lot.distance <= state.radiusKm && (!onlyAvailable || lot.availableSpots > 0));
  const sorters = {
    distance: (a, b) => a.distance - b.distance,
    price: (a, b) => a.pricePerHour - b.pricePerHour,
    available: (a, b) => b.availableSpots - a.availableSpots,
  };
  return lots.sort(sorters[sort]);
}

function availabilityBadge(lot) {
  if (lot.availableSpots <= 0) return `<span class="badge badge--full">Full</span>`;
  const low = lot.availableSpots / lot.totalSpots < 0.15;
  return `<span class="badge badge--${low ? "low" : "open"}">${lot.availableSpots} / ${lot.totalSpots} free</span>`;
}

function render() {
  const lots = visibleLots();
  map?.setLots(lots);
  $("#results-summary").textContent = lots.length
    ? `${lots.length} parking lot${lots.length === 1 ? "" : "s"} within ${state.radiusKm} km · live`
    : `No parking lots found within ${state.radiusKm} km. Try a larger radius.`;

  $("#lot-list").innerHTML = lots
    .map(
      (lot) => `
      <li class="lot ${lot.id === state.selectedLotId ? "lot--selected" : ""}" data-id="${escapeHtml(lot.id)}">
        <div class="lot__head">
          <h3>${escapeHtml(lot.name)}</h3>
          ${availabilityBadge(lot)}
        </div>
        <p class="muted">${escapeHtml(lot.address || "")} · ${formatDistance(lot.distance)}</p>
        ${lot.amenities?.length ? `<p class="tags">${lot.amenities.map((a) => `<span>${escapeHtml(a)}</span>`).join("")}</p>` : ""}
        <div class="lot__foot">
          <strong>${money(lot.pricePerHour)}<small>/hr</small></strong>
          <span>
            <a class="btn btn--ghost btn--sm" target="_blank" rel="noopener"
               href="https://www.google.com/maps/dir/?api=1&destination=${lot.lat},${lot.lng}">Directions</a>
            <button class="btn btn--primary btn--sm" data-book="${escapeHtml(lot.id)}" ${lot.availableSpots > 0 ? "" : "disabled"}>Book</button>
          </span>
        </div>
      </li>`
    )
    .join("");
}

function selectLot(id) {
  state.selectedLotId = id;
  render();
  const lot = state.lots.find((l) => l.id === id);
  if (lot) map.focusLot(lot);
  document.querySelector(`.lot[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function locate() {
  const btn = $("#btn-locate");
  btn.disabled = true;
  btn.textContent = "Locating…";
  try {
    state.center = await getCurrentPosition();
    toast("Showing parking near your location.");
  } catch (err) {
    toast(`${err.message} Showing the default area instead.`, "warn");
  } finally {
    btn.disabled = false;
    btn.textContent = "📍 Find parking near me";
  }
  if (demo) api.setDemoCenter(state.center);
  map.setCenter(state.center);
  map.setUser(state.center, state.radiusKm);
  render();
}

// ---- Auth ---------------------------------------------------------------------

let authMode = "signin";

function setAuthMode(mode) {
  authMode = mode;
  const titles = { signin: "Sign in", signup: "Create account", reset: "Reset password" };
  const submits = { signin: "Sign in", signup: "Create account", reset: "Send reset link" };
  $("#auth-title").textContent = titles[mode];
  $("#auth-submit").textContent = submits[mode];
  $("#auth-name-row").hidden = mode !== "signup";
  $("#auth-pw-row").hidden = mode === "reset";
  $("#auth-google").hidden = mode === "reset";
  $('[data-auth-mode="signup"]').hidden = mode === "signup";
  $('[data-auth-mode="signin"]').hidden = mode === "signin";
  $('[data-auth-mode="reset"]').hidden = mode === "reset";
  $("#form-auth").password.autocomplete = mode === "signup" ? "new-password" : "current-password";
  $("#auth-error").textContent = "";
}

function openAuth(mode = "signin") {
  setAuthMode(mode);
  $("#dlg-auth").showModal();
}

function friendlyAuthError(err) {
  const code = err.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found"))
    return "Incorrect email or password.";
  if (code.includes("email-already-in-use")) return "An account with this email already exists.";
  if (code.includes("weak-password")) return "Password must be at least 6 characters.";
  if (code.includes("invalid-email")) return "Please enter a valid email address.";
  if (code.includes("popup-closed")) return "Sign-in popup was closed.";
  if (code.includes("too-many-requests")) return "Too many attempts. Please try again later.";
  return err.message || "Something went wrong.";
}

async function submitAuth(e) {
  e.preventDefault();
  const form = e.target;
  const email = form.email.value.trim();
  const password = form.password.value;
  $("#auth-submit").disabled = true;
  $("#auth-error").textContent = "";
  try {
    if (authMode === "signin") await api.signIn(email, password);
    else if (authMode === "signup") await api.signUp(form.name.value.trim(), email, password);
    else {
      await api.resetPassword(email);
      toast("If an account exists, a reset link has been sent.");
      setAuthMode("signin");
      return;
    }
    form.reset();
    $("#dlg-auth").close();
  } catch (err) {
    $("#auth-error").textContent = friendlyAuthError(err);
  } finally {
    $("#auth-submit").disabled = false;
  }
}

function onUserChanged(user) {
  state.user = user;
  $("#btn-signin").hidden = !!user;
  $("#btn-signout").hidden = !user;
  $("#btn-bookings").hidden = !user;
  $("#btn-notify").hidden = !user || ("Notification" in window && Notification.permission === "granted");
  $("#user-name").textContent = user ? `Hi, ${user.name}` : "";

  unsubBookings();
  unsubBookings = () => {};
  clearReminders();
  if (user) {
    unsubBookings = api.subscribeMyBookings(onBookingsChanged, (err) => console.error(err));
    // Continue a booking the user started before signing in.
    if (state.bookingLot) openBooking(state.bookingLot.id);
  }
}

// ---- Booking --------------------------------------------------------------------

function pad(n) {
  return String(n).padStart(2, "0");
}

function openBooking(lotId) {
  const lot = state.lots.find((l) => l.id === lotId);
  if (!lot) return;
  state.bookingLot = lot;
  if (!state.user) {
    toast("Sign in to reserve a spot.");
    openAuth();
    return;
  }
  const form = $("#form-book");
  // Default arrival: next quarter hour.
  const start = new Date(Math.ceil((Date.now() + 5 * 60_000) / (15 * 60_000)) * 15 * 60_000);
  const today = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
  form.date.value = today;
  form.date.min = today;
  form.time.value = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
  $("#book-lot").innerHTML = `<strong>${escapeHtml(lot.name)}</strong><br><span class="muted">${escapeHtml(lot.address || "")} · ${money(lot.pricePerHour)}/hr · ${lot.availableSpots} spots free</span>`;
  $("#book-pay-note").textContent = state.settings.requirePayment
    ? "You'll be redirected to Stripe to pay securely. Your spot is held for 30 minutes."
    : "Pay at the parking lot on arrival.";
  $("#book-submit").textContent = state.settings.requirePayment ? "Continue to payment" : "Confirm booking";
  $("#book-error").textContent = "";
  updateTotal();
  $("#dlg-book").showModal();
}

function updateTotal() {
  const lot = state.bookingLot;
  if (lot) $("#book-total").textContent = money(Number($("#form-book").hours.value) * lot.pricePerHour);
}

async function submitBooking(e) {
  e.preventDefault();
  const form = e.target;
  const start = new Date(`${form.date.value}T${form.time.value}`);
  if (Number.isNaN(start.getTime()) || start.getTime() < Date.now() - 5 * 60_000) {
    $("#book-error").textContent = "Please choose an arrival time in the future.";
    return;
  }
  const plate = form.plate.value.trim().toUpperCase();
  if (!plate) {
    $("#book-error").textContent = "Please enter your licence plate.";
    return;
  }
  $("#book-submit").disabled = true;
  try {
    const { id } = await api.createBooking({
      lot: state.bookingLot,
      start,
      hours: Number(form.hours.value),
      plate,
      requirePayment: state.settings.requirePayment,
    });
    if (state.settings.requirePayment) {
      toast("Redirecting to secure payment…");
      await api.startCheckout(id);
      return;
    }
    $("#dlg-book").close();
    state.bookingLot = null;
    toast("Booking confirmed! You'll get a reminder before arrival.", "success");
  } catch (err) {
    console.error(err);
    $("#book-error").textContent = err.message || "Booking failed. Please try again.";
  } finally {
    $("#book-submit").disabled = false;
  }
}

const STATUS_LABELS = {
  confirmed: "Confirmed",
  pending_payment: "Awaiting payment",
  cancelled: "Cancelled",
  completed: "Completed",
  expired: "Expired",
};

function onBookingsChanged(bookings) {
  scheduleLocalReminders(bookings);
  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  $("#booking-list").innerHTML = bookings.length
    ? bookings
        .map((b) => {
          const active = b.status === "confirmed" || b.status === "pending_payment";
          const cancellable = active && b.start > new Date();
          return `
          <li class="booking booking--${escapeHtml(b.status)}">
            <div>
              <strong>${escapeHtml(b.lotName)}</strong>
              <span class="badge badge--status">${STATUS_LABELS[b.status] || escapeHtml(b.status)}</span>
              <p class="muted">${fmt.format(b.start)} → ${fmt.format(b.end)} · ${escapeHtml(b.plate)}</p>
              <p class="muted">${money(b.amount)} · ${b.paymentStatus === "paid" ? "Paid" : b.paymentStatus === "pay_on_site" ? "Pay on site" : "Unpaid"}</p>
            </div>
            <div class="booking__actions">
              ${b.status === "pending_payment" ? `<button class="btn btn--primary btn--sm" data-pay="${escapeHtml(b.id)}">Pay now</button>` : ""}
              ${cancellable ? `<button class="btn btn--danger btn--sm" data-cancel="${escapeHtml(b.id)}">Cancel</button>` : ""}
            </div>
          </li>`;
        })
        .join("")
    : `<li class="empty">No bookings yet. Find a spot and tap <strong>Book</strong>.</li>`;
  state.bookings = bookings;
}

// While the app is open, show a local reminder 15 minutes before arrival
// (server-side FCM reminders cover the case when it's closed).
function clearReminders() {
  state.reminderTimers.forEach(clearTimeout);
  state.reminderTimers = [];
}

function scheduleLocalReminders(bookings) {
  clearReminders();
  const now = Date.now();
  for (const b of bookings) {
    if (b.status !== "confirmed") continue;
    const at = b.start.getTime() - 15 * 60_000;
    if (at <= now || at - now > 24 * 3600_000) continue;
    state.reminderTimers.push(
      setTimeout(() => {
        const body = `Your parking at ${b.lotName} starts in 15 minutes.`;
        toast(body);
        if ("Notification" in window && Notification.permission === "granted") new Notification("Parking reminder", { body });
      }, at - now)
    );
  }
}

// ---- Wiring ---------------------------------------------------------------------

function bindEvents() {
  $("#btn-locate").addEventListener("click", locate);
  $("#radius").addEventListener("change", (e) => {
    state.radiusKm = Number(e.target.value);
    map.setUser(state.center, state.radiusKm);
    render();
  });
  $("#sort").addEventListener("change", render);
  $("#only-available").addEventListener("change", render);

  $("#lot-list").addEventListener("click", (e) => {
    const book = e.target.closest("[data-book]");
    if (book) return openBooking(book.dataset.book);
    if (e.target.closest("a")) return;
    const li = e.target.closest(".lot");
    if (li) selectLot(li.dataset.id);
  });

  $("#btn-signin").addEventListener("click", () => openAuth());
  $("#btn-signout").addEventListener("click", () => api.signOut());
  $("#btn-bookings").addEventListener("click", () => $("#dlg-bookings").showModal());
  $("#btn-notify").addEventListener("click", async () => {
    try {
      await api.enablePush();
      $("#btn-notify").hidden = true;
      toast("Reminders enabled.", "success");
    } catch (err) {
      toast(err.message, "warn");
    }
  });

  $("#form-auth").addEventListener("submit", submitAuth);
  $("#auth-google").addEventListener("click", async () => {
    try {
      await api.signInWithGoogle();
      $("#dlg-auth").close();
    } catch (err) {
      $("#auth-error").textContent = friendlyAuthError(err);
    }
  });
  document.querySelectorAll("[data-auth-mode]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      setAuthMode(a.dataset.authMode);
    })
  );

  $("#form-book").addEventListener("submit", submitBooking);
  $("#form-book").hours.addEventListener("change", updateTotal);
  $("#dlg-book").addEventListener("close", () => {
    if (!$("#dlg-auth").open) state.bookingLot = null;
  });
  $("#dlg-auth").addEventListener("close", () => {
    if (!state.user) state.bookingLot = null;
  });

  $("#booking-list").addEventListener("click", async (e) => {
    const cancel = e.target.closest("[data-cancel]");
    const pay = e.target.closest("[data-pay]");
    try {
      if (cancel) {
        if (!confirm("Cancel this booking?")) return;
        cancel.disabled = true;
        await api.cancelBooking(state.bookings.find((b) => b.id === cancel.dataset.cancel));
        toast("Booking cancelled.");
      } else if (pay) {
        pay.disabled = true;
        await api.startCheckout(pay.dataset.pay);
      }
    } catch (err) {
      toast(err.message, "error");
      if (cancel) cancel.disabled = false;
      if (pay) pay.disabled = false;
    }
  });

  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
}

function handleCheckoutReturn() {
  const params = new URLSearchParams(location.search);
  const result = params.get("checkout");
  if (!result) return;
  if (result === "success") toast("Payment received. Your booking is confirmed!", "success");
  else toast("Payment was cancelled. You can pay later from My bookings.", "warn");
  history.replaceState(null, "", location.pathname);
}

async function init() {
  $("#demo-banner").hidden = !demo;
  bindEvents();
  handleCheckoutReturn();

  try {
    map = await createMap($("#map"), state.center, selectLot);
  } catch (err) {
    // Keep the list usable even if no map library can be loaded.
    console.error(err);
    $("#map").innerHTML = `<p class="map-error">The map couldn't be loaded. The list of parking lots still works.</p>`;
    map = { setCenter() {}, setUser() {}, setLots() {}, focusLot() {} };
  }
  map.setUser(state.center, state.radiusKm);

  api.subscribeLots(
    (lots) => {
      state.lots = lots;
      render();
    },
    (err) => {
      console.error(err);
      $("#results-summary").textContent = "Couldn't load parking lots. Check your connection.";
    }
  );
  api.onAuth(onUserChanged);
  api.onForegroundMessage((title, body) => toast(`${title}: ${body}`));
  api.getSettings().then((s) => (state.settings = s)).catch((err) => console.warn("Settings unavailable", err));

  // Try to centre on the user right away; locate() falls back gracefully.
  locate();
}

init();
