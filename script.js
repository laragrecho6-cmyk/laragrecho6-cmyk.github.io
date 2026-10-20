/* =======================================================
   MRDCNHS Freedom Wall — App Logic
   Handles: Firebase (Firestore) sync, wall pan/zoom, note
   creation, rendering, reporting, rate limiting, and
   basic client-side safety checks.

   IMPORTANT: Firebase is loaded lazily and defensively (see
   connectFirebase() below). The whole rest of the site —
   entering the wall, posting notes, zoom/pan — works on its
   own even if Firebase can never be reached (blocked network,
   ad blocker, no config yet, etc.), falling back to a
   local-only demo mode (localStorage) instead of breaking.
   Fill in firebaseConfig below with your own Firebase
   project's details to make this a real shared wall.
======================================================= */

// ---------------------------------------------------------
// 1. FIREBASE SETUP (lazy + defensive — never blocks the app)
// ---------------------------------------------------------
// Replace the values below with your own Firebase project's
// config (Firebase Console → Project Settings → General →
// "Your apps" → SDK setup and configuration).
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

const FIREBASE_CONFIGURED = !Object.values(firebaseConfig).some(
  (v) => typeof v === "string" && v.startsWith("YOUR_")
);

let db = null;         // Firestore database instance, once connected
let notesRef = null;   // reference to the "notes" collection
let fsLib = null;       // the Firestore SDK functions, once loaded

/** Tries to load the Firebase SDK from the CDN and connect to
 *  Firestore. This NEVER throws — any failure (network blocked,
 *  bad config, CDN unreachable, Firestore not set up, etc.) is
 *  caught here so the rest of the site keeps working in local
 *  demo mode instead of the whole page silently breaking. */
async function connectFirebase() {
  if (!FIREBASE_CONFIGURED) return false;
  try {
    const [{ initializeApp }, fsModule] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js")
    ]);
    const app = initializeApp(firebaseConfig);
    const database = fsModule.getFirestore(app);
    notesRef = fsModule.collection(database, "notes");
    db = database;
    fsLib = fsModule;
    return true;
  } catch (err) {
    console.warn(
      "[MRDCNHS Freedom Wall] Couldn't connect to Firebase — continuing in local-only demo mode instead.",
      err
    );
    db = null;
    notesRef = null;
    fsLib = null;
    return false;
  }
}

// ---------------------------------------------------------
// 2. CONSTANTS & STATE
// ---------------------------------------------------------

const COLORS = [
  { id: "yellow", label: "Yellow", hex: "#fff3b0", meaning: "Happiness, positivity, and gratitude." },
  { id: "pink",   label: "Pink",   hex: "#ffd3e0", meaning: "Love, affection, and appreciation." },
  { id: "purple", label: "Purple", hex: "#e3d6ff", meaning: "Deep thoughts, personal reflections, and dreams." },
  { id: "blue",   label: "Blue",   hex: "#cfe8ff", meaning: "Sadness, stress, or a need to express feelings." },
  { id: "black",  label: "Black",  hex: "#2e2e2e", meaning: "Serious thoughts, difficult experiences, or anonymous confessions." },
  { id: "white",  label: "White",  hex: "#ffffff", meaning: "Peace, clarity, and simple messages." },
  { id: "peach",  label: "Peach",  hex: "#ffe0c7", meaning: "Friendship, warmth, and kindness." },
  { id: "mint",   label: "Mint Green", hex: "#cdf5de", meaning: "Hope, growth, and encouragement." }
];

const MAX_MESSAGE_LENGTH = 500;
const POST_COOLDOWN_MS = 15000; // basic client-side rate limit: 1 post / 15s
const CANVAS_WIDTH = 3000;
const CANVAS_HEIGHT = 2000;
const NOTE_WIDTH = 190;
const NOTE_HEIGHT = 190;

let selectedColor = "yellow";
let isPosting = false;
let pendingFocusId = null; // id of the note this user just posted, so we can pan to it once it renders

// Notes are laid out in a left-to-right, top-to-bottom grid so they sit
// neatly beside each other (like a real corkboard row), instead of being
// scattered at random across the big canvas.
const GRID_MARGIN = 40;
const GRID_GAP = 26;

