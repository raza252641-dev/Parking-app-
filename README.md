# ParkIt – Parking Finder & Reservation App

A web app (installable as a PWA) to find nearby parking, see live availability and reserve a spot in advance.

| Feature | How it works |
| --- | --- |
| **Find nearby parking** | Browser GPS → lots within a chosen radius, sorted by distance, price or free spots. Map via Google Maps (falls back to free OpenStreetMap if no key). |
| **Real-time availability** | Firestore `onSnapshot` listener — spot counts and map pins update live. |
| **User authentication** | Firebase Auth: email/password, Google sign-in, password reset. |
| **Booking & payment** | Bookings are created in a Firestore transaction that atomically takes a spot. Optional Stripe Checkout via Cloud Functions; otherwise "pay on site". |
| **Push notifications** | Firebase Cloud Messaging: booking confirmation, payment, cancellation and a reminder 15 min before arrival. |

The front end is plain HTML/CSS/JS (no build step), so you can upload it to any static host, including a normal cPanel `public_html` over FTP.

## Try it now (demo mode)

As long as `js/config.js` still has the `YOUR_...` placeholders, the app runs in **demo mode**. It shows sample lots around your location, simulates live availability, and keeps fake accounts and bookings in your browser.

```bash
python3 -m http.server 8080   # then open http://localhost:8080
```

Geolocation and service workers need **HTTPS** (or `localhost`) once deployed.

## Project structure

```
index.html                 App shell (map, list, auth/booking dialogs)
css/styles.css
js/config.js               ← your API keys go here
js/app.js                  UI logic
js/backend-firebase.js     Firebase Auth / Firestore / FCM / Stripe calls
js/backend-demo.js         Same interface, localStorage-backed (demo mode)
js/map.js                  Google Maps / Leaflet adapter
js/geo.js                  Geolocation + distance helpers
firebase-messaging-sw.js   FCM background notifications
firestore.rules            Security rules (see "Data model")
firestore.indexes.json
functions/                 Cloud Functions: reminders, spot release, Stripe
functions/seed.js          Seed sample lots / grant admin
```

## Setup

### 1. Firebase project
1. Create a project at <https://console.firebase.google.com>, then add a **Web app**. Copy its config into `js/config.js` → `firebase`.
2. **Authentication** → enable *Email/Password* and *Google*. Under *Settings → Authorized domains*, add your website's domain.
3. **Firestore Database** → create it in production mode.
4. **Cloud Messaging** → *Web Push certificates* → generate a key pair. Put the public key in `fcmVapidKey`.
5. Deploy the rules and indexes:
   ```bash
   npm i -g firebase-tools && firebase login
   firebase use --add            # pick your project
   firebase deploy --only firestore
   ```

### 2. Google Maps
Enable **Maps JavaScript API** in Google Cloud Console, create an API key **restricted to your domain** and set `googleMapsApiKey`. If you skip this step, the app uses OpenStreetMap instead.

### 3. Seed parking lots
Create a service account key (Project settings → Service accounts). Then run:
```bash
cd functions && npm install
GOOGLE_APPLICATION_CREDENTIALS=../service-account.json node seed.js --lat 24.8607 --lng 67.0011
GOOGLE_APPLICATION_CREDENTIALS=../service-account.json node seed.js --admin you@example.com
```
Admins (users with the `admin` custom claim) can create and edit lots and `config/app`. Real availability would normally come from a sensor or operator system that writes `availableSpots` with the Admin SDK.

### 4. Cloud Functions (reminders, spot release, Stripe)
Requires the Firebase **Blaze** plan. Its free tier covers small apps.
```bash
firebase deploy --only functions
```
- `bookingMaintenance` runs every 5 minutes. It sends reminders, marks finished bookings `completed` and returns their spot, and expires unpaid holds after 30 minutes.
- `onBookingCreated` / `onBookingUpdated` send push notifications.

### 5. Stripe (optional)
1. Set the secrets:
   ```bash
   firebase functions:secrets:set STRIPE_SECRET_KEY        # sk_test_...
   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET    # whsec_...
   firebase deploy --only functions
   ```
2. In the Stripe Dashboard, add a webhook pointing to the `stripeWebhook` function URL. Use the event `checkout.session.completed`.
3. Turn payments on: set Firestore doc `config/app` to `{ requirePayment: true }` (or run `seed.js --payments`).

The server always recomputes the price from the lot, so the client can't change what it pays.

## Deploying to your own hosting (FTP / cPanel)

Upload these files to your web root (for example `public_html/parking/`):

```
index.html  manifest.json  firebase-messaging-sw.js  css/  js/  icons/
```

Do **not** upload `functions/`, `firestore.*`, `firebase.json` or any service-account file. The site must be served over **HTTPS** for GPS and notifications to work. You can also use `firebase deploy --only hosting`.

If you use the VS Code SFTP/FTP extension, keep its settings file (`.vscode/sftp.json`) out of Git. It is already in `.gitignore`. Never commit hosting passwords. This app doesn't use a MySQL database; all data lives in Firestore.

## Data model (Firestore)

- `parkingLots/{id}`: `name, address, lat, lng, totalSpots, availableSpots, pricePerHour, amenities[]`
- `bookings/{id}`: `userId, lotId, lotName, start, end, hours, plate, amount, currency, status, paymentStatus, reminderSent`
  - `status`: `pending_payment` → `confirmed` → `completed`, or `cancelled` / `expired`
- `users/{uid}`: `email, displayName, fcmTokens[]`
- `config/app`: `{ requirePayment: boolean }`

The security rules enforce the following:
- Customers can change a lot's `availableSpots` only by ±1, and only in the same transaction that creates or cancels one of their own bookings for that lot.
- Bookings must belong to the user and have a valid time range.
- Bookings must start as `pending_payment` when payment is required.
- Only admins can manage lots and settings.
