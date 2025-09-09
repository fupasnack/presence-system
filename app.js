// app.js — Presensi FUPA (complete client logic)
// - Features: Auth, Session management, Profile, Presensi (camera, compress ≤30KB, strip EXIF), Cloudinary unsigned uploads
// - Notifications: leave requests -> admin, admin approve/reject -> notify employee, admin override -> notify all, announcements
// - Admin: create karyawan account without logging out (second auth), manage presensi, export CSV
// - Auto-bootstrap collections: users, _meta/_srv, _settings/today
// - Security logging (to security_logs collection)
// IMPORTANT: This file expects firebase compat libs already loaded in the page.

////////////////////////////////////////////////////////////////////////////////
// CONFIG (provided by user)
////////////////////////////////////////////////////////////////////////////////
const firebaseConfig = {
  apiKey: "AIzaSyA08VBr5PfN5HB7_eub0aZ9-_FSFFHM62M",
  authDomain: "presence-system-adfd7.firebaseapp.com",
  projectId: "presence-system-adfd7",
  storageBucket: "presence-system-adfd7.firebasestorage.app",
  messagingSenderId: "84815583677",
  appId: "1:84815583677:web:12e743b9f5c2b0cb395ad4",
  measurementId: "G-HHJREDRFZB"
};

const CLOUD_NAME = "dn2o2vf04";
const UPLOAD_PRESET = "presensi_unsigned";

// Admin and Karyawan UIDs (as provided)
const ADMIN_UIDS = new Set([
  "DsBQ1TdWjgXvpVHUQJpF1H6jZzJ3", // karomi@fupa.id
  "xxySAjSMqKeq7SC6r5vyzes7USY2"  // annisa@fupa.id
]);

const KARYAWAN_UIDS = new Set([
  "y2MTtiGZcVcts2MkQncckAaUasm2", // x@fupa.id
  "4qwoQhWyZmatqkRYaENtz5Uw8fy1",
  "UkIHdrTF6vefeuzp94ttlmxZzqk2",
  "kTpmDbdBETQT7HIqT6TvpLwrbQf2",
  "15FESE0b7cQFKqdJSqNBTZlHqWR2",
  "1tQidUDFTjRTJdJJYIudw9928pa2",
  "7BCcTwQ5wDaxWA6xbzJX9VWj1o52",
  "mpyFesOjUIcs8O8Sh3tVLS8x7dA3",
  "2jV2is3MQRhv7nnd1gXeqiaj11t2",
  "or2AQDVY1hdpwT0YOmL4qJrgCju1",
  "HNJ52lywYVaUhRK3BNEARfQsQo22"
]);

////////////////////////////////////////////////////////////////////////////////
// Initialization
////////////////////////////////////////////////////////////////////////////////
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

////////////////////////////////////////////////////////////////////////////////
// Security/session parameters
////////////////////////////////////////////////////////////////////////////////
const SECURITY = {
  maxLoginAttempts: 5,
  lockoutDurationMs: 15 * 60 * 1000, // 15 minutes
  sessionDurationMs: 12 * 60 * 60 * 1000, // 12 hours
  passwordMinLength: 8,
  sessionRefreshIntervalMs: 30 * 60 * 1000 // 30 minutes
};

////////////////////////////////////////////////////////////////////////////////
// Small UI helpers (expect elements exist in page)
////////////////////////////////////////////////////////////////////////////////
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
function toast(msg, ms = 2200) {
  const el = $("#toast");
  if (!el) return alert(msg);
  el.textContent = msg;
  el.style.display = "block";
  setTimeout(() => el.style.display = "none", ms);
}

