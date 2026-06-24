require("dotenv").config({ path: require("path").join(__dirname, "../.env"), override: false });

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["polling", "websocket"],
  allowEIO3: true
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
}));
app.use(express.static(path.join(__dirname, "../public"), {
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
}));

const multer = require("multer");
const upload = multer({ dest: "uploads/" });
const xlsx = require("xlsx");

/* ==========================================================================
   SUPABASE CLIENT
   ========================================================================== */
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("[SERVER] ERRORE: variabili Supabase mancanti nel .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ==========================================================================
   CONFIGURAZIONE GLOBALE
   ========================================================================== */
const DEFAULT_CONFIG = {
  STARTING_BUDGET: 500,
  MAX_TOTAL_PLAYERS: 25,
  MAX_OFFENSIVE_PLAYERS: 6,
  LIMITS: { "P": 3, "D": 10, "C": 8, "A": 4 }
};

const MANTRA_MAP = {
  "P": "P",
  "DC": "D", "DD": "D", "DS": "D", "B": "D",
  "M": "C", "C": "C", "E": "C", "T": "C", "W": "C",
  "A": "A", "PC": "A"
};

const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/* ==========================================================================
   MULTI-ROOM STATE IN MEMORIA (dati volatili di gioco)
   rooms: Map<roomCode, roomData>
   ========================================================================== */
const rooms = new Map();

function generateRoomCode() {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

function generateAdminPin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function createRoomData(code, adminPin) {
  return {
    code,
    adminPin: adminPin || generateAdminPin(),
    hostUrl: null,
    auctionName: "default",
    autoAdvance: true,
    state: {
      player: null,
      currentPrice: 0,
      highestBidder: null,
      time: 10,
      timerDuration: 10,
      isPaused: false,
      history: []
    },
    teams: {},
    playersList: [],
    soldPlayers: [],
    claimedTeams: {},
    CONFIG: JSON.parse(JSON.stringify(DEFAULT_CONFIG))
  };
}

/* ==========================================================================
   IP E QR CODE
   ========================================================================== */
const VIRTUAL_ADAPTER_KEYWORDS = ["vmware", "virtualbox", "vethernet", "hyper-v", "loopback", "bluetooth", "pseudo", "tunnel", "teredo", "isatap", "6to4", "vpn"];

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (let name in interfaces) {
    const nameLower = name.toLowerCase();
    if (VIRTUAL_ADAPTER_KEYWORDS.some(k => nameLower.includes(k))) continue;
    for (let iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) candidates.push({ name, address: iface.address });
    }
  }
  if (candidates.length > 0) return candidates[0].address;
  for (let name in interfaces) {
    for (let iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "localhost";
}

let CUSTOM_HOST_URL = process.env.HOST_URL || process.env.PUBLIC_URL || null;
let LOCAL_IP = getLocalIp();

function getEffectiveHost(room) {
  return (room && room.hostUrl) || CUSTOM_HOST_URL || LOCAL_IP;
}

function buildConnectionData(roomCode) {
  const room = rooms.get(roomCode);
  const host = getEffectiveHost(room);
  const phoneUrl = host.startsWith("http") ? `${host}/phone.html?room=${roomCode}` : `http://${host}:3000/phone.html?room=${roomCode}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(phoneUrl)}`;
  return { url: phoneUrl, qr: qrUrl };
}

/* ==========================================================================
   SUPABASE — PERSISTENZA
   ========================================================================== */

async function validateAccessCode(code) {
  if (!code) return { valid: false, error: "Codice di accesso richiesto." };
  const { data, error } = await supabase
    .from("access_codes")
    .select("*")
    .eq("code", code.trim().toUpperCase())
    .eq("is_active", true)
    .single();

  if (error || !data) return { valid: false, error: "Codice non valido o non attivo." };
  if (data.expires_at && new Date(data.expires_at) < new Date()) return { valid: false, error: "Codice scaduto." };
  if (data.max_uses !== null && data.uses_count >= data.max_uses) return { valid: false, error: "Codice esaurito (usi terminati)." };
  return { valid: true, data };
}

async function incrementCodeUses(code) {
  await supabase
    .from("access_codes")
    .update({ uses_count: supabase.rpc ? undefined : undefined })
    .eq("code", code);
  // usa rpc per incremento atomico
  await supabase.rpc("increment_code_uses", { p_code: code }).catch(() => {
    // fallback manuale se rpc non disponibile
    supabase.from("access_codes").select("uses_count").eq("code", code).single().then(({ data }) => {
      if (data) supabase.from("access_codes").update({ uses_count: data.uses_count + 1 }).eq("code", code);
    });
  });
}

async function salvaSessioneDB(room) {
  const rc = room.code;
  const an = room.auctionName;

  try {
    // Aggiorna rooms
    await supabase.from("rooms")
      .update({ last_active: new Date().toISOString(), host_url: room.hostUrl, auto_advance: room.autoAdvance })
      .eq("code", rc);

    // Upsert auction_session config
    await supabase.from("auction_sessions")
      .upsert({ room_code: rc, auction_name: an, config: room.CONFIG, timer_duration: room.state.timerDuration, updated_at: new Date().toISOString() }, { onConflict: "room_code,auction_name" });

    // Cancella e reinserisci teams
    await supabase.from("teams").delete().eq("room_code", rc).eq("auction_name", an);
    if (Object.keys(room.teams).length > 0) {
      const teamsRows = Object.entries(room.teams).map(([key, t]) => ({
        room_code: rc, auction_name: an, team_key: key, team_name: t.name, budget: t.budget, slots: t.slots
      }));
      await supabase.from("teams").insert(teamsRows);
    }

    // Cancella e reinserisci players_list
    await supabase.from("players_list").delete().eq("room_code", rc).eq("auction_name", an);
    if (room.playersList.length > 0) {
      const chunks = chunkArray(room.playersList.map(p => ({
        room_code: rc, auction_name: an, nome: p.nome, ruolo: p.ruolo, squadra: p.squadra || "Svincolato"
      })), 500);
      for (const chunk of chunks) await supabase.from("players_list").insert(chunk);
    }

    // Cancella e reinserisci sold_players
    await supabase.from("sold_players").delete().eq("room_code", rc).eq("auction_name", an);
    if (room.soldPlayers.length > 0) {
      const soldRows = room.soldPlayers.map(sp => ({
        room_code: rc, auction_name: an, player_name: sp.player, ruolo: sp.ruolo,
        squadra: sp.squadra || "", winner: sp.winner, price: sp.price, reparto_assegnato: sp.repartoAssegnato
      }));
      await supabase.from("sold_players").insert(soldRows);
    }
  } catch (e) {
    console.error(`[DB] Errore salvataggio stanza ${rc}:`, e.message);
  }
}

async function caricaSessioneDB(room) {
  const rc = room.code;
  const an = room.auctionName;

  try {
    const [sessRes, teamsRes, playersRes, soldRes] = await Promise.all([
      supabase.from("auction_sessions").select("*").eq("room_code", rc).eq("auction_name", an).maybeSingle(),
      supabase.from("teams").select("*").eq("room_code", rc).eq("auction_name", an),
      supabase.from("players_list").select("*").eq("room_code", rc).eq("auction_name", an),
      supabase.from("sold_players").select("*").eq("room_code", rc).eq("auction_name", an)
    ]);

    if (sessRes.data) {
      room.CONFIG = sessRes.data.config || JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      room.state.timerDuration = sessRes.data.timer_duration || 10;
    }

    if (teamsRes.data && teamsRes.data.length > 0) {
      room.teams = {};
      teamsRes.data.forEach(t => {
        room.teams[t.team_key] = { name: t.team_name, budget: t.budget, slots: t.slots };
      });
    }

    if (playersRes.data) {
      room.playersList = playersRes.data.map(p => ({ nome: p.nome, ruolo: p.ruolo, squadra: p.squadra }));
    }

    if (soldRes.data) {
      room.soldPlayers = soldRes.data.map(sp => ({
        player: sp.player_name, ruolo: sp.ruolo, squadra: sp.squadra,
        winner: sp.winner, price: sp.price, repartoAssegnato: sp.reparto_assegnato
      }));
    }

    room.state.player = null;
    room.state.time = room.state.timerDuration;
    room.state.highestBidder = null;
    room.state.isPaused = false;
    console.log(`[DB] Sessione ${rc}/${an} caricata.`);
    return true;
  } catch (e) {
    console.error(`[DB] Errore caricamento stanza ${rc}:`, e.message);
    return false;
  }
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

/* ==========================================================================
   COMPATIBILITÀ: legge i vecchi file JSON se esistono
   ========================================================================== */
function getSavePath(roomCode, auctionName) {
  return path.join(__dirname, `stanza_${roomCode}_${auctionName}.json`);
}

function caricaDaFileSeLegacy(room) {
  const filePath = getSavePath(room.code, room.auctionName);
  if (!fs.existsSync(filePath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    room.teams = data.teams || {};
    room.playersList = data.playersList || [];
    room.soldPlayers = data.soldPlayers || [];
    if (data.settings) room.state.timerDuration = parseInt(data.settings.timerDuration) || 10;
    if (data.CONFIG) room.CONFIG = data.CONFIG;
    room.state.player = null;
    room.state.time = room.state.timerDuration;
    room.state.highestBidder = null;
    room.state.isPaused = false;
    console.log(`[LEGACY] File JSON caricato per ${room.code}/${room.auctionName} — verrà migrato su DB.`);
    return true;
  } catch (e) {
    return false;
  }
}

/* ==========================================================================
   CREA STANZA SU DB
   ========================================================================== */
async function creaStanzaDB(code, adminPin, accessCode) {
  const { error } = await supabase.from("rooms").insert({
    code, admin_pin: adminPin, access_code: accessCode || null
  });
  if (error) throw new Error("Errore creazione stanza DB: " + error.message);
}

async function trovaStanzaDB(code) {
  const { data, error } = await supabase.from("rooms").select("*").eq("code", code).maybeSingle();
  if (error) return null;
  return data;
}

/* ==========================================================================
   UTILITÀ MANTRA
   ========================================================================== */
function ottieniMacroReparti(ruoloStringa) {
  if (!ruoloStringa) return ["D"];
  const ruoliSingoli = ruoloStringa.toUpperCase().split(/[\s,;\-]+/);
  const repartiUnici = new Set();
  ruoliSingoli.forEach(r => {
    const reparto = MANTRA_MAP[r.trim()];
    if (reparto) repartiUnici.add(reparto);
  });
  return Array.from(repartiUnici);
}

function isOffensivoPuro(ruoloStringa) {
  if (!ruoloStringa) return false;
  const ruoliSingoli = ruoloStringa.toUpperCase().split(/[\s,;\-]+/).map(r => r.trim());
  const ruoliOffensivi = ["T", "W", "A", "PC"];
  return ruoliSingoli.every(r => ruoliOffensivi.includes(r));
}

/* ==========================================================================
   LOGICA DI GIOCO
   ========================================================================== */
function eseguiLancioGiocatore(roomCode, p) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.state.player = p;
  room.state.currentPrice = 0;
  room.state.highestBidder = null;
  room.state.time = room.state.timerDuration;
  room.state.isPaused = false;
  room.state.history = [];
  io.to(roomCode).emit("update", room.state);
}

function chiamaGiocatoreCasuale(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (room.playersList.length === 0) {
    room.state.player = null;
    io.to(roomCode).emit("update", room.state);
    io.to(roomCode).emit("errorNotify", "⚠️ Tutti i calciatori nella lista sono finiti!");
    return;
  }
  const index = Math.floor(Math.random() * room.playersList.length);
  eseguiLancioGiocatore(roomCode, room.playersList[index]);
}

function assegnaGiocatoreAVincitore(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const p = room.state.player;
  const winnerKey = room.state.highestBidder.toLowerCase();
  const price = room.state.currentPrice;
  const history = [...(room.state.history || [])];

  const repartiPossibili = ottieniMacroReparti(p.ruolo);
  let repartoScelto = repartiPossibili[0];
  for (let i = 0; i < repartiPossibili.length; i++) {
    const rep = repartiPossibili[i];
    if (room.CONFIG.LIMITS[rep] === 0 || (room.teams[winnerKey].slots[rep] || 0) < room.CONFIG.LIMITS[rep]) {
      repartoScelto = rep;
      break;
    }
  }

  room.teams[winnerKey].budget -= price;
  if (!room.teams[winnerKey].slots[repartoScelto]) room.teams[winnerKey].slots[repartoScelto] = 0;
  room.teams[winnerKey].slots[repartoScelto]++;

  room.soldPlayers.push({
    player: p.nome, ruolo: p.ruolo, squadra: p.squadra,
    winner: room.teams[winnerKey].name, price,
    repartoAssegnato: repartoScelto
  });

  // Salva l'ultima asta per permettere revisione/riassegnazione
  room.lastAuction = {
    player: p,
    winner: room.teams[winnerKey].name,
    winnerKey,
    price,
    repartoAssegnato: repartoScelto,
    history
  };

  room.playersList = room.playersList.filter(item => item.nome !== p.nome);
  salvaSessioneDB(room);

  io.to(roomCode).emit("updateSold", room.soldPlayers);
  io.to(roomCode).emit("updateTeams", room.teams);
  io.to(roomCode).emit("teamsUpdate", room.teams);
  io.to(roomCode).emit("playersList", room.playersList);
  io.to(roomCode).emit("auctionEnded", {
    winner: room.teams[winnerKey].name, player: p.nome, price, history
  });
}

/* ==========================================================================
   TIMER LOOP GLOBALE
   ========================================================================== */
function tickRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.state.player === null || room.state.isPaused) return;

  if (room.state.time > 0) {
    room.state.time--;
    io.to(roomCode).emit("update", room.state);
  } else {
    if (room.state.highestBidder !== null) {
      assegnaGiocatoreAVincitore(roomCode);
      room.state.player = null;
      io.to(roomCode).emit("update", room.state);
      if (room.autoAdvance) {
        setTimeout(() => {
          const r = rooms.get(roomCode);
          if (r && !r.state.isPaused && r.autoAdvance) chiamaGiocatoreCasuale(roomCode);
        }, 2000);
      }
    } else {
      const playerName = room.state.player.nome;
      io.to(roomCode).emit("auctionEnded", { winner: null, player: playerName, price: 0 });
      room.state.player = null;
      io.to(roomCode).emit("update", room.state);
      setTimeout(() => {
        const r = rooms.get(roomCode);
        if (r && !r.state.isPaused && r.autoAdvance) chiamaGiocatoreCasuale(roomCode);
      }, 4000);
    }
  }
}

setInterval(() => {
  for (const roomCode of rooms.keys()) tickRoom(roomCode);
}, 1000);

/* ==========================================================================
   ROTTE EXPRESS
   ========================================================================== */
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/host", (req, res) => res.sendFile(path.join(__dirname, "public", "host.html")));
app.get("/host.html", (req, res) => res.sendFile(path.join(__dirname, "public", "host.html")));
app.get("/rose", (req, res) => res.sendFile(path.join(__dirname, "public", "rose.html")));
app.get("/rose.html", (req, res) => res.sendFile(path.join(__dirname, "public", "rose.html")));
app.get("/superadmin", (req, res) => res.sendFile(path.join(__dirname, "public", "superadmin.html")));

/* ==========================================================================
   API CODICI ACCESSO (solo superadmin)
   ========================================================================== */
const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || "DraftArena2025!";

app.post("/api/superadmin/login", (req, res) => {
  const { password } = req.body;
  if (password === SUPERADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: "Password errata." });
  }
});

