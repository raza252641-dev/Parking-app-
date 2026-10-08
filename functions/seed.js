// Seeds sample parking lots and app settings into Firestore.
//
// Usage (from /functions, after `npm install`):
//   GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account.json \
//   node seed.js --lat 40.758 --lng -73.9855 [--payments]
//
// Also: `node seed.js --admin user@example.com` grants that user the admin claim.
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

initializeApp();
const db = getFirestore();

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const LOTS = [
  ["Central Plaza Garage", 0.004, 0.002, 180, 6.5, ["Covered", "24/7", "EV charging"]],
  ["Riverside Parking", -0.006, 0.009, 90, 4, ["CCTV"]],
  ["Main Street Lot", 0.002, -0.007, 45, 3, []],
  ["City Hall Garage", -0.011, -0.004, 220, 5.5, ["Covered", "Accessible"]],
  ["Market Square Parking", 0.013, 0.006, 60, 3.5, ["CCTV"]],
  ["Station Park & Ride", -0.018, 0.016, 300, 2, ["24/7", "Accessible"]],
  ["Harbor View Lot", 0.021, -0.012, 75, 4.5, []],
  ["Museum Garage", -0.003, -0.015, 140, 6, ["Covered", "Valet"]],
];

async function seedLots(lat, lng) {
  const batch = db.batch();
  LOTS.forEach(([name, dLat, dLng, total, price, amenities], i) => {
    batch.set(db.doc(`parkingLots/lot-${i + 1}`), {
      name,
      address: `${100 + i * 37} Example St`,
      lat: lat + dLat,
      lng: lng + dLng,
      totalSpots: total,
      availableSpots: Math.floor(total * (0.2 + Math.random() * 0.6)),
      pricePerHour: price,
      amenities,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  batch.set(db.doc("config/app"), { requirePayment: process.argv.includes("--payments") }, { merge: true });
  await batch.commit();
  console.log(`Seeded ${LOTS.length} parking lots around ${lat}, ${lng}.`);
}

async function main() {
  const adminEmail = arg("admin");
  if (adminEmail) {
    const user = await getAuth().getUserByEmail(adminEmail);
    await getAuth().setCustomUserClaims(user.uid, { ...user.customClaims, admin: true });
    console.log(`${adminEmail} is now an admin (sign out and in again to apply).`);
    return;
  }
  await seedLots(Number(arg("lat", 40.758)), Number(arg("lng", -73.9855)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
