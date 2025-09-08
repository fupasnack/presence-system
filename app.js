// app.js — seluruh logic digabung: Auth, Role Guard, Firestore, Cloudinary, UI, Notifikasi, PWA

// Firebase config (diperbarui sesuai data kunci)
const firebaseConfig = {
  apiKey: "AIzaSyA08VBr5PfN5HB7_eub0aZ9-_FSFFHM62M",
  authDomain: "presence-system-adfd7.firebaseapp.com",
  projectId: "presence-system-adfd7",
  storageBucket: "presence-system-adfd7.firebasestorage.app",
  messagingSenderId: "84815583677",
  appId: "1:84815583677:web:12e743b9f5c2b0cb395ad4",
  measurementId: "G-HHJREDRFZB"
};

// Cloudinary (diperbarui)
const CLOUD_NAME = "dn2o2vf04";
const UPLOAD_PRESET = "presensi_unsigned";

// UID roles (diperbarui sesuai data baru)
const ADMIN_UIDS = new Set([
  "DsBQ1TdWjgXvpVHUQJpF1H6jZzJ3", // karomi@fupa.id
  "xxySAjSMqKeq7SC6r5vyzes7USY2"  // annisa@fupa.id
]);
const KARYAWAN_UIDS = new Set([
  "y2MTtiGZcVcts2MkQncckAaUasm2", // x@fupa.id
  "4qwoQhWyZmatqkRYaENtz5Uw8fy1", // cabang1@fupa.id
  "UkIHdrTF6vefeuzp94ttlmxZzqk2", // cabang2@fupa.id
  "kTpmDbdBETQT7HIqT6TvpLwrbQf2", // cabang3@fupa.id
  "15FESE0b7cQFKqdJSqNBTZlHqWR2", // cabang4@fupa.id
  "1tQidUDFTjRTJdJJYIudw9928pa2", // cabang5@fupa.id
  "7BCcTwQ5wDaxWA6xbzJX9VWj1o52", // cabang6@fupa.id
  "mpyFesOjUIcs8O8Sh3tVLS8x7dA3", // cabang7@fupa.id
  "2jV2is3MQRhv7nnd1gXeqiaj11t2", // cabang8@fupa.id
  "or2AQDVY1hdpwT0YOmL4qJrgCju1", // cabang9@fupa.id
  "HNJ52lywYVaUhRK3BNEARfQsQo22"  // cabang10@fupa.id
]);

// Inisialisasi Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Util UI
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const toast = (msg) => {
  const t = $("#toast");
  if (!t) return alert(msg);
  t.textContent = msg;
  t.style.display = "block";
  setTimeout(() => { t.style.display = "none"; }, 2200);
};

// PWA register SW
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js");
  });
}

// Notifikasi browser (tanpa FCM, pakai Notification API murni)
async function ensureNotificationPermission() {
  try {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission !== "denied") {
      const res = await Notification.requestPermission();
      return res === "granted";
    }
    return false;
  } catch { return false; }
}
function notify(msg) {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") new Notification("Presensi FUPA", { body: msg });
}