// Pan/zoom state
let scale = 1;
const MIN_SCALE = 0.4;
const MAX_SCALE = 2.2;
let panX = 0;
let panY = 0;
let isDragging = false;
let dragStart = { x: 0, y: 0 };
let panStart = { x: 0, y: 0 };

// A lightweight local ban-word list for basic filtering.
// This is NOT a substitute for real moderation — see README.
const BLOCKED_TERMS = [
  // kept intentionally short/generic; extend server-side for real use
];

// ---------------------------------------------------------
// 3. DOM REFERENCES
// ---------------------------------------------------------

const $ = (id) => document.getElementById(id);

const landing = $("landing");
const wallApp = $("wallApp");
const enterWallBtn = $("enterWallBtn");

const wallViewport = $("wallViewport");
const wallCanvas = $("wallCanvas");
const emptyState = $("emptyState");
const statusPill = $("statusPill");

const createNoteBtn = $("createNoteBtn");
const zoomInBtn = $("zoomInBtn");
const zoomOutBtn = $("zoomOutBtn");
const resetViewBtn = $("resetViewBtn");
const guidelinesBtn = $("guidelinesBtn");
const colorGuideBtn = $("colorGuideBtn");

const editorOverlay = $("editorOverlay");
const closeEditorBtn = $("closeEditorBtn");
const cancelNoteBtn = $("cancelNoteBtn");
const postNoteBtn = $("postNoteBtn");
const noteText = $("noteText");
const charCount = $("charCount");
const colorSwatches = $("colorSwatches");
const notePreview = $("notePreview");
const notePreviewText = $("notePreviewText");

const detailOverlay = $("detailOverlay");
const closeDetailBtn = $("closeDetailBtn");
const detailNote = $("detailNote");
const detailNoteText = $("detailNoteText");
const detailTimestamp = $("detailTimestamp");
const reportNoteBtn = $("reportNoteBtn");
const reportConfirm = $("reportConfirm");

const guidelinesOverlay = $("guidelinesOverlay");
const closeGuidelinesBtn = $("closeGuidelinesBtn");

const colorGuideOverlay = $("colorGuideOverlay");
const closeColorGuideBtn = $("closeColorGuideBtn");
const colorGuideList = $("colorGuideList");

const toast = $("toast");

let activeDetailNoteId = null;

// ---------------------------------------------------------
// 4. UTILITIES
// ---------------------------------------------------------

/** Escapes nothing — we always use textContent, never innerHTML,
 *  for any user-supplied text. This prevents HTML/JS injection. */
function setTextSafely(el, text) {
  el.textContent = text;
}

function showToast(message, duration = 3200) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add("hidden"), duration);
}

function setStatus(message) {
  if (!message) {
    statusPill.classList.add("hidden");
    return;
  }
  statusPill.textContent = message;
  statusPill.classList.remove("hidden");
}

/** Very basic plain-text validation. Real moderation should
 *  also happen server-side (see README / security rules). */
function validateMessage(text) {
  const trimmed = text.trim();
  if (!trimmed) return "Please write something before posting.";
  if (trimmed.length > MAX_MESSAGE_LENGTH) return `Messages must be ${MAX_MESSAGE_LENGTH} characters or fewer.`;
  const lower = trimmed.toLowerCase();
  for (const term of BLOCKED_TERMS) {
    if (lower.includes(term)) {
      return "Your message appears to contain content that isn't allowed here.";
    }
  }
  return null;
}

function canPostNow() {
  const last = Number(localStorage.getItem("fw_lastPostAt") || 0);
  return Date.now() - last >= POST_COOLDOWN_MS;
}

function markPosted() {
  localStorage.setItem("fw_lastPostAt", String(Date.now()));
}

function getOwnedNoteIds() {
  try {
    return JSON.parse(localStorage.getItem("fw_ownNotes") || "[]");
  } catch {
    return [];
  }
}

function addOwnedNoteId(id) {
  const ids = getOwnedNoteIds();
  ids.push(id);
  localStorage.setItem("fw_ownNotes", JSON.stringify(ids.slice(-100)));
}

function colorInfo(id) {
  return COLORS.find((c) => c.id === id) || COLORS[0];
}

