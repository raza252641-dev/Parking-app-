const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

initializeApp();
const db = getFirestore();

const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

const REMINDER_LEAD_MIN = 15;
const PAYMENT_HOLD_MIN = 30;

// ---- Push notifications -------------------------------------------------------

async function notifyUser(uid, title, body, data = {}) {
  const userRef = db.doc(`users/${uid}`);
  const tokens = (await userRef.get()).get("fcmTokens") || [];
  if (!tokens.length) return;

  const res = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data,
    webpush: { fcmOptions: { link: "/" } },
  });

  // Drop tokens FCM says are no longer valid.
  const stale = tokens.filter((_, i) => {
    const code = res.responses[i].error?.code;
    return code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token";
  });
  if (stale.length) await userRef.update({ fcmTokens: FieldValue.arrayRemove(...stale) });
}

const fmtTime = (ts) =>
  ts.toDate().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";

exports.onBookingCreated = onDocumentCreated("bookings/{bookingId}", async (event) => {
  const b = event.data.data();
  if (b.status !== "confirmed") return;
  await notifyUser(b.userId, "Booking confirmed", `${b.lotName} · ${fmtTime(b.start)}`, { bookingId: event.params.bookingId });
});

exports.onBookingUpdated = onDocumentUpdated("bookings/{bookingId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (before.status === after.status) return;
  const messages = {
    confirmed: ["Payment received", `Your spot at ${after.lotName} is confirmed for ${fmtTime(after.start)}.`],
    cancelled: ["Booking cancelled", `Your booking at ${after.lotName} was cancelled.`],
    expired: ["Booking expired", `Payment wasn't completed, so your hold at ${after.lotName} was released.`],
  };
  const msg = messages[after.status];
  if (msg) await notifyUser(after.userId, msg[0], msg[1], { bookingId: event.params.bookingId });
});

// Frees the booking's spot and moves it to `status` atomically.
async function releaseSpot(bookingRef, status) {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(bookingRef);
    const b = snap.data();
    if (!["confirmed", "pending_payment"].includes(b.status)) return;
    const lotRef = db.doc(`parkingLots/${b.lotId}`);
    const lot = await tx.get(lotRef);
    tx.update(bookingRef, { status });
    if (lot.exists) {
      tx.update(lotRef, {
        availableSpots: Math.min(lot.get("totalSpots"), lot.get("availableSpots") + 1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });
}

// Every 5 minutes: send arrival reminders, complete finished bookings and
// expire unpaid holds, returning their spots to the pool.
exports.bookingMaintenance = onSchedule("every 5 minutes", async () => {
  const now = Timestamp.now();
  const soon = Timestamp.fromMillis(now.toMillis() + REMINDER_LEAD_MIN * 60_000);

  const [dueReminders, ended, unpaid] = await Promise.all([
    db.collection("bookings").where("status", "==", "confirmed").where("reminderSent", "==", false)
      .where("start", "<=", soon).get(),
    db.collection("bookings").where("status", "==", "confirmed").where("end", "<=", now).get(),
    db.collection("bookings").where("status", "==", "pending_payment")
      .where("createdAt", "<=", Timestamp.fromMillis(now.toMillis() - PAYMENT_HOLD_MIN * 60_000)).get(),
  ]);

  const jobs = [];
  for (const d of dueReminders.docs) {
    const b = d.data();
    if (b.end.toMillis() <= now.toMillis()) continue;
    jobs.push(
      notifyUser(b.userId, "Parking reminder", `Your spot at ${b.lotName} starts at ${fmtTime(b.start)}. Plate: ${b.plate}.`, { bookingId: d.id })
        .then(() => d.ref.update({ reminderSent: true }))
    );
  }
  for (const d of ended.docs) jobs.push(releaseSpot(d.ref, "completed"));
  for (const d of unpaid.docs) jobs.push(releaseSpot(d.ref, "expired"));

  const results = await Promise.allSettled(jobs);
  results.filter((r) => r.status === "rejected").forEach((r) => logger.error(r.reason));
  logger.info(`Maintenance: ${dueReminders.size} reminders, ${ended.size} completed, ${unpaid.size} expired.`);
});

// ---- Stripe payments (optional) -----------------------------------------------
// Enable by setting config/app { requirePayment: true } in Firestore and
// configuring the two secrets (see README).

exports.createCheckoutSession = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in.");
  const { bookingId, returnUrl } = req.data || {};
  if (typeof bookingId !== "string" || typeof returnUrl !== "string" || !/^https?:\/\//.test(returnUrl)) {
    throw new HttpsError("invalid-argument", "bookingId and returnUrl are required.");
  }

  const bookingRef = db.doc(`bookings/${bookingId}`);
  const booking = (await bookingRef.get()).data();
  if (!booking || booking.userId !== req.auth.uid) throw new HttpsError("not-found", "Booking not found.");
  if (booking.status !== "pending_payment") throw new HttpsError("failed-precondition", "This booking doesn't need payment.");

  // Price is recomputed from the lot so the client can't change it.
  const lot = (await db.doc(`parkingLots/${booking.lotId}`).get()).data();
  if (!lot) throw new HttpsError("not-found", "Parking lot not found.");
  const amountCents = Math.round(booking.hours * lot.pricePerHour * 100);

  const stripe = require("stripe")(STRIPE_SECRET_KEY.value());
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: req.auth.token.email,
    client_reference_id: bookingId,
    metadata: { bookingId },
    expires_at: Math.floor(Date.now() / 1000) + PAYMENT_HOLD_MIN * 60,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: (booking.currency || "USD").toLowerCase(),
        unit_amount: amountCents,
        product_data: {
          name: `Parking at ${lot.name}`,
          description: `${booking.hours} h from ${fmtTime(booking.start)} · ${booking.plate}`,
        },
      },
    }],
    success_url: `${returnUrl}?checkout=success`,
    cancel_url: `${returnUrl}?checkout=cancelled`,
  });

  await bookingRef.update({ amount: amountCents / 100, stripeSessionId: session.id });
  return { url: session.url };
});

exports.stripeWebhook = onRequest({ secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] }, async (req, res) => {
  const stripe = require("stripe")(STRIPE_SECRET_KEY.value());
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET.value());
  } catch (err) {
    logger.warn("Invalid Stripe signature", err.message);
    res.status(400).send("Invalid signature");
    return;
  }

  if (event.type === "checkout.session.completed" && event.data.object.payment_status === "paid") {
    const bookingId = event.data.object.metadata?.bookingId;
    const ref = db.doc(`bookings/${bookingId}`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const update = { paymentStatus: "paid", stripePaymentIntent: event.data.object.payment_intent };
      // If the hold already expired, keep the record but flag it for a refund.
      if (snap.get("status") === "pending_payment") update.status = "confirmed";
      else update.needsRefund = true;
      tx.update(ref, update);
    });
  }
  res.json({ received: true });
});
