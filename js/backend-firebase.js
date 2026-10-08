// Firebase implementation of the backend interface used by app.js.
// See backend-demo.js for the same interface backed by localStorage.
const SDK = "https://www.gstatic.com/firebasejs/10.12.2";

const [{ initializeApp }, authMod, fs, fnMod, msgMod] = await Promise.all([
  import(`${SDK}/firebase-app.js`),
  import(`${SDK}/firebase-auth.js`),
  import(`${SDK}/firebase-firestore.js`),
  import(`${SDK}/firebase-functions.js`),
  import(`${SDK}/firebase-messaging.js`),
]);

const {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, updateProfile, GoogleAuthProvider,
  signInWithPopup, sendPasswordResetEmail, signOut: fbSignOut,
} = authMod;
const {
  getFirestore, collection, doc, getDoc, setDoc, onSnapshot, query, where,
  orderBy, runTransaction, serverTimestamp, Timestamp, arrayUnion,
} = fs;

const cfg = self.APP_CONFIG;
const app = initializeApp(cfg.firebase);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = fnMod.getFunctions(app, cfg.functionsRegion);

const toDate = (v) => (v instanceof Timestamp ? v.toDate() : v ? new Date(v) : null);

function bookingFromDoc(d) {
  const data = d.data();
  return {
    id: d.id,
    ...data,
    start: toDate(data.start),
    end: toDate(data.end),
    createdAt: toDate(data.createdAt),
  };
}

export const isDemo = false;

// ---- Auth -----------------------------------------------------------------

export function onAuth(cb) {
  return onAuthStateChanged(auth, (user) => {
    cb(user ? { uid: user.uid, email: user.email, name: user.displayName || user.email } : null);
  });
}

async function ensureUserDoc(user, name) {
  await setDoc(
    doc(db, "users", user.uid),
    { email: user.email, displayName: name || user.displayName || "", lastLoginAt: serverTimestamp() },
    { merge: true }
  );
}

export async function signIn(email, password) {
  const { user } = await signInWithEmailAndPassword(auth, email, password);
  await ensureUserDoc(user);
}

export async function signUp(name, email, password) {
  const { user } = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(user, { displayName: name });
  await ensureUserDoc(user, name);
}

export async function signInWithGoogle() {
  const { user } = await signInWithPopup(auth, new GoogleAuthProvider());
  await ensureUserDoc(user);
}

export const resetPassword = (email) => sendPasswordResetEmail(auth, email);
export const signOut = () => fbSignOut(auth);

// ---- Settings -------------------------------------------------------------

// config/app { requirePayment: bool } decides whether bookings go through
// Stripe. Firestore rules read the same document, so it can't be bypassed.
export async function getSettings() {
  const snap = await getDoc(doc(db, "config", "app"));
  return { requirePayment: snap.exists() && snap.data().requirePayment === true };
}

// ---- Parking lots (real-time) -----------------------------------------------

export function subscribeLots(cb, onError) {
  return onSnapshot(
    collection(db, "parkingLots"),
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError
  );
}

// ---- Bookings ---------------------------------------------------------------

export async function createBooking({ lot, start, hours, plate, requirePayment }) {
  const user = auth.currentUser;
  if (!user) throw new Error("Please sign in first.");

  const lotRef = doc(db, "parkingLots", lot.id);
  const bookingRef = doc(collection(db, "bookings"));
  const end = new Date(start.getTime() + hours * 3600_000);

  await runTransaction(db, async (tx) => {
    const lotSnap = await tx.get(lotRef);
    if (!lotSnap.exists()) throw new Error("This parking lot no longer exists.");
    const { availableSpots, pricePerHour, name } = lotSnap.data();
    if (availableSpots < 1) throw new Error("Sorry, this lot just filled up.");

    tx.set(bookingRef, {
      userId: user.uid,
      lotId: lot.id,
      lotName: name,
      start: Timestamp.fromDate(start),
      end: Timestamp.fromDate(end),
      hours,
      plate,
      amount: Math.round(hours * pricePerHour * 100) / 100,
      currency: cfg.currency,
      status: requirePayment ? "pending_payment" : "confirmed",
      paymentStatus: requirePayment ? "unpaid" : "pay_on_site",
      reminderSent: false,
      createdAt: serverTimestamp(),
    });
    // lastBookingId lets the security rules verify this spot is being taken
    // by a booking created in the same transaction.
    tx.update(lotRef, {
      availableSpots: availableSpots - 1,
      lastBookingId: bookingRef.id,
      updatedAt: serverTimestamp(),
    });
  });

  return { id: bookingRef.id };
}

export function subscribeMyBookings(cb, onError) {
  const user = auth.currentUser;
  if (!user) return () => {};
  const q = query(collection(db, "bookings"), where("userId", "==", user.uid), orderBy("start", "desc"));
  return onSnapshot(q, (snap) => cb(snap.docs.map(bookingFromDoc)), onError);
}

export async function cancelBooking(booking) {
  const lotRef = doc(db, "parkingLots", booking.lotId);
  const bookingRef = doc(db, "bookings", booking.id);
  await runTransaction(db, async (tx) => {
    const [lotSnap, bSnap] = await Promise.all([tx.get(lotRef), tx.get(bookingRef)]);
    const status = bSnap.data()?.status;
    if (status !== "confirmed" && status !== "pending_payment") {
      throw new Error("This booking can no longer be cancelled.");
    }
    tx.update(bookingRef, { status: "cancelled", cancelledAt: serverTimestamp() });
    tx.update(lotRef, {
      availableSpots: lotSnap.data().availableSpots + 1,
      lastBookingId: booking.id,
      updatedAt: serverTimestamp(),
    });
  });
}

// Creates a Stripe Checkout session server-side and redirects to it.
export async function startCheckout(bookingId) {
  const createSession = fnMod.httpsCallable(functions, "createCheckoutSession");
  const { data } = await createSession({ bookingId, returnUrl: location.origin + location.pathname });
  location.assign(data.url);
}

// ---- Push notifications -----------------------------------------------------

export async function enablePush() {
  if (!(await msgMod.isSupported())) throw new Error("Push notifications aren't supported in this browser.");
  const user = auth.currentUser;
  if (!user) throw new Error("Please sign in first.");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted.");

  const swUrl = new URL("firebase-messaging-sw.js", location.href);
  const registration = await navigator.serviceWorker.register(swUrl);
  const messaging = msgMod.getMessaging(app);
  const token = await msgMod.getToken(messaging, {
    vapidKey: cfg.fcmVapidKey,
    serviceWorkerRegistration: registration,
  });
  await setDoc(doc(db, "users", user.uid), { fcmTokens: arrayUnion(token) }, { merge: true });
  return token;
}

// Foreground messages (the service worker handles background ones).
export async function onForegroundMessage(cb) {
  if (!(await msgMod.isSupported())) return;
  msgMod.onMessage(msgMod.getMessaging(app), (payload) => {
    cb(payload.notification?.title || "Update", payload.notification?.body || "");
  });
}