// Dapatkan server time via Firestore serverTimestamp comparator
async function getServerTime() {
  const docRef = db.collection("_meta").doc("_srv");
  await docRef.set({ t: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
  const snap = await docRef.get();
  const ts = snap.get("t");
  return ts ? ts.toDate() : new Date(); // fallback
}
function fmtDateTime(d) {
  const pad = (n) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtHM(d) {
  const pad = (n) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function sameYMD(a,b){
  return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}

// Aturan hari & jam
// - Minggu default non-presensi kecuali dipaksa admin
// - Berangkat: 04:30–05:30
// - Pulang: 10:00–11:00
// - Toleransi terlambat: 30 menit setelah awal window -> status "terlambat" jika upload di <= akhir window + 30
const WINDOW = {
  berangkat: { start: {h:4,m:30}, end:{h:5,m:30} },
  pulang:    { start: {h:10,m:0}, end:{h:11,m:0} }
};
function inWindow(d, jenis, extraLateMin=30) {
  const w = WINDOW[jenis];
  const start = new Date(d); start.setHours(w.start.h, w.start.m, 0, 0);
  const end = new Date(d);   end.setHours(w.end.h,   w.end.m,   0, 0);
  const lateEnd = new Date(end.getTime() + extraLateMin*60000);
  if (d < start) return {allowed:false, status:"dilarang"};
  if (d >= start && d <= end) return {allowed:true, status:"tepat"};
  if (d > end && d <= lateEnd) return {allowed:true, status:"terlambat"};
  return {allowed:false, status:"dilarang"};
}

async function getScheduleOverride(dateYMD) {
  // admin menulis ke _settings/today: { mode: "auto"|"forceOn"|"forceOff", date: "YYYY-MM-DD" }
  const doc = await db.collection("_settings").doc("today").get();
  if (doc.exists) {
    const d = doc.data();
    if (d.date === dateYMD) return d.mode; // mode khusus untuk hari ini
  }
  return "auto";
}

function ymd(d){
  const pad = (n) => n.toString().padStart(2,"0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

// Role guard - DIPERBAIKI: Sekarang menggunakan data dari Firestore, bukan hanya UID
function redirectByRole(uid, userData, pathIfAdmin, pathIfKaryawan) {
  console.log("Redirect by role:", { uid, userData });
  
  // Cek dari Firestore data pertama
  if (userData && userData.role === "admin") {
    console.log("Redirecting to admin page");
    if (!location.pathname.endsWith(pathIfAdmin)) location.href = pathIfAdmin;
    return;
  }
  
  // Cek dari UID sebagai fallback
  if (ADMIN_UIDS.has(uid)) {
    console.log("Redirecting to admin page (UID fallback)");
    if (!location.pathname.endsWith(pathIfAdmin)) location.href = pathIfAdmin;
  } else if (KARYAWAN_UIDS.has(uid)) {
    console.log("Redirecting to karyawan page (UID fallback)");
    if (!location.pathname.endsWith(pathIfKaryawan)) location.href = pathIfKaryawan;
  } else {
    console.log("Access denied: no valid role");
    auth.signOut();
    toast("Akses ditolak: akun belum diberi peran yang benar.");
  }
}

function guardPage(uid, userData, required) {
  console.log("Guard page check:", { uid, userData, required });
  
  // Cek dari Firestore data pertama
  if (userData) {
    if (required === "admin" && userData.role === "admin") return true;
    if (required === "karyawan" && userData.role === "karyawan") return true;
  }
  
  // Cek dari UID sebagai fallback
  const isAdmin = ADMIN_UIDS.has(uid);
  const isKaryawan = KARYAWAN_UIDS.has(uid);
  
  if (required === "admin" && !isAdmin) { 
    console.log("Access denied: not admin");
    location.href = "index.html"; 
    return false; 
  }
  if (required === "karyawan" && !isKaryawan) { 
    console.log("Access denied: not karyawan");
    location.href = "index.html"; 
    return false; 
  }
  
  return true;
}

// Auto bootstrap koleksi & dokumen penting tanpa setup manual
async function bootstrapCollections(user) {
  console.log("Bootstrapping collections for user:", user.uid);
  
  // users profile doc
  const up = db.collection("users").doc(user.uid);
  const userDoc = await up.get();
  
  // Jika user belum ada di Firestore, buat dokumen baru
  if (!userDoc.exists) {
    console.log("Creating new user document");
    const userRole = ADMIN_UIDS.has(user.uid) ? "admin" : (KARYAWAN_UIDS.has(user.uid) ? "karyawan" : "unknown");
    
    await up.set({
      email: user.email || "",
      role: userRole,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      lastLogin: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    
    return { role: userRole };
  } else {
    // Update last login
    console.log("Updating last login for existing user");
    await up.set({
      lastLogin: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    
    return userDoc.data();
  }
}

// Auth routing untuk semua halaman - DIPERBAIKI: Sekarang menggunakan data user dari Firestore
auth.onAuthStateChanged(async (user) => {
  console.log("Auth state changed:", user);
  const path = location.pathname.toLowerCase();
  
  if (!user) {
    console.log("No user signed in");
    // Cegah akses langsung
    if (path.endsWith("karyawan.html") || path.endsWith("admin.html")) {
      location.href = "index.html";
    }
    // halaman login tidak butuh apa-apa
    if (path.endsWith("index.html") || path.endsWith("/")) {
      bindLoginPage();
    }
    return;
  }

  try {
    console.log("User signed in:", user.uid);
    const userData = await bootstrapCollections(user);
    
    console.log("User data from Firestore:", userData);

    // Update server time live
    startServerClock("#serverTime");

    // Routing per halaman
    if (path.endsWith("index.html") || path.endsWith("/")) {
      // Setelah login, arahkan sesuai role
      console.log("Redirecting from login page");
      redirectByRole(user.uid, userData, "admin.html", "karyawan.html");
      return;
    }

    if (path.endsWith("karyawan.html")) {
      console.log("Loading karyawan page");
      if (!guardPage(user.uid, userData, "karyawan")) return;
      await ensureNotificationPermission();
      bindKaryawanPage(user, userData);
    }

    if (path.endsWith("admin.html")) {
      console.log("Loading admin page");
      if (!guardPage(user.uid, userData, "admin")) return;
      await ensureNotificationPermission();
      bindAdminPage(user, userData);
    }
  } catch (error) {
    console.error("Error in auth state change:", error);
    toast("Error memuat data pengguna. Silakan coba lagi.");
  }
});

// Halaman login - DIPERBAIKI: Menangani error dengan lebih baik
function bindLoginPage() {
  const loginBtn = $("#loginBtn");
  if (!loginBtn) return;
  
  loginBtn.onclick = async () => {
    const email = $("#email").value.trim();
    const pass = $("#password").value.trim();
    
    if (!email || !pass) { 
      toast("Isi email dan kata sandi."); 
      return; 
    }
    
    // Tampilkan loading
    const loadingEl = $("#loading");
    if (loadingEl) loadingEl.style.display = "flex";
    
    try {
      await auth.signInWithEmailAndPassword(email, pass);
      // onAuthStateChanged akan redirect by role
    } catch (e) {
      if (loadingEl) loadingEl.style.display = "none";
      console.error("Login error:", e);
      
      if (e.code === "auth/user-not-found") {
        toast("Email tidak terdaftar.");
      } else if (e.code === "auth/wrong-password") {
        toast("Kata sandi salah.");
      } else if (e.code === "auth/invalid-email") {
        toast("Format email tidak valid.");
      } else {
        toast("Gagal masuk. Periksa kembali kredensial.");
      }
    }
  };
}

// Jam server live
async function startServerClock(sel) {
  const el = $(sel);
  if (!el) return;
  const tick = async () => {
    try {
      const t = await getServerTime();
      el.textContent = `Waktu server: ${fmtDateTime(t)} WIB`;
    } catch {
      el.textContent = `Waktu server: tidak tersedia`;
    }
  };
  await tick();
  setInterval(tick, 10_000);
}

// Ambil lokasi
function getLocation(timeout=8000) {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error("Geolokasi tidak didukung."));
    navigator.geolocation.getCurrentPosition(
      (pos) => res({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => rej(err),
      { enableHighAccuracy:true, timeout, maximumAge: 2_000 }
    );
  });
}

// Kamera
async function startCamera(videoEl) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    videoEl.srcObject = stream;
    await videoEl.play();
    return stream;
  } catch (e) {
    toast("Tidak bisa mengakses kamera.");
    throw e;
  }
}
function captureToCanvas(videoEl, canvasEl) {
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  const MAXW = 720; // kurangi ukuran
  const scale = Math.min(1, MAXW / w);
  canvasEl.width = Math.round(w * scale);
  canvasEl.height = Math.round(h * scale);
  const ctx = canvasEl.getContext("2d");
  ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
}

// Kompres gambar ke kualitas kecil (target ≤30 KB) dan hapus metadata EXIF
async function canvasToCompressedBlob(canvas, targetKB=30) {
  let quality = 0.6;
  let blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", quality));
  
  // Turunkan kualitas hingga ukuran ≤ targetKB
  for (let i = 0; i < 5 && blob.size / 1024 > targetKB; i++) {
    quality = Math.max(0.3, quality - 0.1);
    blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", quality));
  }
  
  // Jika masih besar, kurangi resolusi
  if (blob.size / 1024 > targetKB) {
    const scale = Math.sqrt(targetKB * 1024 / blob.size);
    const newWidth = Math.max(320, Math.round(canvas.width * scale));
    const newHeight = Math.max(240, Math.round(canvas.height * scale));
    
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = newWidth;
    tempCanvas.height = newHeight;
    const ctx = tempCanvas.getContext("2d");
    ctx.drawImage(canvas, 0, 0, newWidth, newHeight);
    
    blob = await new Promise(r => tempCanvas.toBlob(r, "image/jpeg", 0.7));
  }
  
  // Hapus metadata EXIF dengan menggambar ulang
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  await new Promise(resolve => img.onload = resolve);
  
  const cleanCanvas = document.createElement("canvas");
  cleanCanvas.width = img.width;
  cleanCanvas.height = img.height;
  const ctx = cleanCanvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  
  return await new Promise(r => cleanCanvas.toBlob(r, "image/jpeg", quality));
}

// Upload ke Cloudinary unsigned
async function uploadToCloudinary(file) {
  const url = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/upload`;
  const form = new FormData();
  form.append("file", file);
  form.append("upload_preset", UPLOAD_PRESET);
  const r = await fetch(url, { method:"POST", body: form });
  if (!r.ok) throw new Error("Upload Cloudinary gagal");
  const data = await r.json();
  return data.secure_url;
}

// Simpan presensi
async function savePresensi({ uid, nama, jenis, status, lat, lng, selfieUrl, serverDate }) {
  const ts = serverDate || new Date();
  const doc = {
    uid, nama: nama || "", jenis, status,
    lat, lng,
    selfieUrl: selfieUrl || "",
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    localTime: fmtDateTime(ts),
    ymd: ymd(ts)
  };
  await db.collection("presensi").add(doc);
}

// Ambil riwayat singkat karyawan
function subscribeRiwayat(uid, cb) {
  return db.collection("presensi")
    .where("uid", "==", uid)
    .orderBy("createdAt", "desc")
    .limit(10)
    .onSnapshot(snap => {
      const arr = [];
      snap.forEach(d => arr.push({ id:d.id, ...d.data() }));
      cb(arr);
    });
}

// Notifikasi system baru
function subscribeNotifications(uid, cb) {
  return db.collection("notifications")
    .where("userId", "in", [uid, "all"])
    .orderBy("createdAt", "desc")
    .limit(20)
    .onSnapshot(snap => {
      const arr = [];
      snap.forEach(d => arr.push({ id:d.id, ...d.data() }));
      cb(arr);
    });
}

// Hapus notifikasi
async function deleteNotification(id) {
  await db.collection("notifications").doc(id).delete();
}

// Tandai notifikasi sebagai sudah dibaca
async function markNotificationAsRead(id) {
  await db.collection("notifications").doc(id).update({
    read: true
  });
}

// Cuti collection
async function ajukanCuti(uid, nama, jenis, tanggal, catatan) {
  const cutiRef = await db.collection("cuti").add({
    uid, nama, jenis, tanggal, catatan: catatan || "",
    status: "menunggu",
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  
  // Kirim notifikasi ke admin
  await db.collection("notifications").add({
    userId: "admin",
    type: "cuti",
    title: "Permintaan Cuti Baru",
    message: `${nama} mengajukan cuti pada ${tanggal} (${jenis})`,
    data: { cutiId: cutiRef.id, uid, nama, jenis, tanggal, catatan },
    read: false,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

// Admin list cuti
function subscribeCuti(cb) {
  return db.collection("cuti")
    .where("status", "==", "menunggu") // Hanya tampilkan yang statusnya menunggu
    .orderBy("createdAt", "desc")
    .limit(50)
    .onSnapshot(snap => {
      const arr = [];
      snap.forEach(d => arr.push({ id:d.id, ...d.data() }));
      cb(arr);
    });
}

async function setCutiStatus(id, status, adminUid) {
  const cutiDoc = await db.collection("cuti").doc(id).get();
  const cutiData = cutiDoc.data();
  
  await db.collection("cuti").doc(id).set({ status }, { merge:true });
  
  // Buat presensi otomatis jika cuti disetujui
  if (status === "disetujui") {
    await db.collection("presensi").add({
      uid: cutiData.uid,
      nama: cutiData.nama,
      jenis: cutiData.jenis,
      status: cutiData.jenis,
      lat: null,
      lng: null,
      selfieUrl: "",
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      localTime: fmtDateTime(new Date(cutiData.tanggal)),
      ymd: cutiData.tanggal,
      isCuti: true
    });
  }
  
  // Kirim notifikasi ke karyawan
  await db.collection("notifications").add({
    userId: cutiData.uid,
    type: "cuti",
    title: "Status Cuti",
    message: `Cuti Anda pada ${cutiData.tanggal} telah ${status}`,
    data: { cutiId: id, status },
    read: false,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

// Pengumuman
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
}

// Override status presensi
async function setOverrideStatus(date, status, adminUid) {
  await db.collection("overrides").doc(date).set({
    status,
    createdBy: adminUid,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  
  // Kirim notifikasi ke semua karyawan
  await db.collection("notifications").add({
    userId: "all",
    type: "override",
    title: "Override Status Presensi",
    message: `Admin telah mengoverride status presensi pada ${date} menjadi ${status}`,
    data: { date, status, adminUid },
    read: false,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

// Jadwal wajib
async function setHariMode(mode, dateStr) {
  await db.collection("_settings").doc("today").set({
    mode, date: dateStr
  }, { merge: true });
}

// Profil simpan (nama, alamat, foto profil -> Cloudinary)
async function saveProfile(uid, { nama, alamat, pfpUrl }) {
  const d = {};
  if (nama !== undefined) d.nama = nama;
  if (alamat !== undefined) d.alamat = alamat;
  if (pfpUrl !== undefined) d.pfp = pfpUrl;
  d.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
  await db.collection("users").doc(uid).set(d, { merge: true });
}

// Ambil profil
async function getProfile(uid) {
  const snap = await db.collection("users").doc(uid).get();
  return snap.exists ? snap.data() : {};
}

// Hapus presensi
async function deletePresensi(id) {
  await db.collection("presensi").doc(id).delete();
}

// Halaman Karyawan bindings - DIPERBAIKI: Menerima parameter userData
async function bindKaryawanPage(user, userData) {
  const video = $("#cam");
  const canvas = $("#canvas");
  const preview = $("#preview");
  const jenisSel = $("#jenis");
  const statusText = $("#statusText");
  const statusChip = $("#statusChip");
  const locText = $("#locText");

  // Tampilkan loading
  const loadingEl = $("#loading");
  if (loadingEl) loadingEl.style.display = "flex";

  // Guard kamera
  let stream;
  try {
    stream = await startCamera(video);
  } catch (e) {
    if (loadingEl) loadingEl.style.display = "none";
    return;
  }

  // Lokasi
  let coords = null;
  try {
    coords = await getLocation();
    locText.textContent = `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`;
  } catch {
    locText.textContent = "Lokasi tidak aktif";
  }

  // Profil muat
  const profile = await getProfile(user.uid);
  if (profile.pfp) $("#pfp").src = profile.pfp;
  if (profile.nama) $("#nama").value = profile.nama;
  if (profile.alamat) $("#alamat").value = profile.alamat;

  // Status window
  async function refreshStatus() {
    const serverNow = await getServerTime();
    const today = ymd(serverNow);
    const override = await getScheduleOverride(today);
    const isSunday = serverNow.getDay() === 0;
    const jenis = jenisSel.value;

    let wajib = true;
    if (override === "forceOn") wajib = true;
    else if (override === "forceOff") wajib = false;
    else wajib = !isSunday;

    if (!wajib) {
      statusText.textContent = "Hari ini tidak wajib presensi";
      statusChip.className = "status s-warn";
      return { allowed: false, reason:"not-required" };
    }

    const win = inWindow(serverNow, jenis, 30);
    if (!win.allowed) {
      statusText.textContent = "Di luar jam presensi";
      statusChip.className = "status s-bad";
      return { allowed:false, reason:"out-of-window" };
    } else {
      statusText.textContent = win.status === "tepat" ? "Tepat waktu" : "Terlambat";
      statusChip.className = "status " + (win.status === "tepat" ? "s-good" : "s-warn");
      return { allowed:true, status:win.status, serverNow };
    }
  }
  let lastStatus = await refreshStatus();
  setInterval(async () => { lastStatus = await refreshStatus(); }, 30_000);

  // Snap
  $("#snapBtn").onclick = () => {
    captureToCanvas(video, canvas);
    canvas.style.display = "block";
    preview.style.display = "none";
    toast("Foto diambil. Anda bisa langsung upload.");
  };

  // Upload
  $("#uploadBtn").onclick = async () => {
    // Periksa status window lagi
    lastStatus = await refreshStatus();
    if (!lastStatus.allowed) {
      toast("Presensi ditolak: di luar jadwal atau tidak wajib.");
      return;
    }
    if (!coords) {
      toast("Lokasi belum aktif.");
      return;
    }
    // Pastikan ada gambar di canvas
    if (canvas.width === 0 || canvas.height === 0) {
      toast("Ambil selfie dulu.");
      return;
    }
    
    // Tampilkan loading
    if (loadingEl) loadingEl.style.display = "flex";
    
    try {
      const blob = await canvasToCompressedBlob(canvas, 30); // Kompres ke ≤30 KB
      const url = await uploadToCloudinary(blob);
      preview.src = url;
      preview.style.display = "block";
      // Simpan presensi
      const nama = ($("#nama")?.value || profile.nama || user.email.split("@")[0]).trim();
      const jenis = jenisSel.value;
      const status = lastStatus.status === "tepat" ? "tepat" : "terlambat";
      await savePresensi({
        uid: user.uid,
        nama,
        jenis,
        status,
        lat: coords.lat,
        lng: coords.lng,
        selfieUrl: url,
        serverDate: lastStatus.serverNow
      });
      toast("Presensi tersimpan.");
    } catch (e) {
      toast("Gagal menyimpan presensi.");
    } finally {
      if (loadingEl) loadingEl.style.display = "none";
    }
  };

  // Riwayat singkat
  const unsubLog = subscribeRiwayat(user.uid, (items) => {
    const list = $("#logList");
    list.innerHTML = "";
    items.forEach(it => {
      const badge = it.status === "tepat" ? "s-good" : (it.status==="terlambat"?"s-warn":"s-bad");
      const el = document.createElement("div");
      el.className = "row";
      el.style.justifyContent = "space-between";
      el.innerHTML = `
        <div class="row" style="gap:8px">
          <span class="material-symbols-rounded">schedule</span>
          <b>${it.localTime || 'Waktu tidak tersedia'}</b>
          <span>•</span>
          <span>${it.jenis}</span>
        </div>
        <span class="status ${badge}">${it.status}</span>
      `;
      list.appendChild(el);
    });
  });

  // Notifikasi dialog
  $("#notifBtn").onclick = () => $("#notifDlg").showModal();
  const unsubNotif = subscribeNotifications(user.uid, (items) => {
    const list = $("#notifList");
    list.innerHTML = "";
    
    // Update badge notifikasi
    const unreadCount = items.filter(item => !item.read).length;
    const badge = $("#notifBadge");
    if (unreadCount > 0) {
      badge.textContent = unreadCount;
      badge.style.display = "grid";
    } else {
      badge.style.display = "none";
    }
    
    items.forEach(it => {
      const el = document.createElement("div");
      el.className = "card";
      el.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="font-weight:700">${it.title}</div>
          <button class="icon-btn" style="background:transparent; color:var(--bad);" data-id="${it.id}">
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>
        <div style="opacity:.8; margin-top:4px">${it.message || "(tanpa teks)"}</div>
        <div style="font-size:12px; opacity:.6; margin-top:6px">${it.createdAt ? it.createdAt.toDate().toLocaleString() : ""}</div>
      `;
      
      // Bind hapus notifikasi
      const deleteBtn = el.querySelector("button");
      deleteBtn.onclick = async () => {
        await deleteNotification(it.id);
        toast("Notifikasi dihapus");
      };
      
      list.appendChild(el);
    });
  });

  // Cuti FAB
  $("#cutiFab").onclick = () => $("#cutiDlg").showModal();
  $("#ajukanCutiBtn").onclick = async () => {
    const jenis = $("#cutiJenis").value;
    const tanggal = $("#cutiTanggal").value;
    const catatan = $("#cutiCatatan").value.trim();
    if (!tanggal) { toast("Pilih tanggal cuti."); return; }
    
    // Tampilkan loading
    if (loadingEl) loadingEl.style.display = "flex";
    
    try {
      const nama = ($("#nama")?.value || profile.nama || user.email.split("@")[0]).trim();
      await ajukanCuti(user.uid, nama, jenis, tanggal, catatan);
      toast("Permintaan cuti dikirim.");
      $("#cutiDlg").close();
    } catch (e) {
      toast("Gagal mengajukan cuti.");
    } finally {
      if (loadingEl) loadingEl.style.display = "none";
    }
  };

  // Profil dialog
  $("#profileBtn").onclick = () => $("#profileDlg").showModal();
  $("#saveProfileBtn").onclick = async () => {
    // Tampilkan loading
    if (loadingEl) loadingEl.style.display = "flex";
    
    try {
      let pfpUrl;
      const file = $("#pfpFile").files?.[0];
      if (file) {
        // Kompres foto profil ke ≤30 KB
        const imgEl = document.createElement("img");
        imgEl.src = URL.createObjectURL(file);
        await new Promise(r => imgEl.onload = r);
        const c = document.createElement("canvas");
        const scale = Math.min(1, 512 / Math.max(imgEl.width, imgEl.height));
        c.width = Math.max(64, Math.round(imgEl.width * scale));
        c.height = Math.max(64, Math.round(imgEl.height * scale));
        const ctx = c.getContext("2d");
        ctx.drawImage(imgEl, 0, 0, c.width, c.height);
        const pfpBlob = await canvasToCompressedBlob(c, 30); // Kompres ke ≤30 KB
        pfpUrl = await uploadToCloudinary(pfpBlob);
        $("#pfp").src = pfpUrl;
      }
      const nama = $("#nama").value.trim();
      const alamat = $("#alamat").value.trim();
      await saveProfile(user.uid, { nama, alamat, pfpUrl });
      toast("Profil tersimpan.");
    } catch {
      toast("Gagal menyimpan profil.");
    } finally {
      if (loadingEl) loadingEl.style.display = "none";
    }
  };
  $("#logoutBtn").onclick = async () => { 
    // Tampilkan loading
    if (loadingEl) loadingEl.style.display = "flex";
    await auth.signOut(); 
    location.href = "index.html"; 
  };

  // Sembunyikan loading setelah semua selesai
  if (loadingEl) loadingEl.style.display = "none";

  // Bersihkan stream saat keluar
  window.addEventListener("beforeunload", () => {
    try { stream.getTracks().forEach(t => t.stop()); } catch {}
    unsubLog && unsubLog();
    unsubNotif && unsubNotif();
  });
}

// Halaman Admin bindings - DIPERBAIKI: Menerima parameter userData
async function bindAdminPage(user, userData) {
  // Profil muat
  const profile = await getProfile(user.uid);
  if (profile.pfp) $("#pfp").src = profile.pfp;
  if (profile.nama) $("#nama").value = profile.nama;
  if (profile.alamat) $("#alamat").value = profile.alamat;

  // Dialogs
  $("#profileBtn").onclick = () => $("#profileDlg").showModal();
  $("#logoutBtn").onclick = async () => { 
    const loadingEl = $("#loading");
    if (loadingEl) loadingEl.style.display = "flex";
    await auth.signOut(); 
    location.href="index.html"; 
  };

  // Simpan profil
  $("#saveProfileBtn").onclick = async () => {
    const loadingEl = $("#loading");
    if (loadingEl) loadingEl.style.display = "flex";
    
    try {
      let pfpUrl;
      const file = $("#pfpFile").files?.[0];
      if (file) {
        // Kompres foto profil ke ≤30 KB
        const imgEl = document.createElement("img");
        imgEl.src = URL.createObjectURL(file);
        await new Promise(r => imgEl.onload = r);
        const c = document.createElement("canvas");
        const scale = Math.min(1, 512 / Math.max(imgEl.width, imgEl.height));
        c.width = Math.max(64, Math.round(imgEl.width * scale));
        c.height = Math.max(64, Math.round(imgEl.height * scale));
        const ctx = c.getContext("2d");
        ctx.drawImage(imgEl, 0, 0, c.width, c.height);
        const blob = await canvasToCompressedBlob(c, 30); // Kompres ke ≤30 KB
        pfpUrl = await uploadToCloudinary(blob);
        $("#pfp").src = pfpUrl;
      }
      const nama = $("#nama").value.trim();
      const alamat = $("#alamat").value.trim();
      await saveProfile(user.uid, { nama, alamat, pfpUrl });
      toast("Profil admin tersimpan.");
    } catch {
      toast("Gagal menyimpan profil admin.");
    } finally {
      const loadingEl = $("#loading");
      if (loadingEl) loadingEl.style.display = "none";
    }
  };

  // Notifikasi (cuti)
  $("#notifBtn").onclick = () => $("#notifDlg").showModal();
  const cutiList = $("#cutiList");
  const unsubCuti = subscribeCuti((items) => {
    cutiList.innerHTML = "";
    
    // Update badge notifikasi
    const badge = $("#notifBadge");
    if (items.length > 0) {
      badge.textContent = items.length;
      badge.style.display = "grid";
    } else {
      badge.style.display = "none";
    }
    
    items.forEach(it => {
      const row = document.createElement("div");
      row.className = "card";
      row.innerHTML = `
        <div class="row" style="justify-content:space-between">
          <div class="row">
            <span class="material-symbols-rounded">person</span><b>${it.nama || it.uid}</b>
            <span>•</span>
            <span>${it.jenis}</span>
            <span>•</span>
            <span>${it.tanggal}</span>
          </div>
          <div class="row">
            <span class="status ${it.status==='menunggu'?'s-warn':(it.status==='disetujui'?'s-good':'s-bad')}">${it.status}</span>
          </div>
        </div>
        <div class="row" style="justify-content:flex-end; margin-top:8px">
          <button class="btn" data-act="approve" data-id="${it.id}"><span class="material-symbols-rounded">check</span> Setujui</button>
          <button class="btn" data-act="reject" data-id="${it.id}" style="background:#222"><span class="material-symbols-rounded">close</span> Tolak</button>
        </div>
      `;
      cutiList.appendChild(row);
    });
    // Bind actions
    $$("[data-act='approve']").forEach(b => b.onclick = async () => {
      const loadingEl = $("#loading");
      if (loadingEl) loadingEl.style.display = "flex";
      await setCutiStatus(b.dataset.id, "disetujui", user.uid);
      if (loadingEl) loadingEl.style.display = "none";
      toast("Cuti disetujui.");
    });
    $$("[data-act='reject']").forEach(b => b.onclick = async () => {
      const loadingEl = $("#loading");
      if (loadingEl) loadingEl.style.display = "flex";
      await setCutiStatus(b.dataset.id, "ditolak", user.uid);
      if (loadingEl) loadingEl.style.display = "none";
      toast("Cuti ditolak.");
    });
  });

  // Pengumuman
  $("#announceFab").onclick = async () => {
    const text = prompt("Tulis pengumuman:");
    if (!text) return;
    
    const loadingEl = $("#loading");
    if (loadingEl) loadingEl.style.display = "flex";
    await kirimPengumuman(text, user.uid);
    if (loadingEl) loadingEl.style.display = "none";
    toast("Pengumuman terkirim.");
  };
  
  $("#sendAnnounce").onclick = async () => {
    const text = $("#announceText").value.trim();
    if (!text) { toast("Tulis isi pengumuman."); return; }
    
    const loadingEl = $("#loading");
    if (loadingEl) loadingEl.style.display = "flex";
    await kirimPengumuman(text, user.uid);
    $("#announceText").value = "";
    if (loadingEl) loadingEl.style.display = "none";
    toast("Pengumuman terkirim.");
  };

  // Jadwal wajib / tidak
  $("#saveSchedule").onclick = async () => {
    const mode = $("#wajibHari").value;
    const now = await getServerTime();
    
    const loadingEl = $("#loading");
    if (loadingEl) loadingEl.style.display = "flex";
    await setHariMode(mode, ymd(now));
    if (loadingEl) loadingEl.style.display = "none";
    toast("Pengaturan hari tersimpan.");
  };

  // Tabel presensi + filter + export CSV
  let lastData = [];
  let currentPage = 1;
  const pageSize = 20;
  
  async function loadPresensi() {
    const loadingEl = $("#loading");
    if (loadingEl) loadingEl.style.display = "flex";
    
    let q = db.collection("presensi").orderBy("createdAt", "desc");
    const nama = $("#fNama").value.trim().toLowerCase();
    const tanggal = $("#fTanggal").value;
    const periode = $("#fPeriode").value;
    
    // Filter berdasarkan periode
    if (periode && periode !== "semua") {
      const now = new Date();
      let startDate = new Date();
      
      switch(periode) {
        case "hari":
          startDate.setHours(0,0,0,0);
          break;
        case "minggu":
          startDate.setDate(now.getDate() - 7);
          break;
        case "bulan":
          startDate.setMonth(now.getMonth() - 1);
          break;
        case "tahun":
          startDate.setFullYear(now.getFullYear() - 1);
          break;
      }
      
      q = q.where("createdAt", ">=", startDate);
    }
    
    // Firestore tidak bisa compound query yang fleksibel untuk text, maka filter di klien setelah pengambilan
    const snap = await q.get();
    const arr = [];
    snap.forEach(d => arr.push({ id:d.id, ...d.data() }));
    let filtered = arr;
    if (tanggal) filtered = filtered.filter(x => x.ymd === tanggal);
    if (nama) filtered = filtered.filter(x => (x.nama||"").toLowerCase().includes(nama));
    lastData = filtered;
    
    renderPagination(filtered.length);
    renderTable(filtered, currentPage);
    
    if (loadingEl) loadingEl.style.display = "none";
  }
  
  function renderPagination(totalItems) {
    const totalPages = Math.ceil(totalItems / pageSize);
    const pagination = $("#pagination");
    pagination.innerHTML = "";
    
    if (totalPages <= 1) return;
    
    for (let i = 1; i <= totalPages; i++) {
      const btn = document.createElement("button");
      btn.textContent = i;
      btn.classList.toggle("active", i === currentPage);
      btn.onclick = () => {
        currentPage = i;
        renderTable(lastData, currentPage);
      };
      pagination.appendChild(btn);
    }
  }
  
  function renderTable(data, page) {
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const pageData = data.slice(startIndex, endIndex);
    
    const tb = $("#tableBody");
    tb.innerHTML = "";
    pageData.forEach(r => {
      const badge = r.status === "tepat" ? "s-good" : (r.status==="terlambat"?"s-warn":"s-bad");
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.localTime || ""}</td>
        <td>${r.nama || r.uid}</td>
        <td>${r.jenis}</td>
        <td><span class="status ${badge}">${r.status}</span></td>
        <td>${(r.lat?.toFixed?.(5) || r.lat || "")}, ${(r.lng?.toFixed?.(5) || r.lng || "")}</td>
        <td>${r.selfieUrl ? `<a href="${r.selfieUrl}" target="_blank">Lihat</a>` : "-"}</td>
        <td><button class="btn" style="background:var(--bad); padding:6px 10px; font-size:12px;" onclick="deletePresensi('${r.id}')">Hapus</button></td>
      `;
      tb.appendChild(tr);
    });
  }
  
  // Bind fungsi deletePresensi ke window agar bisa diakses dari onclick
  window.deletePresensi = async (id) => {
    if (confirm("Hapus data presensi ini?")) {
      const loadingEl = $("#loading");
      if (loadingEl) loadingEl.style.display = "flex";
      await deletePresensi(id);
      if (loadingEl) loadingEl.style.display = "none";
      toast("Presensi dihapus");
      loadPresensi(); // Reload data
    }
  };
  
  $("#applyFilter").onclick = () => {
    currentPage = 1;
    loadPresensi();
  };
  
  $("#exportCsv").onclick = () => {
    if (!lastData.length) { toast("Tidak ada data untuk diekspor."); return; }
    const cols = ["localTime","nama","jenis","status","lat","lng","selfieUrl","uid","ymd"];
    const csv = toCSV(lastData, cols);
    download(`presensi_${Date.now()}.csv`, csv);
  };
  
  // Tambahkan select filter periode di HTML admin
  const filterContainer = $(".row:has(#fNama)");
  if (filterContainer && !$("#fPeriode")) {
    const periodeSelect = document.createElement("select");
    periodeSelect.id = "fPeriode";
    periodeSelect.innerHTML = `
      <option value="semua">Semua Periode</option>
      <option value="hari">Hari Ini</option>
      <option value="minggu">Minggu Ini</option>
      <option value="bulan">Bulan Ini</option>
      <option value="tahun">Tahun Ini</option>
    `;
    filterContainer.insertBefore(periodeSelect, $("#applyFilter"));
  }
  
  // Muat awal + refresh periodik ringan
  await loadPresensi();
  setInterval(loadPresensi, 20_000);

  // Create akun karyawan (tanpa logout admin)
  // Trik: buat second app instance untuk createUser supaya sesi admin tetap
  const secondApp = firebase.apps.length > 1 ? firebase.apps[1] : firebase.initializeApp(firebaseConfig, "second");
  const secondAuth = secondApp.auth();

  // Dialog konfirmasi UID
  const confirmUidDlg = document.createElement("dialog");
  confirmUidDlg.id = "confirmUidDlg";
  confirmUidDlg.innerHTML = `
    <div class="dlg-head">
      <div class="row"><span class="material-symbols-rounded">person_add</span><b>Konfirmasi UID</b></div>
      <button class="icon-btn" onclick="document.getElementById('confirmUidDlg').close()"><span class="material-symbols-rounded">close</span></button>
    </div>
    <div class="dlg-body">
      <p>Akun berhasil dibuat! Salin UID berikut dan tambahkan ke constant KARYAWAN_UIDS di app.js:</p>
      <div class="input" style="margin:10px 0">
        <input id="newUid" type="text" readonly />
        <button class="btn" onclick="copyUid()">Salin</button>
      </div>
      <button class="btn" onclick="document.getElementById('confirmUidDlg').close()">Selesai</button>
    </div>
  `;
  document.body.appendChild(confirmUidDlg);
  
  function copyUid() {
    const uidInput = $("#newUid");
    uidInput.select();
    document.execCommand("copy");
    toast("UID disalin ke clipboard");
  }

  $("#createUserBtn").onclick = async () => {
    const email = $("#newEmail").value.trim();
    const pass = $("#newPass").value.trim();
    if (!email || !pass) { toast("Isi email dan kata sandi."); return; }
    
    const loadingEl = $("#loading");
    if (loadingEl) loadingEl.style.display = "flex";
    
    try {
      const cred = await secondAuth.createUserWithEmailAndPassword(email, pass);
      const uid = cred.user.uid;
      await db.collection("users").doc(uid).set({
        email, role:"karyawan", createdBy: user.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge:true });
      
      // Tampilkan dialog konfirmasi UID
      $("#newUid").value = uid;
      $("#confirmUidDlg").showModal();
      
      // Kembalikan secondAuth ke kosong signOut agar tidak mengganggu
      await secondAuth.signOut();
    } catch (e) {
      toast("Gagal membuat akun karyawan.");
    } finally {
      if (loadingEl) loadingEl.style.display = "none";
    }
  };

  // Bersih
  window.addEventListener("beforeunload", () => {
    unsubCuti && unsubCuti();
  });
}

// Fungsi utilitas untuk CSV dan download
function toCSV(rows, columns) {
  const esc = (v) => `"${(v ?? "").toString().replace(/"/g,'""')}"`;
  const header = columns.map(esc).join(",");
  const body = rows.map(r => columns.map(k => esc(r[k])).join(",")).join("\n");
  return header + "\n" + body;
}

function download(filename, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], {type:"text/csv"}));
  a.download = filename;
  a.click();
}