function formatTimestamp(ts) {
  let date;
  if (ts && typeof ts.toDate === "function") date = ts.toDate(); // Firestore Timestamp
  else if (ts instanceof Date) date = ts;
  else return "Just now";
  return date.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit"
  });
}

/** Returns the position for the note at a given index in the posting
 *  order, packing notes left-to-right then top-to-bottom so each new
 *  note lands directly beside the previous ones. A small random jitter
 *  keeps the corkboard feel without actually randomizing the layout. */
function getGridPosition(index) {
  const cols = Math.max(
    1,
    Math.floor((CANVAS_WIDTH - GRID_MARGIN * 2) / (NOTE_WIDTH + GRID_GAP))
  );
  const col = index % cols;
  const row = Math.floor(index / cols);
  const baseX = GRID_MARGIN + col * (NOTE_WIDTH + GRID_GAP);
  const baseY = GRID_MARGIN + row * (NOTE_HEIGHT + GRID_GAP);
  const jitterX = Math.random() * 10 - 5;
  const jitterY = Math.random() * 10 - 5;
  return { x: baseX + jitterX, y: baseY + jitterY };
}

// ---------------------------------------------------------
// 5. LANDING → WALL TRANSITION
// ---------------------------------------------------------

enterWallBtn.addEventListener("click", () => {
  landing.style.opacity = "0";
  landing.style.transition = "opacity 0.35s ease";
  setTimeout(() => {
    landing.classList.add("hidden");
    wallApp.classList.remove("hidden");
    initWall();
  }, 320);
});

let wallInitialized = false;
async function initWall() {
  if (wallInitialized) return;
  wallInitialized = true;
  // Show the (empty) wall immediately — don't make the person wait on
  // the network before they can see or use the interface.
  centerCanvas();
  applyTransform();

  if (FIREBASE_CONFIGURED) {
    setStatus("Connecting...");
    const connected = await connectFirebase();
    if (!connected) {
      showToast("Couldn't connect to the shared wall — showing a local-only view instead.");
    }
  }
  subscribeToNotes();
}

// ---------------------------------------------------------
// 6. COLOR SWATCHES + COLOR GUIDE
// ---------------------------------------------------------

function buildColorSwatches() {
  colorSwatches.innerHTML = "";
  COLORS.forEach((c) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "swatch" + (c.id === selectedColor ? " selected" : "");
    btn.style.background = c.hex;
    if (c.id === "white") btn.style.boxShadow = "inset 0 0 0 1px #ddd";
    btn.title = c.label;
    btn.addEventListener("click", () => {
      selectedColor = c.id;
      buildColorSwatches();
      updatePreview();
    });
    colorSwatches.appendChild(btn);
  });
}

function buildColorGuide() {
  colorGuideList.innerHTML = "";
  COLORS.forEach((c) => {
    const row = document.createElement("div");
    row.className = "color-guide-item";

    const dot = document.createElement("div");
    dot.className = "color-guide-dot";
    dot.style.background = c.hex;
    if (c.id === "white") dot.style.boxShadow = "inset 0 0 0 1px #ddd";

    const text = document.createElement("div");
    text.className = "color-guide-text";
    const strong = document.createElement("strong");
    strong.textContent = c.label;
    const span = document.createElement("span");
    span.textContent = c.meaning;
    text.appendChild(strong);
    text.appendChild(span);

    row.appendChild(dot);
    row.appendChild(text);
    colorGuideList.appendChild(row);
  });
}

// ---------------------------------------------------------
// 7. NOTE EDITOR
// ---------------------------------------------------------

function openEditor() {
  noteText.value = "";
  selectedColor = "yellow";
  autoExpandTextarea();
  updateCharCount();
  buildColorSwatches();
  updatePreview();
  postNoteBtn.disabled = true;
  editorOverlay.classList.remove("hidden");
  setTimeout(() => noteText.focus(), 50);
}

function closeEditor() {
  editorOverlay.classList.add("hidden");
}

function autoExpandTextarea() {
  noteText.style.height = "auto";
  noteText.style.height = Math.min(noteText.scrollHeight, 320) + "px";
}

function updateCharCount() {
  const len = noteText.value.length;
  charCount.textContent = String(len);
  postNoteBtn.disabled = len === 0 || len > MAX_MESSAGE_LENGTH;
}