app.get("/api/superadmin/codes", async (req, res) => {
  const { data, error } = await supabase.from("access_codes").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, codes: data });
});

app.post("/api/superadmin/codes", async (req, res) => {
  const { type, maxUses, expiresAt, note } = req.body;
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "DRAFT-";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];

  const row = {
    code,
    type: type || "promo",
    max_uses: maxUses || null,
    expires_at: expiresAt || null,
    note: note || null,
    is_active: true
  };

  const { data, error } = await supabase.from("access_codes").insert(row).select().single();
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, code: data });
});

app.patch("/api/superadmin/codes/:id", async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;
  const { error } = await supabase.from("access_codes").update({ is_active }).eq("id", id);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true });
});

app.get("/api/superadmin/rooms", async (req, res) => {
  const { data, error } = await supabase.from("rooms").select("*").order("created_at", { ascending: false }).limit(50);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, rooms: data });
});

/* ==========================================================================
   VALIDAZIONE CODICE ACCESSO (pubblica)
   ========================================================================== */
app.post("/api/access/validate", async (req, res) => {
  const { code } = req.body;
  const result = await validateAccessCode(code);
  if (!result.valid) return res.status(400).json({ success: false, error: result.error });
  res.json({ success: true, type: result.data.type });
});

/* ==========================================================================
   REST API — Room Create/Join
   ========================================================================== */