////////////////////////////////////////////////////////////////////////////////
// Utilities: server time, ymd formatting
////////////////////////////////////////////////////////////////////////////////
async function getServerTime() {
  // Use _meta/_srv document write/read to get serverTimestamp
  const docRef = db.collection("_meta").doc("_srv");
  await docRef.set({ t: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
  const snap = await docRef.get();
  const ts = snap.get("t");
  return ts ? ts.toDate() : new Date();
}
function fmtDateTime(d) {
  const pad = n => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function ymd(d) {
  const pad = n => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

////////////////////////////////////////////////////////////////////////////////
// Session management (store small session doc in Firestore, session_id in localStorage)
////////////////////////////////////////////////////////////////////////////////
async function createSessionRecord(user) {
  const expires = firebase.firestore.Timestamp.fromDate(new Date(Date.now() + SECURITY.sessionDurationMs));
  const session = {
    uid: user.uid,
    email: user.email || "",
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    expiresAt: expires,
    userAgent: navigator.userAgent,
    ip: await _getClientIP(),
    valid: true
  };
  const ref = await db.collection("sessions").add(session);
  localStorage.setItem("session_id", ref.id);
  return ref.id;
}
async function checkSessionValidity() {
  const sid = localStorage.getItem("session_id");
  if (!sid) return false;
  try {
    const doc = await db.collection("sessions").doc(sid).get();
    if (!doc.exists) return false;
    const data = doc.data();
    if (!data.valid) return false;
    const exp = data.expiresAt && data.expiresAt.toDate ? data.expiresAt.toDate() : new Date(data.expiresAt);
    if (exp < new Date()) {
      try { await db.collection("sessions").doc(sid).delete(); } catch {}
      localStorage.removeItem("session_id");
      return false;
    }
    if (!auth.currentUser || auth.currentUser.uid !== data.uid) return false;
    return true;
  } catch (e) {
    console.error("checkSessionValidity", e);
    return false;
  }
}
async function refreshSession() {
  const sid = localStorage.getItem("session_id");
  if (!sid) return;
  try {
    await db.collection("sessions").doc(sid).update({
      expiresAt: firebase.firestore.Timestamp.fromDate(new Date(Date.now() + SECURITY.sessionDurationMs))
    });
  } catch (e) {
    console.warn("refreshSession failed", e);
  }
}

////////////////////////////////////////////////////////////////////////////////
// Security logs (best-effort; not blocking)
////////////////////////////////////////////////////////////////////////////////
async function logEvent(type, meta = {}) {
  try {
    const payload = {
      type,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      userAgent: navigator.userAgent,
      ip: await _getClientIP(),
      ...meta
    };
    if (auth.currentUser) {
      payload.uid = auth.currentUser.uid;
      payload.email = auth.currentUser.email;
    }
    await db.collection("security_logs").add(payload);
  } catch (e) {
    console.warn("logEvent failed", e);
  }
}

////////////////////////////////////////////////////////////////////////////////
// Get client IP (best-effort)
////////////////////////////////////////////////////////////////////////////////
async function _getClientIP() {
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    const j = await res.json();
    return j.ip || "unknown";
  } catch {
    return "unknown";
  }
}

////////////////////////////////////////////////////////////////////////////////
// Bootstrap: ensure essential collections exist & default docs
////////////////////////////////////////////////////////////////////////////////
async function bootstrapForUser(user) {
  // users doc
  const upRef = db.collection("users").doc(user.uid);
  const upDoc = await upRef.get();
  if (!upDoc.exists) {
    await upRef.set({
      email: user.email || "",
      role: ADMIN_UIDS.has(user.uid) ? "admin" : (KARYAWAN_UIDS.has(user.uid) ? "karyawan" : "unknown"),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      lastLogin: firebase.firestore.FieldValue.serverTimestamp()
    });
    await logEvent("user_profile_created", { uid: user.uid });
  } else {
    await upRef.set({ lastLogin: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }

  // _meta/_srv
  await db.collection("_meta").doc("_srv").set({ t: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });

  // _settings/today default
  const settingsTodayRef = db.collection("_settings").doc("today");
  const settingsSnap = await settingsTodayRef.get();
  if (!settingsSnap.exists) {
    await settingsTodayRef.set({ mode: "auto", date: ymd(new Date()) }, { merge: true });
  }
}

////////////////////////////////////////////////////////////////////////////////
// Role helpers
////////////////////////////////////////////////////////////////////////////////
function isAdminUid(uid) { return ADMIN_UIDS.has(uid); }
function isKaryawanUid(uid) { return KARYAWAN_UIDS.has(uid); }

////////////////////////////////////////////////////////////////////////////////
// Camera + Image compression (target ≤30 KB) + strip metadata
////////////////////////////////////////////////////////////////////////////////
/**
 * Capture video to canvas (caller sets canvas size)
 */
function captureToCanvas(videoEl, canvasEl, maxWidth=720) {
  const w = videoEl.videoWidth || 640;
  const h = videoEl.videoHeight || 480;
  const scale = Math.min(1, maxWidth / w);
  canvasEl.width = Math.round(w * scale);
  canvasEl.height = Math.round(h * scale);
  const ctx = canvasEl.getContext("2d");
  ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
}

/**
 * Convert canvas -> compressed Blob <= targetKB (approx), strip EXIF by re-drawing image.
 * Returns a Blob (image/jpeg).
 */
async function canvasToCompressedBlob(canvas, targetKB = 30) {
  // initial quality attempt
  let quality = 0.65;
  let blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", quality));

  // reduce quality iteratively
  for (let i = 0; i < 6 && blob.size / 1024 > targetKB; i++) {
    quality = Math.max(0.25, quality - 0.08);
    blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", quality));
  }

  // If still too large, downscale
  if (blob.size / 1024 > targetKB) {
    const scale = Math.sqrt((targetKB * 1024) / blob.size);
    const newW = Math.max(320, Math.round(canvas.width * scale));
    const newH = Math.max(240, Math.round(canvas.height * scale));
    const tmp = document.createElement("canvas");
    tmp.width = newW;
    tmp.height = newH;
    const ctx = tmp.getContext("2d");
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    await new Promise(r => img.onload = r);
    ctx.drawImage(img, 0, 0, newW, newH);
    blob = await new Promise(res => tmp.toBlob(res, "image/jpeg", 0.75));
  }

  // Final strip metadata pass - draw into new canvas & export
  const img2 = new Image();
  img2.src = URL.createObjectURL(blob);
  await new Promise(r => img2.onload = r);
  const clean = document.createElement("canvas");
  clean.width = img2.width;
  clean.height = img2.height;
  clean.getContext("2d").drawImage(img2, 0, 0);
  const finalBlob = await new Promise(res => clean.toBlob(res, "image/jpeg", 0.85));

  // If final still > targetKB, user will get best-effort small image
  return finalBlob;
}

////////////////////////////////////////////////////////////////////////////////
// Cloudinary unsigned upload
////////////////////////////////////////////////////////////////////////////////
async function uploadToCloudinary(fileBlob) {
  const url = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/upload`;
  const form = new FormData();
  form.append("file", fileBlob);
  form.append("upload_preset", UPLOAD_PRESET);
  const resp = await fetch(url, { method: "POST", body: form });
  if (!resp.ok) throw new Error("Cloudinary upload failed");
  const j = await resp.json();
  return j.secure_url || j.url;
}

////////////////////////////////////////////////////////////////////////////////
// Presensi: save, subscribe (riwayat)
////////////////////////////////////////////////////////////////////////////////
async function savePresensi({ uid, nama, jenis, status, lat=null, lng=null, selfieUrl="", serverDate=null }) {
  // serverDate may be Date
  const ts = serverDate || new Date();
  const doc = {
    uid,
    nama: nama || "",
    jenis,
    status,
    lat,
    lng,
    selfieUrl: selfieUrl || "",
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    localTime: fmtDateTime(ts),
    ymd: ymd(ts)
  };
  const ref = await db.collection("presensi").add(doc);
  await logEvent("presensi_created", { presensiId: ref.id, uid, jenis, status });
  return ref.id;
}
function subscribeRiwayat(uid, cb) {
  return db.collection("presensi")
    .where("uid", "==", uid)
    .orderBy("createdAt", "desc")
    .limit(20)
    .onSnapshot(snap => {
      const arr = [];
      snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
      cb(arr);
    });
}

////////////////////////////////////////////////////////////////////////////////
// Notifications: subscribe, create, mark read, delete
////////////////////////////////////////////////////////////////////////////////
function subscribeNotifications(uid, cb) {
  // notifications targeted at userId == uid OR userId == 'all' OR userId == 'admin' (admins)
  return db.collection("notifications")
    .where("userId", "in", [uid, "all", "admin"])
    .orderBy("createdAt", "desc")
    .limit(50)
    .onSnapshot(snap => {
      const arr = [];
      snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
      cb(arr);
    });
}

async function createNotification({ userId = "all", type = "info", title, message, data = {} }) {
  if (!title) title = type;
  await db.collection("notifications").add({
    userId,
    type,
    title,
    message,
    data,
    read: false,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

async function markNotificationAsRead(id) {
  await db.collection("notifications").doc(id).update({ read: true });
}
async function deleteNotification(id) {
  await db.collection("notifications").doc(id).delete();
  await logEvent("notification_deleted", { notificationId: id });
}

////////////////////////////////////////////////////////////////////////////////
// Cuti (leave) flow: submit by employee -> admin receives notification.
// Admin can approve/reject; approve creates presensi entry; both actions notify employee.
////////////////////////////////////////////////////////////////////////////////
async function ajukanCuti(uid, nama, jenis, tanggal, catatan = "") {
  // tanggal should be "YYYY-MM-DD"
  const ref = await db.collection("cuti").add({
    uid,
    nama,
    jenis,
    tanggal,
    catatan,
    status: "menunggu",
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });

  // notify admin(s): we create a notification targeted to 'admin'
  await db.collection("notifications").add({
    userId: "admin",
    type: "cuti",
    title: "Permintaan Cuti Baru",
    message: `${nama} mengajukan ${jenis} pada ${tanggal}`,
    data: { cutiId: ref.id, uid, nama, jenis, tanggal, catatan },
    read: false,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });

  await logEvent("cuti_submitted", { cutiId: ref.id, uid });
  return ref.id;
}

/**
 * Admin approves or rejects cuti.
 * If approved -> create a presensi entry for that date with no coords/selfie (fields left null/empty).
 * Send notification back to employee with result.
 */
async function setCutiStatus(cutiId, status, adminUid) {
  // status expected values: "disetujui", "ditolak"
  const cutiRef = db.collection("cuti").doc(cutiId);
  const snap = await cutiRef.get();
  if (!snap.exists) throw new Error("cuti not found");
  const cuti = snap.data();

  await cutiRef.set({ status, decidedBy: adminUid, decidedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });

  if (status === "disetujui") {
    // Create presensi auto
    try {
      const serverDate = new Date(cuti.tanggal + "T09:00:00"); // midday fallback (time irrelevant)
      await db.collection("presensi").add({
        uid: cuti.uid,
        nama: cuti.nama,
        jenis: cuti.jenis,
        status: cuti.jenis, // description equals jenis (leave/sick/permission)
        lat: null,
        lng: null,
        selfieUrl: "",
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        localTime: fmtDateTime(serverDate),
        ymd: cuti.tanggal,
        isCuti: true,
        createdByAdmin: adminUid
      });
    } catch (e) {
      console.warn("auto-create presensi for cuti failed", e);
    }
  }

  // Notify employee
  await db.collection("notifications").add({
    userId: cuti.uid,
    type: "cuti",
    title: "Status Cuti",
    message: `Cuti Anda pada ${cuti.tanggal} telah ${status}`,
    data: { cutiId, status },
    read: false,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });

  await logEvent("cuti_status_changed", { cutiId, status, adminUid });
}

function subscribeCutiAdmin(cb) {
  return db.collection("cuti")
    .where("status", "==", "menunggu")
    .orderBy("createdAt", "desc")
    .limit(50)
    .onSnapshot(snap => {
      const arr = [];
      snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
      cb(arr);
    });
}

////////////////////////////////////////////////////////////////////////////////
// Override feature: admin sets override for a date -> stored in overrides/{date} and 
// a notification is broadcast to all employees.
////////////////////////////////////////////////////////////////////////////////
async function setOverrideStatus(dateYMD, status, adminUid) {
  // status example: "libur" | "masuk" | "wajib" | "tidak-wajib"
  await db.collection("overrides").doc(dateYMD).set({
    status,
    createdBy: adminUid,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });

  // Notify everyone
  await createNotification({
    userId: "all",
    type: "override",
    title: "Override Status Presensi",
    message: `Admin menetapkan override pada ${dateYMD}: ${status}`,
    data: { date: dateYMD, status, adminUid }
  });

  await logEvent("override_set", { dateYMD, status, adminUid });
}

async function getScheduleOverride(dateYMD) {
  const doc = await db.collection("_settings").doc("today").get();
  if (doc.exists) {
    const d = doc.data();
    if (d.date === dateYMD) return d.mode; // mode: auto | forceOn | forceOff
  }
  const overrideDoc = await db.collection("overrides").doc(dateYMD).get();
  if (overrideDoc.exists) return overrideDoc.data().status;
  return "auto";
}

////////////////////////////////////////////////////////////////////////////////
// Announcements by admin (broadcast to all)
////////////////////////////////////////////////////////////////////////////////
async function kirimPengumuman(text, adminUid) {
  await db.collection("notifications").add({
    userId: "all",
    type: "pengumuman",
    title: "Pengumuman",
    message: text,
    data: { from: adminUid },
    read: false,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  await logEvent("announcement_sent", { adminUid, snippet: text.substring(0, 120) });
}

////////////////////////////////////////////////////////////////////////////////
// Profile management
////////////////////////////////////////////////////////////////////////////////
async function saveProfile(uid, { nama, alamat, pfpUrl }) {
  const d = {};
  if (nama !== undefined) d.nama = nama;
  if (alamat !== undefined) d.alamat = alamat;
  if (pfpUrl !== undefined) d.pfp = pfpUrl;
  d.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
  await db.collection("users").doc(uid).set(d, { merge: true });
  await logEvent("profile_saved", { uid, fields: Object.keys(d).filter(k => k !== "updatedAt") });
}
async function getProfile(uid) {
  const snap = await db.collection("users").doc(uid).get();
  return snap.exists ? snap.data() : {};
}

////////////////////////////////////////////////////////////////////////////////
// Admin: create user without logging out (second firebase app)
////////////////////////////////////////////////////////////////////////////////
function getSecondAuth() {
  // initialize second app lazily
  if (!firebase.apps.some(a => a.name === "second")) {
    firebase.initializeApp(firebaseConfig, "second");
  }
  return firebase.app("second").auth();
}
async function createKaryawanAccountByAdmin(email, password, adminUid) {
  const secondAuth = getSecondAuth();
  try {
    const cred = await secondAuth.createUserWithEmailAndPassword(email, password);
    const newUid = cred.user.uid;
    await db.collection("users").doc(newUid).set({
      email,
      role: "karyawan",
      createdBy: adminUid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await logEvent("karyawan_created", { adminUid, newUid, email });
    // ensure sign out the second auth to avoid session mixing
    await secondAuth.signOut();
    return newUid;
  } catch (e) {
    // ensure sign out if partially created
    try { await secondAuth.signOut(); } catch {}
    throw e;
  }
}

////////////////////////////////////////////////////////////////////////////////
// Admin: read presensi list with filters (client will call these)
////////////////////////////////////////////////////////////////////////////////
async function fetchPresensi({ namaFilter = "", tanggal = "", periode = "semua", limit = 500 } = {}) {
  // periode: hari|minggu|bulan|tahun|semua
  let q = db.collection("presensi").orderBy("createdAt", "desc");
  if (periode && periode !== "semua") {
    const now = new Date();
    const start = new Date();
    switch (periode) {
      case "hari": start.setHours(0,0,0,0); break;
      case "minggu": start.setDate(now.getDate() - 7); break;
      case "bulan": start.setMonth(now.getMonth() - 1); break;
      case "tahun": start.setFullYear(now.getFullYear() - 1); break;
    }
    q = q.where("createdAt", ">=", start);
  }
  const snap = await q.limit(limit).get();
  let arr = [];
  snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
  if (tanggal) arr = arr.filter(x => x.ymd === tanggal);
  if (namaFilter) arr = arr.filter(x => (x.nama || "").toLowerCase().includes(namaFilter.toLowerCase()));
  return arr;
}

////////////////////////////////////////////////////////////////////////////////
// Delete presensi (admin only)
////////////////////////////////////////////////////////////////////////////////
async function deletePresensi(id) {
  const doc = await db.collection("presensi").doc(id).get();
  if (!doc.exists) throw new Error("presensi not found");
  const data = doc.data();
  await db.collection("presensi").doc(id).delete();
  await logEvent("presensi_deleted", { presensiId: id, uid: data.uid || null });
}

////////////////////////////////////////////////////////////////////////////////
// Utility: export CSV (simple)
////////////////////////////////////////////////////////////////////////////////
function toCSV(rows, columns) {
  const esc = v => `"${(v ?? "").toString().replace(/"/g, '""')}"`;
  const header = columns.map(esc).join(",");
  const body = rows.map(r => columns.map(k => esc(r[k])).join(",")).join("\n");
  return header + "\n" + body;
}
function downloadText(filename, text, mime="text/csv") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = filename;
  a.click();
}

////////////////////////////////////////////////////////////////////////////////
// Helper: start server clock element updating (selector)
////////////////////////////////////////////////////////////////////////////////
async function startServerClock(sel) {
  const el = document.querySelector(sel);
  if (!el) return;
  async function tick() {
    try {
      const t = await getServerTime();
      el.textContent = `Waktu server: ${fmtDateTime(t)} WIB`;
    } catch {
      el.textContent = `Waktu server: tidak tersedia`;
    }
  }
  await tick();
  setInterval(tick, 10_000);
}

////////////////////////////////////////////////////////////////////////////////
// Export public functions (if loaded as module, otherwise they are globals)
////////////////////////////////////////////////////////////////////////////////
window.PresensiFUPA = {
  // Auth/session
  auth, db, createSessionRecord, checkSessionValidity, refreshSession,

  // Profile
  saveProfile, getProfile,

  // Camera & upload
  captureToCanvas, canvasToCompressedBlob, uploadToCloudinary,

  // Presensi
  savePresensi, subscribeRiwayat, fetchPresensi, deletePresensi,

  // Cuti
  ajukanCuti, subscribeCutiAdmin, setCutiStatus,

  // Notifications
  subscribeNotifications, createNotification, markNotificationAsRead, deleteNotification,

  // Overrides & schedule
  setOverrideStatus, getScheduleOverride,

  // Announcements
  kirimPengumuman,

  // Admin helpers
  createKaryawanAccountByAdmin,

  // Utilities
  toCSV, downloadText, startServerClock
};

////////////////////////////////////////////////////////////////////////////////
// Auth state handling wiring (example usage inside each page should call these)
////////////////////////////////////////////////////////////////////////////////
/*
  Usage guidance for pages:

  index.html (login):
    - Bind login form to auth.signInWithEmailAndPassword
    - On success call createSessionRecord(user)
    - onAuthStateChanged in index should redirect based on users/{uid}.role (or ADMIN_UIDS, KARYAWAN_UIDS sets)

  karyawan.html:
    - On auth change, if auth.user exists and role is "karyawan" or in KARYAWAN_UIDS:
      * call bootstrapForUser(user)
      * call startServerClock("#serverTime")
      * call subscribeRiwayat(user.uid,...)
      * call subscribeNotifications(user.uid,...)
      * prepare camera via navigator.mediaDevices.getUserMedia and use captureToCanvas + canvasToCompressedBlob + uploadToCloudinary + savePresensi

  admin.html:
    - On auth change, if auth.user exists and role is "admin" or in ADMIN_UIDS:
      * call bootstrapForUser(user)
      * call startServerClock("#serverTime")
      * call subscribeCutiAdmin(...) to show pending cuti
      * call subscribeNotifications('admin', ...) to get admin-targeted notifications
      * use createKaryawanAccountByAdmin to create new karyawan accounts

  See earlier HTML pages I produced for full bindings. This app.js provides the functions those pages call.
*/

////////////////////////////////////////////////////////////////////////////////
// Optional: small auto-wiring example for simple pages that included elements
// (If your page includes elements with given IDs, this auto binds some actions.)
// If you don't want auto-binding, comment out the following block.
////////////////////////////////////////////////////////////////////////////////
(function autoWireIfPresent() {
  // Simple login binding if page has #loginBtn #email #password etc.
  const loginBtn = $("#loginBtn");
  if (loginBtn) {
    loginBtn.addEventListener("click", async () => {
      if (!$("#email") || !$("#password")) return;
      const email = $("#email").value.trim();
      const pass = $("#password").value;
      try {
        await logEvent("login_attempt", { email });
        const cred = await auth.signInWithEmailAndPassword(email, pass);
        await createSessionRecord(cred.user);
        await logEvent("login_success", { uid: cred.user.uid });
        // redirect will be handled by auth.onAuthStateChanged in your page script
      } catch (e) {
        await logEvent("login_failed", { email, error: e.code });
        toast("Login gagal: " + (e.message || e.code));
      }
    });
  }
})();

////////////////////////////////////////////////////////////////////////////////
// End of app.js
////////////////////////////////////////////////////////////////////////////////