function updatePreview() {
  COLORS.forEach((c) => notePreview.classList.remove(`note-${c.id}`));
  notePreview.classList.add(`note-${selectedColor}`);
  const text = noteText.value.trim() || "Your note will look like this.";
  setTextSafely(notePreviewText, text);
}

noteText.addEventListener("input", () => {
  autoExpandTextarea();
  updateCharCount();
  updatePreview();
});

createNoteBtn.addEventListener("click", () => {
  if (!canPostNow()) {
    const waitSec = Math.ceil((POST_COOLDOWN_MS - (Date.now() - Number(localStorage.getItem("fw_lastPostAt") || 0))) / 1000);
    showToast(`Please wait ${waitSec}s before posting again.`);
    return;
  }
  openEditor();
});
closeEditorBtn.addEventListener("click", closeEditor);
cancelNoteBtn.addEventListener("click", closeEditor);
editorOverlay.addEventListener("click", (e) => { if (e.target === editorOverlay) closeEditor(); });

postNoteBtn.addEventListener("click", async () => {
  if (isPosting) return;
  const text = noteText.value.trim();
  const error = validateMessage(text);
  if (error) { showToast(error); return; }
  if (!canPostNow()) { showToast("You're posting too quickly. Please wait a moment."); return; }

  isPosting = true;
  postNoteBtn.disabled = true;
  postNoteBtn.textContent = "Posting...";

  try {
    await postNote(text, selectedColor);
    markPosted();
    closeEditor();
  } catch (err) {
    console.error(err);
    showToast("Couldn't post your note — please check your connection and try again.");
  } finally {
    isPosting = false;
    postNoteBtn.disabled = false;
    postNoteBtn.textContent = "Post Note";
  }
});

// ---------------------------------------------------------
// 8. POSTING / LOADING NOTES (Firestore, with local fallback)
// ---------------------------------------------------------

async function postNote(text, color) {
  // renderedIds.size = how many notes are already on the wall, which
  // decides where this one lands in the grid (see getGridPosition).
  const { x, y } = getGridPosition(renderedIds.size);
  const rotation = (Math.random() * 10 - 5).toFixed(1); // -5deg to 5deg

  const noteData = {
    text,
    color,
    x,
    y,
    rotation: Number(rotation),
    reported: false,
    reportCount: 0
  };

  if (FIREBASE_CONFIGURED && db) {
    const docRef = await addDoc(notesRef, {
      ...noteData,
      createdAt: serverTimestamp()
    });
    addOwnedNoteId(docRef.id);
    // The note will arrive back through the onSnapshot listener below —
    // remember its id so we can pan the camera to it once it's rendered.
    pendingFocusId = docRef.id;
  } else {
    // Local-only demo fallback (not shared across users/tabs' separate storage)
    const localNotes = getLocalNotes();
    const id = "local_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const entry = { id, ...noteData, createdAt: new Date().toISOString() };
    localNotes.push(entry);
    setLocalNotes(localNotes);
    addOwnedNoteId(id);
    pendingFocusId = id;
    renderNote(entry);
    setStatus("Demo mode — notes are only visible in this browser. See README to connect Firebase.");
  }
}

function getLocalNotes() {
  try { return JSON.parse(localStorage.getItem("fw_localNotes") || "[]"); }
  catch { return []; }
}
function setLocalNotes(notes) {
  localStorage.setItem("fw_localNotes", JSON.stringify(notes));
}

function subscribeToNotes() {
  if (FIREBASE_CONFIGURED && db) {
    setStatus("Connecting...");
    const q = query(notesRef, orderBy("createdAt", "desc"), limit(500));
    onSnapshot(
      q,
      (snapshot) => {
        setStatus(null);
        snapshot.docChanges().forEach((change) => {
          if (change.type === "added") {
            const data = change.doc.data();
            if (data.reported && data.reportCount >= 5) return; // simple auto-hide threshold
            renderNote({ id: change.doc.id, ...data });
          } else if (change.type === "removed") {
            removeNoteEl(change.doc.id);
          }
        });
      },
      (err) => {
        console.error(err);
        setStatus("Connection issue — retrying...");
        showToast("Having trouble reaching the database. Check your Firebase setup.");
      }
    );
  } else {
    setStatus("Demo mode — connect Firebase for a real shared wall (see README.md).");
    const localNotes = getLocalNotes();
    localNotes.forEach(renderNote);
  }
}