const createRoomLimiter = new Map();
function rateLimit(ip, maxPerMinute = 10) {
  const now = Date.now();
  const entry = createRoomLimiter.get(ip) || { count: 0, reset: now + 60000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60000; }
  entry.count++;
  createRoomLimiter.set(ip, entry);
  return entry.count > maxPerMinute;
}

app.get("/api/room/create", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  if (rateLimit(ip, 5)) return res.status(429).json({ success: false, error: "Troppe richieste. Riprova tra un minuto." });

  const accessCode = String(req.query.accessCode || "").trim().toUpperCase();
  const validation = await validateAccessCode(accessCode);
  if (!validation.valid) return res.status(403).json({ success: false, error: validation.error });

  try {
    let code;
    let attempts = 0;
    do { code = generateRoomCode(); attempts++; } while (rooms.has(code) && attempts < 30);

    const adminPin = generateAdminPin();
    await creaStanzaDB(code, adminPin, accessCode);

    // Incrementa usi codice (non per superadmin)
    if (validation.data.type !== "superadmin") await incrementCodeUses(accessCode);

    const room = createRoomData(code, adminPin);
    rooms.set(code, room);

    console.log(`[SERVER] Stanza creata: ${code} (codice: ${accessCode})`);
    res.json({ success: true, roomCode: code, adminPin });
  } catch (e) {
    console.error("[SERVER] createRoom error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/room/join/:code", async (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();

  let room = rooms.get(code);
  if (room) return res.json({ success: true, roomCode: code });

  // Cerca sul DB
  const dbRoom = await trovaStanzaDB(code);
  if (!dbRoom) return res.json({ success: false, error: "Stanza non trovata. Verifica il codice." });

  const newRoom = createRoomData(code, dbRoom.admin_pin);
  newRoom.hostUrl = dbRoom.host_url;
  newRoom.autoAdvance = dbRoom.auto_advance;

  // Carica da DB, poi fallback su file legacy
  const loaded = await caricaSessioneDB(newRoom);
  if (!loaded) {
    caricaDaFileSeLegacy(newRoom);
    // Migra subito su DB se trovato da file
    if (newRoom.playersList.length > 0 || Object.keys(newRoom.teams).length > 0) {
      salvaSessioneDB(newRoom);
    }
  }

  rooms.set(code, newRoom);
  res.json({ success: true, roomCode: code });
});

/* ==========================================================================
   UPLOAD EXCEL
   ========================================================================== */
app.post("/upload", upload.single("file"), async (req, res) => {
  const roomCode = String(req.query.room || "").toUpperCase().trim();
  const room = rooms.get(roomCode);
  if (!room) return res.status(400).send("Stanza non trovata");
  if (!req.file) return res.status(400).send("Nessun file caricato");

  try {
    const workbook = xlsx.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const matrix = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    let rigaIntestazione = -1, indexNome = -1, indexRuolo = -1, indexSquadra = -1, indexPrezzo = -1;

    for (let r = 0; r < matrix.length; r++) {
      const row = matrix[r];
      for (let c = 0; c < row.length; c++) {
        const v = String(row[c]).toLowerCase().trim();
        if (["nome", "calciatore", "giocatore", "rilancio"].includes(v)) indexNome = c;
        if (["ruolo", "rm", "r", "ruolo mantra"].includes(v)) indexRuolo = c;
        if (["squadra", "club", "team", "squadra di a"].includes(v)) indexSquadra = c;
        if (["valore", "quotazione", "prezzo", "qt", "costo"].includes(v)) indexPrezzo = c;
      }
      if (indexNome !== -1 && indexRuolo !== -1) { rigaIntestazione = r; break; }
    }

    if (rigaIntestazione === -1) {
      indexNome = 0; indexRuolo = 1; indexSquadra = 2; indexPrezzo = 3; rigaIntestazione = 0;
    }

    const sogliaMinima = parseInt(req.query.soglia) || 0;
    room.playersList = [];

    for (let r = rigaIntestazione + 1; r < matrix.length; r++) {
      const row = matrix[r];
      if (!row || row.length === 0) continue;
      const nome = row[indexNome] ? String(row[indexNome]).trim() : "";
      const ruolo = row[indexRuolo] ? String(row[indexRuolo]).trim() : "";
      const squadra = indexSquadra !== -1 && row[indexSquadra] ? String(row[indexSquadra]).trim() : "Svincolato";
      const valoreEffettivo = indexPrezzo !== -1 && row[indexPrezzo] ? parseInt(row[indexPrezzo]) : 1;
      if (valoreEffettivo < sogliaMinima) continue;
      if (nome && ruolo) room.playersList.push({ nome, ruolo: ruolo.toUpperCase(), squadra });
    }

    await salvaSessioneDB(room);
    io.to(roomCode).emit("playersList", room.playersList);
    res.send("OK");
  } catch (e) {
    console.error("[SERVER] Errore parsing Excel:", e);
    res.status(500).send("Errore nel parsing del file Excel");
  }
});

/* ==========================================================================
   EXPORT EXCEL
   ========================================================================== */
app.get("/export", (req, res) => {
  const roomCode = String(req.query.room || "").toUpperCase().trim();
  const room = rooms.get(roomCode);
  if (!room) return res.status(400).send("Stanza non trovata");

  try {
    const wb = xlsx.utils.book_new();
    const keysSquadre = Object.keys(room.teams);

    if (keysSquadre.length > 0) {
      keysSquadre.forEach(k => {
        const squadra = room.teams[k];
        const acquisti = room.soldPlayers.filter(p =>
          p.winner.toLowerCase().trim() === squadra.name.toLowerCase().trim()
        );
        let dati = acquisti.length > 0
          ? [...acquisti].sort((a, b) => a.ruolo.localeCompare(b.ruolo)).map(p => ({
              "Calciatore": p.player, "Ruolo Mantra": p.ruolo, "Squadra di A": p.squadra,
              "Prezzo (€)": p.price, "Reparto Assegnato": p.repartoAssegnato
            }))
          : [{ "Calciatore": "Nessun acquisto", "Ruolo Mantra": "-", "Squadra di A": "-", "Prezzo (€)": 0, "Reparto Assegnato": "-" }];

        dati.push({});
        dati.push({
          "Calciatore": `BUDGET INIZIALE: ${room.CONFIG.STARTING_BUDGET} cr`,
          "Ruolo Mantra": "CREDITI RIMANENTI:", "Squadra di A": `${squadra.budget} cr`,
          "Prezzo (€)": "", "Reparto Assegnato": ""
        });
        const ws = xlsx.utils.json_to_sheet(dati);
        xlsx.utils.book_append_sheet(wb, ws, squadra.name.substring(0, 30));
      });
    } else {
      xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet([{ "Avviso": "Nessuna squadra registrata." }]), "Vuoto");
    }

    const nonVenduti = room.playersList.length > 0
      ? [...room.playersList].sort((a, b) => a.ruolo.localeCompare(b.ruolo) || a.nome.localeCompare(b.nome))
          .map(p => ({ "Calciatore": p.nome, "Ruolo Mantra": p.ruolo, "Squadra di A": p.squadra, "Stato": "Svincolato" }))
      : [{ "Avviso": "Tutti i giocatori sono stati venduti!" }];
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(nonVenduti), "Svincolati");

    const reportBudget = Object.keys(room.teams).map(k => ({
      "Fantasquadra": room.teams[k].name,
      "Budget Rimanente": room.teams[k].budget,
      "Giocatori in Rosa": Object.values(room.teams[k].slots).reduce((a, b) => a + b, 0),
      "Por": room.teams[k].slots.P || 0, "Dif": room.teams[k].slots.D || 0,
      "Cen": room.teams[k].slots.C || 0, "Att": room.teams[k].slots.A || 0
    }));
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(reportBudget), "Tabellone Lega");

    const buffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=asta_${roomCode}.xlsx`);
    res.send(buffer);
  } catch (e) {
    console.error("[SERVER] Errore export Excel:", e);
    res.status(500).send("Errore durante la generazione del file Excel.");
  }
});

/* ==========================================================================
   SOCKET.IO
   ========================================================================== */
io.on("connection", (socket) => {

  function getRoom() {
    if (!socket.roomCode) return null;
    return rooms.get(socket.roomCode);
  }

  function requireAdmin() {
    if (!socket.isAdmin) {
      socket.emit("errorNotify", "🔒 Accesso negato: effettua il login admin.");
      return false;
    }
    return true;
  }

  function sendRoomData(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    socket.emit("connectionData", buildConnectionData(roomCode));
    socket.emit("currentAuctionName", room.auctionName);
    socket.emit("update", room.state);
    socket.emit("updateTeams", room.teams);
    socket.emit("teamsUpdate", room.teams);
    socket.emit("updateSold", room.soldPlayers);
    socket.emit("playersList", room.playersList);
    socket.emit("configUpdate", { CONFIG: room.CONFIG, timerDuration: room.state.timerDuration });
    socket.emit("takenTeams", Object.keys(room.claimedTeams || {}));
  }

  // ─── GESTIONE STANZE ─────────────────────────────────────────────────────

  socket.on("createRoom", async (data) => {
    try {
      const accessCode = String(data?.accessCode || "").trim().toUpperCase();
      const validation = await validateAccessCode(accessCode);
      if (!validation.valid) {
        socket.emit("roomError", { error: validation.error });
        return;
      }

      let code;
      let attempts = 0;
      do { code = generateRoomCode(); attempts++; } while (rooms.has(code) && attempts < 30);

      const adminPin = generateAdminPin();
      await creaStanzaDB(code, adminPin, accessCode);
      if (validation.data.type !== "superadmin") await incrementCodeUses(accessCode);

      const room = createRoomData(code, adminPin);
      rooms.set(code, room);

      socket.roomCode = code;
      socket.join(code);
      sendRoomData(code);

      console.log(`[SERVER] Stanza creata (socket): ${code}`);
      socket.emit("roomReady", { roomCode: code });
    } catch(e) {
      socket.emit("roomError", { error: "Errore interno del server: " + e.message });
    }
  });

  socket.on("joinRoom", async (code) => {
    const upperCode = String(code).toUpperCase().trim();

    let room = rooms.get(upperCode);
    if (!room) {
      const dbRoom = await trovaStanzaDB(upperCode);
      if (!dbRoom) {
        socket.emit("roomError", { error: "Stanza non trovata. Verifica il codice." });
        return;
      }
      room = createRoomData(upperCode, dbRoom.admin_pin);
      room.hostUrl = dbRoom.host_url;
      room.autoAdvance = dbRoom.auto_advance;

      const loaded = await caricaSessioneDB(room);
      if (!loaded) {
        caricaDaFileSeLegacy(room);
        if (room.playersList.length > 0 || Object.keys(room.teams).length > 0) salvaSessioneDB(room);
      }
      rooms.set(upperCode, room);
    }

    socket.roomCode = upperCode;
    socket.join(upperCode);
    sendRoomData(upperCode);
    socket.emit("roomReady", { roomCode: upperCode });
  });

  // ─── AUTENTICAZIONE ADMIN ────────────────────────────────────────────────

  socket.on("adminAuth", (data) => {
    const room = getRoom(); if (!room) return;
    if (String(data?.pin) === String(room.adminPin)) {
      socket.isAdmin = true;
      socket.emit("adminAuthResult", { success: true });
    } else {
      socket.isAdmin = false;
      socket.emit("adminAuthResult", { success: false });
      socket.emit("errorNotify", "🔒 PIN admin errato.");
    }
  });

  // ─── TIMER ───────────────────────────────────────────────────────────────

  socket.on("pauseTimer", () => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    room.state.isPaused = true;
    io.to(socket.roomCode).emit("update", room.state);
  });

  socket.on("resumeTimer", () => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    room.state.isPaused = false;
    io.to(socket.roomCode).emit("update", room.state);
  });

  // ─── RILANCI ─────────────────────────────────────────────────────────────

  socket.on("bid", (data) => {
    const room = getRoom(); if (!room) return;
    const rc = socket.roomCode;
    if (room.state.player === null || room.state.time <= 0 || room.state.isPaused) return;

    const teamKey = String(data.name).toLowerCase().trim();
    const importoRilancio = parseInt(data.amount);
    if (isNaN(importoRilancio) || importoRilancio < 1 || importoRilancio > 200) {
      socket.emit("errorNotify", "❌ Importo rilancio non valido."); return;
    }
    const nuovoPrezzo = room.state.currentPrice + importoRilancio;

    if (!room.teams[teamKey]) {
      socket.emit("errorNotify", `❌ La squadra '${data.name}' non esiste!`); return;
    }
    if (room.state.highestBidder !== null && room.state.highestBidder.toLowerCase().trim() === teamKey) {
      socket.emit("errorNotify", "⚠️ Non puoi rilanciare! L'offerta più alta è già la tua."); return;
    }
    if (room.teams[teamKey].budget < nuovoPrezzo) {
      socket.emit("errorNotify", "❌ Crediti insufficienti!"); return;
    }

    const totaliAttuali = Object.values(room.teams[teamKey].slots).reduce((a, b) => a + b, 0);
    if (totaliAttuali >= room.CONFIG.MAX_TOTAL_PLAYERS) {
      socket.emit("errorNotify", `❌ Rosa piena! Max ${room.CONFIG.MAX_TOTAL_PLAYERS} giocatori.`); return;
    }

    const slotLiberiRimanenti = room.CONFIG.MAX_TOTAL_PLAYERS - (totaliAttuali + 1);
    if ((room.teams[teamKey].budget - nuovoPrezzo) < slotLiberiRimanenti) {
      const max = room.teams[teamKey].budget - slotLiberiRimanenti;
      socket.emit("errorNotify", `❌ Devi conservare 1 credito per i restanti giocatori. Max: ${max} cr.`); return;
    }

    if (isOffensivoPuro(room.state.player.ruolo)) {
      const offensiviComprati = room.soldPlayers.filter(p =>
        p.winner.toLowerCase() === teamKey && isOffensivoPuro(p.ruolo)
      ).length;
      if (offensiviComprati >= room.CONFIG.MAX_OFFENSIVE_PLAYERS) {
        socket.emit("errorNotify", `❌ Max ${room.CONFIG.MAX_OFFENSIVE_PLAYERS} offensivi puri.`); return;
      }
    }

    const repartiPossibili = ottieniMacroReparti(room.state.player.ruolo);
    const haSpazio = repartiPossibili.some(rep =>
      room.CONFIG.LIMITS[rep] === 0 || (room.teams[teamKey].slots[rep] || 0) < room.CONFIG.LIMITS[rep]
    );
    if (!haSpazio) {
      socket.emit("errorNotify", `❌ Ruoli occupati per ${room.state.player.ruolo}!`); return;
    }

    room.state.currentPrice = nuovoPrezzo;
    room.state.highestBidder = room.teams[teamKey].name;
    room.state.time = room.state.timerDuration;
    room.state.history.push({ bidder: room.teams[teamKey].name, price: nuovoPrezzo });
    io.to(rc).emit("update", room.state);
  });

  // ─── GESTIONE ASTA ───────────────────────────────────────────────────────

  socket.on("startRandom", () => {
    const room = getRoom(); if (!room || room.playersList.length === 0) return;
    if (!requireAdmin()) return;
    eseguiLancioGiocatore(socket.roomCode, room.playersList[Math.floor(Math.random() * room.playersList.length)]);
  });

  socket.on("startPlayer", (p) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    eseguiLancioGiocatore(socket.roomCode, p);
  });

  socket.on("adminStartPlayer", (p) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    eseguiLancioGiocatore(socket.roomCode, p);
  });

  socket.on("toggleAutoAdvance", (status) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    room.autoAdvance = status;
  });

  // ─── GESTIONE LEGHE ──────────────────────────────────────────────────────

  socket.on("adminSwitchAuction", async (name) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    const rc = socket.roomCode;
    await salvaSessioneDB(room);
    room.auctionName = name.trim().toLowerCase().replace(/[^a-zA-Z0-9_]/g, "_");
    await caricaSessioneDB(room);
    io.to(rc).emit("currentAuctionName", room.auctionName);
    io.to(rc).emit("update", room.state);
    io.to(rc).emit("updateTeams", room.teams);
    io.to(rc).emit("teamsUpdate", room.teams);
    io.to(rc).emit("updateSold", room.soldPlayers);
    io.to(rc).emit("playersList", room.playersList);
    socket.emit("auctionSwitchedSuccess", room.auctionName);
  });

  // ─── GESTIONE SQUADRE ────────────────────────────────────────────────────

  socket.on("adminCreateTeam", async (teamName) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    const key = teamName.toLowerCase().trim();
    if (!room.teams[key]) {
      room.teams[key] = { name: teamName, budget: room.CONFIG.STARTING_BUDGET, slots: { P: 0, D: 0, C: 0, A: 0 } };
      await salvaSessioneDB(room);
      io.to(socket.roomCode).emit("updateTeams", room.teams);
      io.to(socket.roomCode).emit("teamsUpdate", room.teams);
    }
  });

  socket.on("adminDeleteTeam", async (key) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    const normalizedKey = String(key).toLowerCase().trim();
    if (!room.teams[normalizedKey]) return;
    delete room.teams[normalizedKey];
    await salvaSessioneDB(room);
    io.to(socket.roomCode).emit("updateTeams", room.teams);
    io.to(socket.roomCode).emit("teamsUpdate", room.teams);
  });

  // ─── GESTIONE GIOCATORI ──────────────────────────────────────────────────

  socket.on("getPlayers", () => {
    const room = getRoom(); if (!room) return;
    socket.emit("playersList", room.playersList);
  });

  socket.on("adminAddNewPlayer", async (newPlayer) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    if (!newPlayer.nome || !newPlayer.ruolo) {
      socket.emit("errorNotify", "❌ Nome e Ruolo obbligatori!"); return;
    }
    const esisteGia = room.playersList.some(pl => pl.nome.toLowerCase() === newPlayer.nome.toLowerCase().trim());
    if (esisteGia) { socket.emit("errorNotify", "⚠️ Giocatore già presente!"); return; }
    room.playersList.push({ nome: newPlayer.nome.trim(), ruolo: newPlayer.ruolo.toUpperCase().trim(), squadra: newPlayer.squadra?.trim() || "Nuovo Acquisto" });
    io.to(socket.roomCode).emit("playersList", room.playersList);
    await salvaSessioneDB(room);
    socket.emit("errorNotify", `🎯 Aggiunto: ${newPlayer.nome} (${newPlayer.ruolo})`);
  });

  socket.on("adminScartaDalMazzo", async (playerName) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    room.playersList = room.playersList.filter(pl => pl.nome.toLowerCase() !== playerName.toLowerCase().trim());
    io.to(socket.roomCode).emit("playersList", room.playersList);
    await salvaSessioneDB(room);
  });

  // ─── OPERAZIONI SPECIALI ─────────────────────────────────────────────────

  socket.on("adminForceAssign", async (data) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    if (!room.state.player) { socket.emit("errorNotify", "Nessun giocatore attivo!"); return; }
    const nameKey = data.squadra.toLowerCase().trim();
    if (!room.teams[nameKey]) { socket.emit("errorNotify", "Squadra non valida!"); return; }

    const p = room.state.player;
    const price = parseInt(data.prezzo) || 1;
    const totali = Object.values(room.teams[nameKey].slots).reduce((a, b) => a + b, 0);
    if (totali >= room.CONFIG.MAX_TOTAL_PLAYERS) { socket.emit("errorNotify", "Rosa piena!"); return; }

    const repartiPossibili = ottieniMacroReparti(p.ruolo);
    let repartoScelto = null;
    for (let i = 0; i < repartiPossibili.length; i++) {
      const rep = repartiPossibili[i];
      if (room.CONFIG.LIMITS[rep] === 0 || (room.teams[nameKey].slots[rep] || 0) < room.CONFIG.LIMITS[rep]) { repartoScelto = rep; break; }
    }
    if (!repartoScelto) { socket.emit("errorNotify", "Spazio esaurito nei ruoli!"); return; }

    room.playersList = room.playersList.filter(pl => pl.nome !== p.nome);
    room.soldPlayers.push({ player: p.nome, ruolo: p.ruolo, squadra: p.squadra, winner: room.teams[nameKey].name, price, repartoAssegnato: repartoScelto });
    room.teams[nameKey].budget -= price;
    room.teams[nameKey].slots[repartoScelto] = (room.teams[nameKey].slots[repartoScelto] || 0) + 1;
    room.state.player = null;

    const rc = socket.roomCode;
    io.to(rc).emit("update", room.state);
    io.to(rc).emit("updateSold", room.soldPlayers);
    io.to(rc).emit("updateTeams", room.teams);
    io.to(rc).emit("teamsUpdate", room.teams);
    io.to(rc).emit("playersList", room.playersList);
    await salvaSessioneDB(room);
  });

  socket.on("adminRiciclaInvenduti", async () => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    if (room.playersList.length === 0) {
      socket.emit("errorNotify", "❌ Nessun giocatore svincolato nel mazzo!"); return;
    }
    room.state = { player: null, currentPrice: 0, highestBidder: null, time: room.state.timerDuration, timerDuration: room.state.timerDuration, isPaused: false, history: [] };
    const rc = socket.roomCode;
    io.to(rc).emit("update", room.state);
    io.to(rc).emit("playersList", room.playersList);
    await salvaSessioneDB(room);
    socket.emit("errorNotify", `🔄 GIRO DI GARA! ${room.playersList.length} giocatori nel mazzo.`);
  });

  socket.on("adminRemovePlayer", async (data) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    const nameKey = data.teamName.toLowerCase().trim();
    if (!room.teams[nameKey]) return;

    const index = room.soldPlayers.findIndex(sp =>
      sp.player.toLowerCase() === data.playerName.toLowerCase() &&
      sp.winner.toLowerCase().trim() === nameKey
    );
    if (index === -1) { socket.emit("errorNotify", "Giocatore non trovato!"); return; }

    const pVenduto = room.soldPlayers[index];
    const crediti = Math.max(0, parseInt(data.creditsToReturn) || 0);
    room.teams[nameKey].budget += crediti;
    const rep = pVenduto.repartoAssegnato;
    if (room.teams[nameKey].slots[rep] > 0) room.teams[nameKey].slots[rep]--;

    if (!room.playersList.some(pl => pl.nome.toLowerCase() === pVenduto.player.toLowerCase())) {
      room.playersList.push({ nome: pVenduto.player, ruolo: pVenduto.ruolo, squadra: pVenduto.squadra });
    }
    room.soldPlayers.splice(index, 1);

    const rc = socket.roomCode;
    io.to(rc).emit("updateSold", room.soldPlayers);
    io.to(rc).emit("updateTeams", room.teams);
    io.to(rc).emit("teamsUpdate", room.teams);
    io.to(rc).emit("playersList", room.playersList);
    await salvaSessioneDB(room);
    socket.emit("errorNotify", `❌ Rimosso ${pVenduto.player}. Rimborso: ${crediti} cr`);
  });

  socket.on("getSoldPlayers", () => {
    const room = getRoom(); if (!room) return;
    socket.emit("updateSold", room.soldPlayers);
  });

  // ─── CLAIM SQUADRA (phone) ───────────────────────────────────────────────

  socket.on("claimTeam", (teamName) => {
    const room = getRoom(); if (!room) return;
    const key = String(teamName).toLowerCase().trim();
    if (!room.teams[key]) {
      socket.emit("claimTeamResult", { success: false, error: "Squadra non trovata." });
      return;
    }
    const current = room.claimedTeams[key];
    if (current && current !== socket.id) {
      socket.emit("claimTeamResult", { success: false, error: "Squadra già selezionata da un altro partecipante." });
      return;
    }
    for (const k in room.claimedTeams) {
      if (room.claimedTeams[k] === socket.id) delete room.claimedTeams[k];
    }
    room.claimedTeams[key] = socket.id;
    socket.emit("claimTeamResult", { success: true });
    io.to(socket.roomCode).emit("takenTeams", Object.keys(room.claimedTeams));
  });

  socket.on("releaseTeam", () => {
    const room = getRoom(); if (!room) return;
    for (const k in room.claimedTeams) {
      if (room.claimedTeams[k] === socket.id) delete room.claimedTeams[k];
    }
    io.to(socket.roomCode).emit("takenTeams", Object.keys(room.claimedTeams));
  });

  socket.on("disconnect", () => {
    if (socket.roomCode) {
      const room = rooms.get(socket.roomCode);
      if (room && room.claimedTeams) {
        let changed = false;
        for (const k in room.claimedTeams) {
          if (room.claimedTeams[k] === socket.id) { delete room.claimedTeams[k]; changed = true; }
        }
        if (changed) io.to(socket.roomCode).emit("takenTeams", Object.keys(room.claimedTeams));
      }
    }
  });

  // ─── RIASSEGNAZIONE ULTIMA ASTA ──────────────────────────────────────────

  socket.on("adminReassignLastSold", async (data) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    if (!room.lastAuction) { socket.emit("errorNotify", "Nessuna asta recente da riassegnare."); return; }

    const last = room.lastAuction;
    const p = last.player;
    const oldWinnerKey = last.winnerKey;
    const newWinnerKey = String(data.newWinner).toLowerCase().trim();
    const newPrice = Math.max(0, parseInt(data.newPrice) || last.price);

    if (!room.teams[newWinnerKey]) { socket.emit("errorNotify", `Squadra "${data.newWinner}" non trovata.`); return; }

    // Rimuovi dalla rosa del vecchio vincitore
    const idx = room.soldPlayers.findIndex(sp =>
      sp.player.toLowerCase() === p.nome.toLowerCase() &&
      sp.winner.toLowerCase().trim() === last.winner.toLowerCase().trim()
    );
    if (idx === -1) { socket.emit("errorNotify", "Giocatore non trovato nello storico vendite."); return; }

    const oldSp = room.soldPlayers[idx];

    // Ripristina budget e slot del vecchio vincitore
    if (room.teams[oldWinnerKey]) {
      room.teams[oldWinnerKey].budget += oldSp.price;
      if (room.teams[oldWinnerKey].slots[oldSp.repartoAssegnato] > 0)
        room.teams[oldWinnerKey].slots[oldSp.repartoAssegnato]--;
    }
    room.soldPlayers.splice(idx, 1);

    // Scegli reparto per il nuovo vincitore
    const repartiPossibili = ottieniMacroReparti(p.ruolo);
    let repartoScelto = repartiPossibili[0];
    for (let i = 0; i < repartiPossibili.length; i++) {
      const rep = repartiPossibili[i];
      if (room.CONFIG.LIMITS[rep] === 0 || (room.teams[newWinnerKey].slots[rep] || 0) < room.CONFIG.LIMITS[rep]) {
        repartoScelto = rep; break;
      }
    }

    room.teams[newWinnerKey].budget -= newPrice;
    room.teams[newWinnerKey].slots[repartoScelto] = (room.teams[newWinnerKey].slots[repartoScelto] || 0) + 1;
    room.soldPlayers.push({
      player: p.nome, ruolo: p.ruolo, squadra: p.squadra,
      winner: room.teams[newWinnerKey].name, price: newPrice,
      repartoAssegnato: repartoScelto
    });

    // Aggiorna lastAuction con la nuova assegnazione
    room.lastAuction.winner = room.teams[newWinnerKey].name;
    room.lastAuction.winnerKey = newWinnerKey;
    room.lastAuction.price = newPrice;

    const rc = socket.roomCode;
    await salvaSessioneDB(room);
    io.to(rc).emit("updateSold", room.soldPlayers);
    io.to(rc).emit("updateTeams", room.teams);
    io.to(rc).emit("teamsUpdate", room.teams);
    io.to(rc).emit("lastAuctionReassigned", {
      player: p.nome, newWinner: room.teams[newWinnerKey].name, newPrice
    });
    socket.emit("errorNotify", `✅ ${p.nome} riassegnato a ${room.teams[newWinnerKey].name} per ${newPrice} cr`);
  });

  socket.on("updateSettings", async (config) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    const num = (v) => { const x = parseInt(v); return isNaN(x) ? undefined : x; };

    const td = num(config.timerDuration);
    if (td !== undefined && td >= 1) { room.state.timerDuration = td; if (!room.state.player) room.state.time = td; }

    const sb = num(config.startingBudget); if (sb !== undefined && sb > 0) room.CONFIG.STARTING_BUDGET = sb;
    const mt = num(config.maxTotalPlayers); if (mt !== undefined && mt > 0) room.CONFIG.MAX_TOTAL_PLAYERS = mt;
    const mo = num(config.maxOffensivePlayers); if (mo !== undefined && mo >= 0) room.CONFIG.MAX_OFFENSIVE_PLAYERS = mo;

    const lP = num(config.limitP); if (lP !== undefined && lP >= 0) room.CONFIG.LIMITS["P"] = lP;
    const lD = num(config.limitD); if (lD !== undefined && lD >= 0) room.CONFIG.LIMITS["D"] = lD;
    const lC = num(config.limitC); if (lC !== undefined && lC >= 0) room.CONFIG.LIMITS["C"] = lC;
    const lA = num(config.limitA); if (lA !== undefined && lA >= 0) room.CONFIG.LIMITS["A"] = lA;

    if (config.isPaused !== undefined) {
      room.state.isPaused = config.isPaused;
      io.to(socket.roomCode).emit("update", room.state);
    }
    await salvaSessioneDB(room);
    socket.emit("configUpdate", { CONFIG: room.CONFIG, timerDuration: room.state.timerDuration });
  });

  // ─── SALVATAGGIO / RESET ─────────────────────────────────────────────────

  socket.on("setHostUrl", async (data) => {
    const url = (data.url || "").trim();
    if (socket.roomCode) {
      const room = getRoom();
      if (room) {
        room.hostUrl = url || null;
        await supabase.from("rooms").update({ host_url: room.hostUrl }).eq("code", socket.roomCode);
        io.to(socket.roomCode).emit("connectionData", buildConnectionData(socket.roomCode));
      }
    }
    if (!socket.roomCode) CUSTOM_HOST_URL = url || null;
    socket.emit("hostUrlUpdate", { hostUrl: url || CUSTOM_HOST_URL || LOCAL_IP, isCustom: !!url });
  });

  socket.on("adminTriggerSave", async () => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    await salvaSessioneDB(room);
    socket.emit("errorNotify", "💾 Salvato!");
  });

  socket.on("adminTriggerLoad", async () => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    await caricaSessioneDB(room);
    const rc = socket.roomCode;
    io.to(rc).emit("updateTeams", room.teams);
    io.to(rc).emit("teamsUpdate", room.teams);
    io.to(rc).emit("updateSold", room.soldPlayers);
    io.to(rc).emit("playersList", room.playersList);
  });

  socket.on("reset", async () => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    const rc = socket.roomCode;
    room.state = { player: null, currentPrice: 0, highestBidder: null, time: 10, timerDuration: room.state.timerDuration, isPaused: false, history: [] };
    room.soldPlayers = [];
    room.teams = {};
    await salvaSessioneDB(room);
    io.to(rc).emit("update", room.state);
    io.to(rc).emit("updateSold", room.soldPlayers);
    io.to(rc).emit("updateTeams", room.teams);
    io.to(rc).emit("teamsUpdate", room.teams);
  });
});

/* ==========================================================================
   AVVIO SERVER
   ========================================================================== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("====================================================");
  console.log(`🚀 SERVER APERTO SU http://localhost:${PORT}`);
  console.log(`📡 Rete locale: http://${LOCAL_IP}:${PORT}`);
  console.log(`🗄️  Supabase: ${SUPABASE_URL}`);
  if (CUSTOM_HOST_URL) {
    console.log(`🌐 Modalità ONLINE — URL pubblico: ${CUSTOM_HOST_URL}`);
  } else {
    console.log("📺 Modalità LAN — QR basato su IP locale");
  }
  console.log("====================================================");
});
