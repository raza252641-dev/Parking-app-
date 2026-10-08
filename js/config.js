// App configuration. This file is a classic script (not a module) so the
// FCM service worker can load it too via importScripts().
//
// Fill in your own keys. While the Firebase apiKey still starts with "YOUR_",
// the app runs in DEMO MODE: sample parking lots, fake auth and bookings saved
// in localStorage, so you can try the UI before setting anything up.
self.APP_CONFIG = {
  firebase: {
    apiKey: "YOUR_FIREBASE_API_KEY",
    authDomain: "YOUR_PROJECT.firebaseapp.com",
    projectId: "YOUR_PROJECT",
    storageBucket: "YOUR_PROJECT.appspot.com",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID",
  },

  // Firebase Console → Project settings → Cloud Messaging → Web Push certificates.
  fcmVapidKey: "YOUR_FCM_VAPID_KEY",

  // Google Cloud Console → APIs & Services → Credentials (enable "Maps JavaScript API").
  // Restrict this key to your domain. Leave the placeholder to use the free
  // OpenStreetMap/Leaflet fallback map instead.
  googleMapsApiKey: "YOUR_GOOGLE_MAPS_API_KEY",

  // Region for the Cloud Functions in /functions (used for Stripe checkout).
  functionsRegion: "us-central1",

  // Used when the browser can't (or won't) share its location.
  defaultCenter: { lat: 40.758, lng: -73.9855 },
  defaultRadiusKm: 5,
  currency: "USD",
};