// ---------------------------------------------------------
// 9. RENDERING NOTES
// ---------------------------------------------------------

const renderedIds = new Set();

function renderNote(note) {
  if (renderedIds.has(note.id)) return;
  renderedIds.add(note.id);
  emptyState.classList.add("hidden");

  const el = document.createElement("div");
  el.className = `sticky-note note-${note.color} pop-in`;
  el.style.left = note.x + "px";
  el.style.top = note.y + "px";
  el.style.transform = `rotate(${note.rotation || 0}deg)`;
  el.dataset.id = note.id;

  const p = document.createElement("p");
  setTextSafely(p, note.text); // textContent only — never HTML — prevents injection
  el.appendChild(p);

  el.addEventListener("click", () => openDetail(note, el));

  wallCanvas.appendChild(el);

  // If this is the note the current visitor just posted, smoothly pan the
  // wall so it's actually visible instead of leaving them to go find it.
  if (note.id === pendingFocusId) {
    pendingFocusId = null;
    focusOnPosition(note.x, note.y);
  }
}

function removeNoteEl(id) {
  const el = wallCanvas.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (el) el.remove();
  renderedIds.delete(id);
}

// ---------------------------------------------------------
// 10. NOTE DETAIL VIEW + REPORTING
// ---------------------------------------------------------

function openDetail(note, el) {
  activeDetailNoteId = note.id;
  COLORS.forEach((c) => detailNote.classList.remove(`note-${c.id}`));
  detailNote.classList.add(`note-${note.color}`);
  setTextSafely(detailNoteText, note.text);
  detailTimestamp.textContent = "Posted " + formatTimestamp(note.createdAt);
  reportConfirm.classList.add("hidden");
  reportNoteBtn.disabled = false;
  reportNoteBtn.textContent = "Report this note";
  detailOverlay.classList.remove("hidden");
}

closeDetailBtn.addEventListener("click", () => detailOverlay.classList.add("hidden"));
detailOverlay.addEventListener("click", (e) => { if (e.target === detailOverlay) detailOverlay.classList.add("hidden"); });

reportNoteBtn.addEventListener("click", async () => {
  if (!activeDetailNoteId) return;
  const reportedKey = "fw_reported";
  const reported = JSON.parse(localStorage.getItem(reportedKey) || "[]");
  if (reported.includes(activeDetailNoteId)) {
    showToast("You've already reported this note.");
    return;
  }

  reportNoteBtn.disabled = true;
  try {
    if (FIREBASE_CONFIGURED && db) {
      const noteDocRef = doc(db, "notes", activeDetailNoteId);
      await updateDoc(noteDocRef, {
        reported: true,
        reportCount: increment(1)
      });
    }
    reported.push(activeDetailNoteId);
    localStorage.setItem(reportedKey, JSON.stringify(reported));
    reportConfirm.classList.remove("hidden");
    reportNoteBtn.textContent = "Reported";
  } catch (err) {
    console.error(err);
    showToast("Couldn't submit report — please try again.");
    reportNoteBtn.disabled = false;
  }
});

// ---------------------------------------------------------
// 11. GUIDELINES / COLOR GUIDE MODALS
// ---------------------------------------------------------

guidelinesBtn.addEventListener("click", () => guidelinesOverlay.classList.remove("hidden"));
closeGuidelinesBtn.addEventListener("click", () => guidelinesOverlay.classList.add("hidden"));
guidelinesOverlay.addEventListener("click", (e) => { if (e.target === guidelinesOverlay) guidelinesOverlay.classList.add("hidden"); });

colorGuideBtn.addEventListener("click", () => {
  buildColorGuide();
  colorGuideOverlay.classList.remove("hidden");
});
closeColorGuideBtn.addEventListener("click", () => colorGuideOverlay.classList.add("hidden"));
colorGuideOverlay.addEventListener("click", (e) => { if (e.target === colorGuideOverlay) colorGuideOverlay.classList.add("hidden"); });

// ---------------------------------------------------------
// 12. PAN & ZOOM
// ---------------------------------------------------------

