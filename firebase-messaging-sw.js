// Firebase Cloud Messaging service worker: shows push notifications while the
// app is in the background or closed.
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
importScripts("js/config.js");

firebase.initializeApp(self.APP_CONFIG.firebase);
const messaging = firebase.messaging();

// Messages with a `notification` payload are shown automatically by FCM;
// this handles data-only messages.
messaging.onBackgroundMessage((payload) => {
  if (payload.notification) return;
  const { title = "ParkIt", body = "" } = payload.data || {};
  self.registration.showNotification(title, { body, icon: "icons/icon.svg", data: payload.data });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const existing = list.find((c) => "focus" in c);
      return existing ? existing.focus() : clients.openWindow("./");
    })
  );
});
