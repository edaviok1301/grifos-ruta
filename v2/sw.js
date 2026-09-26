/* Service worker mínimo: solo para mostrar notificaciones locales (Android no permite
   `new Notification()` en la página). No usa push ni servidores externos. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const c = list.find((w) => "focus" in w);
    return c ? c.focus() : self.clients.openWindow("./");
  }));
});