function centerCanvas() {
  // Anchor near the top-left corner of the canvas, where the note grid
  // starts filling in, instead of centering the full (mostly empty)
  // 3000×2000 canvas — otherwise the visible viewport only shows empty
  // middle space and newly posted notes can end up off-screen.
  panX = GRID_MARGIN;
  panY = GRID_MARGIN;
}

function applyTransform() {
  wallCanvas.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
}

/** Smoothly pans the wall so the given canvas position is centered in
 *  the viewport, at the current zoom level. Used right after posting so
 *  the new note is immediately visible. */
function focusOnPosition(x, y) {
  const vw = wallViewport.clientWidth;
  const vh = wallViewport.clientHeight;
  panX = vw / 2 - (x + NOTE_WIDTH / 2) * scale;
  panY = vh / 2 - (y + NOTE_HEIGHT / 2) * scale;
  wallCanvas.style.transition = "transform 0.5s cubic-bezier(.22,.8,.3,1)";
  applyTransform();
  setTimeout(() => { wallCanvas.style.transition = ""; }, 520);
}

function zoomBy(factor, centerPoint) {
  const prevScale = scale;
  scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
  if (scale === prevScale) return;

  // Zoom toward the given screen point (keeps that point stable)
  const cx = centerPoint ? centerPoint.x : wallViewport.clientWidth / 2;
  const cy = centerPoint ? centerPoint.y : wallViewport.clientHeight / 2;
  const scaleRatio = scale / prevScale;
  panX = cx - (cx - panX) * scaleRatio;
  panY = cy - (cy - panY) * scaleRatio;
  applyTransform();
}

zoomInBtn.addEventListener("click", () => zoomBy(1.2));
zoomOutBtn.addEventListener("click", () => zoomBy(1 / 1.2));
resetViewBtn.addEventListener("click", () => {
  scale = 1;
  centerCanvas();
  applyTransform();
});

// Mouse drag to pan
wallViewport.addEventListener("mousedown", (e) => {
  if (e.target.closest(".sticky-note")) return;
  isDragging = true;
  wallCanvas.classList.add("grabbing");
  dragStart = { x: e.clientX, y: e.clientY };
  panStart = { x: panX, y: panY };
});
window.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  panX = panStart.x + (e.clientX - dragStart.x);
  panY = panStart.y + (e.clientY - dragStart.y);
  applyTransform();
});
window.addEventListener("mouseup", () => {
  isDragging = false;
  wallCanvas.classList.remove("grabbing");
});

// Wheel to zoom
wallViewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = wallViewport.getBoundingClientRect();
  const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, point);
}, { passive: false });

// Touch: drag to pan, pinch to zoom
let touchMode = null; // 'pan' | 'pinch'
let lastTouchDist = 0;
let lastTouchMid = { x: 0, y: 0 };

wallViewport.addEventListener("touchstart", (e) => {
  if (e.touches.length === 1) {
    if (e.target.closest(".sticky-note")) return;
    touchMode = "pan";
    dragStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    panStart = { x: panX, y: panY };
  } else if (e.touches.length === 2) {
    touchMode = "pinch";
    lastTouchDist = getTouchDist(e.touches);
    lastTouchMid = getTouchMid(e.touches);
  }
}, { passive: true });

wallViewport.addEventListener("touchmove", (e) => {
  if (touchMode === "pan" && e.touches.length === 1) {
    panX = panStart.x + (e.touches[0].clientX - dragStart.x);
    panY = panStart.y + (e.touches[0].clientY - dragStart.y);
    applyTransform();
  } else if (touchMode === "pinch" && e.touches.length === 2) {
    const dist = getTouchDist(e.touches);
    const factor = dist / lastTouchDist;
    const rect = wallViewport.getBoundingClientRect();
    const mid = getTouchMid(e.touches);
    zoomBy(factor, { x: mid.x - rect.left, y: mid.y - rect.top });
    lastTouchDist = dist;
  }
}, { passive: true });

wallViewport.addEventListener("touchend", () => { touchMode = null; });

function getTouchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}
function getTouchMid(touches) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2
  };
}

window.addEventListener("resize", () => {
  if (wallInitialized) applyTransform();
});
