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

// Traccia le visite alle pagine HTML (esclude solo superadmin)
app.use((req, res, next) => {
  if (req.method === "GET" && /\.html$/i.test(req.path) && req.path.toLowerCase() !== "/superadmin.html") {
    trackPageView();
  }
  next();
});

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
const QRCode = require("qrcode");
const nodemailer = require("nodemailer");

/* ==========================================================================
   EMAIL — Gmail transporter per notifiche
   ========================================================================== */
const GMAIL_USER = process.env.GMAIL_USER || "draftarena.official@gmail.com";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "";

const emailTransporter = GMAIL_APP_PASSWORD
  ? nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    })
  : null;

async function getContactEmail() {
  if (!supabase) return GMAIL_USER;
  try {
    const { data } = await supabase
      .from("platform_settings")
      .select("value")
      .eq("key", "contact_email")
      .maybeSingle();
    return (data && data.value) || GMAIL_USER;
  } catch (e) {
    return GMAIL_USER;
  }
}

async function sendNotificationEmail(subject, htmlBody) {
  if (!emailTransporter) {
    console.warn("[EMAIL] Transporter non configurato (GMAIL_APP_PASSWORD mancante). Email non inviata:", subject);
    return;
  }
  const to = await getContactEmail();
  try {
    await emailTransporter.sendMail({
      from: `DraftARENA <${GMAIL_USER}>`,
      to,
      subject,
      html: htmlBody,
    });
    console.log(`[EMAIL] Notifica inviata a ${to}: ${subject}`);
  } catch (e) {
    console.error("[EMAIL] Errore invio notifica:", e.message);
  }
}

/* ==========================================================================
   SUPABASE CLIENT
   ========================================================================== */
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const LOCAL_MODE = process.env.LOCAL_MODE === "true";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  if (!LOCAL_MODE) {
    console.error("[SERVER] ERRORE: variabili Supabase mancanti nel .env");
    process.exit(1);
  } else {
    console.warn("[SERVER] LOCAL_MODE attivo — nessun Supabase configurato, salvataggio su file locale.");
  }
}

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

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
  "P": "P", "POR": "P",
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
let pageViewsSinceStart = 0;
let pageViewsTotal = 0;
let pageViewsUnsaved = 0;
const PAGE_VIEWS_FLUSH_EVERY = 10;

async function loadPageViewsTotal() {
  if (!supabase) return;
  try {
    const { data } = await supabase.from("platform_settings").select("value").eq("key", "page_views_total").maybeSingle();
    if (data) pageViewsTotal = parseInt(data.value) || 0;
  } catch (e) {
    console.warn("[SERVER] Impossibile caricare page_views_total dal DB.");
  }
}

async function flushPageViews() {
  if (!supabase || pageViewsUnsaved === 0) return;
  try {
    await supabase.from("platform_settings").upsert(
      { key: "page_views_total", value: String(pageViewsTotal), updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
    pageViewsUnsaved = 0;
  } catch (e) {
    console.warn("[SERVER] Errore flush page_views_total:", e.message);
  }
}

function trackPageView() {
  pageViewsSinceStart++;
  pageViewsTotal++;
  pageViewsUnsaved++;
  if (pageViewsUnsaved >= PAGE_VIEWS_FLUSH_EVERY) flushPageViews();
}

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
    discardedPlayers: [],
    claimedTeams: {},
    CONFIG: JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
    auctionEnded: false
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
  const qrBase = host.startsWith("http") ? host : `http://${host}:3000`;
  const qrUrl = `${qrBase}/qr?data=${encodeURIComponent(phoneUrl)}`;
  return { url: phoneUrl, qr: qrUrl };
}

/* ==========================================================================
   SUPABASE — PERSISTENZA
   ========================================================================== */

/* ---------- helpers file locale (usati da LOCAL_MODE e come backup) ------- */

function salvaFileLocale(room) {
  try {
    const filePath = getSavePath(room.code, room.auctionName);
    const currentState = room.state.player ? {
      player: room.state.player,
      currentPrice: room.state.currentPrice,
      highestBidder: room.state.highestBidder
    } : null;
    fs.writeFileSync(filePath, JSON.stringify({
      adminPin: room.adminPin,
      auctionName: room.auctionName,
      teams: room.teams,
      playersList: room.playersList,
      soldPlayers: room.soldPlayers,
      discardedPlayers: room.discardedPlayers || [],
      CONFIG: room.CONFIG,
      settings: { timerDuration: room.state.timerDuration },
      currentState
    }, null, 2));
  } catch (e) {
    console.error(`[LOCAL] Errore salvataggio file ${room.code}:`, e.message);
  }
}

function caricaFileLocale(room) {
  const filePath = getSavePath(room.code, room.auctionName);
  if (!fs.existsSync(filePath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (data.adminPin) room.adminPin = data.adminPin;
    room.teams = data.teams || {};
    room.playersList = data.playersList || [];
    room.soldPlayers = data.soldPlayers || [];
    room.discardedPlayers = data.discardedPlayers || [];
    if (data.settings) room.state.timerDuration = parseInt(data.settings.timerDuration) || 10;
    if (data.CONFIG) room.CONFIG = data.CONFIG;
    if (data.currentState && data.currentState.player) {
      room.state.player = data.currentState.player;
      room.state.currentPrice = data.currentState.currentPrice || 0;
      room.state.highestBidder = data.currentState.highestBidder || null;
      room.state.time = room.state.timerDuration;
      room.state.isPaused = true;
      console.log(`[LOCAL] Stato asta ripristinato: ${data.currentState.player.nome} (in pausa)`);
    } else {
      room.state.player = null;
      room.state.time = room.state.timerDuration;
      room.state.highestBidder = null;
      room.state.isPaused = false;
    }
    console.log(`[LOCAL] File caricato per ${room.code}/${room.auctionName}`);
    return true;
  } catch (e) {
    return false;
  }
}

function trovaStanzaLocale(code) {
  const defaultPath = getSavePath(code, "default");
  if (fs.existsSync(defaultPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(defaultPath, "utf8"));
      return { code, admin_pin: data.adminPin || generateAdminPin(), host_url: null, auto_advance: true };
    } catch (e) {}
  }
  try {
    const files = fs.readdirSync(__dirname).filter(f => f.startsWith(`stanza_${code}_`) && f.endsWith(".json"));
    if (files.length > 0) {
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, files[0]), "utf8"));
      return { code, admin_pin: data.adminPin || generateAdminPin(), host_url: null, auto_advance: true };
    }
  } catch (e) {}
  return null;
}

/* ---------- funzioni principali ------------------------------------------ */

async function validateAccessCode(code) {
  if (LOCAL_MODE) return { valid: true, data: { type: "local" } };
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
  if (LOCAL_MODE) return;
  await supabase.rpc("increment_code_uses", { p_code: code });
}

async function salvaSessioneDB(room) {
  if (LOCAL_MODE) { salvaFileLocale(room); return; }
  const rc = room.code;
  const an = room.auctionName;

  try {
    // Aggiorna rooms
    await supabase.from("rooms")
      .update({ last_active: new Date().toISOString(), host_url: room.hostUrl, auto_advance: room.autoAdvance })
      .eq("code", rc);

    // Upsert auction_session config
    const currentState = room.state.player ? {
      player: room.state.player,
      currentPrice: room.state.currentPrice,
      highestBidder: room.state.highestBidder
    } : null;
    await supabase.from("auction_sessions")
      .upsert({ room_code: rc, auction_name: an, config: room.CONFIG, timer_duration: room.state.timerDuration, current_state: currentState, auction_ended: room.auctionEnded || false, updated_at: new Date().toISOString() }, { onConflict: "room_code,auction_name" });

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
        room_code: rc, auction_name: an, nome: p.nome, ruolo: p.ruolo, squadra: p.squadra || "Svincolato", player_id: p.id || null, is_discarded: false
      })), 500);
      for (const chunk of chunks) await supabase.from("players_list").insert(chunk);
    }
    if (room.discardedPlayers && room.discardedPlayers.length > 0) {
      const dChunks = chunkArray(room.discardedPlayers.map(p => ({
        room_code: rc, auction_name: an, nome: p.nome, ruolo: p.ruolo, squadra: p.squadra || "Svincolato", player_id: p.id || null, is_discarded: true
      })), 500);
      for (const ch of dChunks) await supabase.from("players_list").insert(ch);
    }

    // Cancella e reinserisci sold_players
    await supabase.from("sold_players").delete().eq("room_code", rc).eq("auction_name", an);
    if (room.soldPlayers.length > 0) {
      const soldRows = room.soldPlayers.map(sp => ({
        room_code: rc, auction_name: an, player_name: sp.player, ruolo: sp.ruolo,
        squadra: sp.squadra || "", winner: sp.winner, price: sp.price, reparto_assegnato: sp.repartoAssegnato, player_id: sp.id || null
      }));
      await supabase.from("sold_players").insert(soldRows);
    }
  } catch (e) {
    console.error(`[DB] Errore salvataggio stanza ${rc}:`, e.message);
  }
}

async function caricaSessioneDB(room) {
  if (LOCAL_MODE) return caricaFileLocale(room);
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
      room.auctionEnded = !!sessRes.data.auction_ended;
      const cs = sessRes.data.current_state;
      if (cs && cs.player) {
        room.state.player = cs.player;
        room.state.currentPrice = cs.currentPrice || 0;
        room.state.highestBidder = cs.highestBidder || null;
        room.state.time = room.state.timerDuration;
        room.state.isPaused = true;
        console.log(`[DB] Stato asta ripristinato: ${cs.player.nome} (in pausa)`);
      } else {
        room.state.player = null;
        room.state.time = room.state.timerDuration;
        room.state.highestBidder = null;
        room.state.isPaused = false;
      }
    } else {
      room.state.player = null;
      room.state.time = room.state.timerDuration;
      room.state.highestBidder = null;
      room.state.isPaused = false;
    }

    if (teamsRes.data && teamsRes.data.length > 0) {
      room.teams = {};
      teamsRes.data.forEach(t => {
        room.teams[t.team_key] = { name: t.team_name, budget: t.budget, slots: t.slots };
      });
    }

    if (playersRes.data) {
      room.playersList = playersRes.data.filter(p => !p.is_discarded).map(p => ({ nome: p.nome, ruolo: p.ruolo, squadra: p.squadra, id: p.player_id || "" }));
      room.discardedPlayers = playersRes.data.filter(p => p.is_discarded).map(p => ({ nome: p.nome, ruolo: p.ruolo, squadra: p.squadra, id: p.player_id || "" }));
    }

    if (soldRes.data) {
      room.soldPlayers = soldRes.data.map(sp => ({
        player: sp.player_name, ruolo: sp.ruolo, squadra: sp.squadra,
        winner: sp.winner, price: sp.price, repartoAssegnato: sp.reparto_assegnato, id: sp.player_id || ""
      }));
    }

    room.state.history = [];
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
  if (LOCAL_MODE) return;
  const { error } = await supabase.from("rooms").insert({
    code, admin_pin: adminPin, access_code: accessCode || null
  });
  if (error) throw new Error("Errore creazione stanza DB: " + error.message);
}

async function trovaStanzaDB(code) {
  if (LOCAL_MODE) return trovaStanzaLocale(code);
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
    repartoAssegnato: repartoScelto, id: p.id || ""
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
      const p = room.state.player;
      const playerName = p.nome;
      io.to(roomCode).emit("auctionEnded", { winner: null, player: playerName, price: 0 });
      // Sposta il giocatore non venduto nella lista scartati
      if (!room.discardedPlayers) room.discardedPlayers = [];
      if (!room.discardedPlayers.some(dp => dp.nome.toLowerCase() === p.nome.toLowerCase())) {
        room.discardedPlayers.push({ nome: p.nome, ruolo: p.ruolo, squadra: p.squadra, id: p.id || "" });
      }
      room.playersList = room.playersList.filter(item => item.nome !== p.nome);
      room.state.player = null;
      room.state.time = room.state.timerDuration;
      room.state.highestBidder = null;
      room.state.currentPrice = 0;
      io.to(roomCode).emit("update", room.state);
      io.to(roomCode).emit("playersList", room.playersList);
      io.to(roomCode).emit("discardedList", room.discardedPlayers);
      io.to(roomCode).emit("unsoldPaused");
      salvaSessioneDB(room);
      if (room.autoAdvance) {
        setTimeout(() => {
          const r = rooms.get(roomCode);
          if (r && !r.state.isPaused && r.autoAdvance) chiamaGiocatoreCasuale(roomCode);
        }, 3000);
      } else {
        room.state.isPaused = true;
        io.to(roomCode).emit("update", room.state);
      }
    }
  }
}

setInterval(() => {
  for (const roomCode of rooms.keys()) tickRoom(roomCode);
}, 1000);

/* ==========================================================================
   AUTO-SAVE PERIODICO (ogni 2 minuti)
   ========================================================================== */
setInterval(async () => {
  for (const [code, room] of rooms.entries()) {
    try {
      await salvaSessioneDB(room);
      // Notifica i socket admin connessi a questa stanza
      io.to(code).emit("autoSaved", { ts: new Date().toISOString() });
    } catch (e) {
      console.error(`[AUTO-SAVE] Errore per stanza ${code}:`, e.message);
    }
  }
}, 2 * 60 * 1000);

/* ==========================================================================
   SPEGNIMENTO GRACEFUL (salva tutto prima di uscire)
   ========================================================================== */
async function gracefulShutdown(signal) {
  console.log(`\n[SERVER] Ricevuto ${signal} — salvataggio di tutte le stanze attive...`);
  const saves = [];
  for (const room of rooms.values()) {
    saves.push(salvaSessioneDB(room).catch(e => console.error(`[SHUTDOWN] Errore ${room.code}:`, e.message)));
  }
  saves.push(flushPageViews().catch(e => console.error("[SHUTDOWN] Errore flush page views:", e.message)));
  await Promise.all(saves);
  console.log("[SERVER] Salvataggio completato. Uscita.");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

/* ==========================================================================
   ROTTE EXPRESS
   ========================================================================== */
app.get("/", (req, res) => { trackPageView(); res.sendFile(path.join(__dirname, "public", "index.html")); });
app.get("/admin", (req, res) => { trackPageView(); res.sendFile(path.join(__dirname, "public", "admin.html")); });
app.get("/admin-smart", (req, res) => { trackPageView(); res.sendFile(path.join(__dirname, "public", "admin-smart.html")); });
app.get("/host", (req, res) => { trackPageView(); res.sendFile(path.join(__dirname, "public", "host.html")); });
app.get("/host.html", (req, res) => res.sendFile(path.join(__dirname, "public", "host.html")));
app.get("/rose", (req, res) => { trackPageView(); res.sendFile(path.join(__dirname, "public", "rose.html")); });
app.get("/rose.html", (req, res) => res.sendFile(path.join(__dirname, "public", "rose.html")));
app.get("/superadmin", (req, res) => res.sendFile(path.join(__dirname, "public", "superadmin.html")));
app.get("/guida-admin", (req, res) => { trackPageView(); res.sendFile(path.join(__dirname, "public", "guida-admin.html")); });
app.get("/guida-utenti", (req, res) => { trackPageView(); res.sendFile(path.join(__dirname, "public", "guida-utenti.html")); });
app.get("/video", (req, res) => { trackPageView(); res.sendFile(path.join(__dirname, "public", "video.html")); });
app.get("/feedback", (req, res) => { trackPageView(); res.sendFile(path.join(__dirname, "public", "feedback.html")); });
app.get("/richiesta-codice", (req, res) => { trackPageView(); res.sendFile(path.join(__dirname, "public", "richiesta-codice.html")); });

/* ==========================================================================
   PLATFORM SETTINGS (pubblica lettura)
   ========================================================================== */
app.get("/api/platform-settings", async (req, res) => {
  if (!supabase) return res.json({});
  try {
    const { data, error } = await supabase.from("platform_settings").select("key, value");
    if (error) throw error;
    const result = {};
    (data || []).forEach(row => { result[row.key] = row.value; });
    res.json(result);
  } catch (e) {
    res.status(500).json({});
  }
});

app.get("/api/contact-email", async (req, res) => {
  const email = await getContactEmail();
  res.json({ email });
});

app.post("/api/superadmin/platform-settings", async (req, res) => {
  const { password, settings } = req.body;
  if (password !== SUPERADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Password errata." });
  }
  if (!supabase) return res.json({ success: true });
  try {
    const rows = Object.entries(settings).map(([key, value]) => ({
      key, value: String(value), updated_at: new Date().toISOString()
    }));
    const { error } = await supabase.from("platform_settings").upsert(rows, { onConflict: "key" });
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ==========================================================================
   SITE TEXTS — testi modificabili del sito
   ========================================================================== */
app.get("/api/site-texts", async (req, res) => {
  if (!supabase) return res.json({});
  const page = String(req.query.page || "homepage");
  try {
    const { data, error } = await supabase
      .from("site_texts")
      .select("lang, key, value")
      .eq("page", page);
    if (error) throw error;
    const result = {};
    (data || []).forEach(row => {
      if (!result[row.lang]) result[row.lang] = {};
      result[row.lang][row.key] = row.value;
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({});
  }
});

app.get("/api/superadmin/site-texts", async (req, res) => {
  if (!supabase) return res.json({ success: true, texts: {} });
  const page = String(req.query.page || "homepage");
  try {
    const { data, error } = await supabase
      .from("site_texts")
      .select("lang, key, value, updated_at")
      .eq("page", page);
    if (error) throw error;
    const result = {};
    (data || []).forEach(row => {
      if (!result[row.lang]) result[row.lang] = {};
      result[row.lang][row.key] = { value: row.value, updated_at: row.updated_at };
    });
    res.json({ success: true, texts: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/superadmin/site-texts", async (req, res) => {
  const { password, page, lang, texts } = req.body;
  if (password !== SUPERADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Password errata." });
  }
  if (!supabase) return res.json({ success: true });
  if (!page || !lang || !texts || typeof texts !== "object") {
    return res.status(400).json({ success: false, error: "Parametri mancanti." });
  }
  try {
    const rows = Object.entries(texts).map(([key, value]) => ({
      page, lang, key, value: String(value), updated_at: new Date().toISOString()
    }));
    if (rows.length > 0) {
      const { error } = await supabase
        .from("site_texts")
        .upsert(rows, { onConflict: "page,lang,key" });
      if (error) throw error;
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/superadmin/site-texts/reset", async (req, res) => {
  const { password, page, lang, key } = req.body;
  if (password !== SUPERADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Password errata." });
  }
  if (!supabase) return res.json({ success: true });
  try {
    let query = supabase.from("site_texts").delete().eq("page", page || "homepage");
    if (lang) query = query.eq("lang", lang);
    if (key) query = query.eq("key", key);
    const { error } = await query;
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ==========================================================================
   RICHIESTE CODICI
   ========================================================================== */
app.post("/api/richiesta-codice", async (req, res) => {
  if (!supabase) return res.json({ success: true });
  const { nome, cognome, email, nome_lega, num_squadre, piattaforma, telefono, come_trovato } = req.body;
  if (!nome || !email || !nome_lega) {
    return res.status(400).json({ success: false, error: "Campi obbligatori mancanti." });
  }
  try {
    // Verifica se esiste già una richiesta con questa email
    const { data: existing } = await supabase
      .from("code_requests")
      .select("codice_assegnato")
      .eq("email", String(email).trim().toLowerCase())
      .maybeSingle();

    let assignedCode = existing?.codice_assegnato || null;

    // Se non esiste, genera un nuovo codice e registralo
    if (!assignedCode) {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let newCode = "DRAFT-";
      for (let i = 0; i < 6; i++) newCode += chars[Math.floor(Math.random() * chars.length)];

      // Inserisci il codice in access_codes (utile per creare stanze)
      const { error: codeErr } = await supabase.from("access_codes").insert({
        code: newCode,
        type: "promo",
        max_uses: null,
        expires_at: null,
        note: `Auto-generato per ${nome} ${cognome || ''} (${email})`,
        is_active: true
      });
      if (codeErr) throw codeErr;

      assignedCode = newCode;

      // Salva la richiesta con il codice assegnato
      const { error } = await supabase.from("code_requests").insert({
        nome: String(nome).trim().slice(0, 80),
        cognome: cognome ? String(cognome).trim().slice(0, 80) : null,
        email: String(email).trim().slice(0, 200),
        nome_lega: String(nome_lega).trim().slice(0, 200),
        num_squadre: num_squadre ? parseInt(num_squadre) : null,
        piattaforma: piattaforma ? String(piattaforma).trim().slice(0, 100) : null,
        telefono: telefono ? String(telefono).trim().slice(0, 50) : null,
        come_trovato: come_trovato ? String(come_trovato).trim().slice(0, 500) : null,
        codice_assegnato: assignedCode
      });
      if (error) throw error;
    }

    // Invia notifica email alla casella di DraftARENA
    const fullName = `${nome}${cognome ? ' ' + cognome : ''}`;
    sendNotificationEmail(
      `Nuova richiesta codice — ${fullName}`,
      `<h2>Nuova richiesta codice di accesso</h2>
      <table style="border-collapse:collapse;font-size:14px;font-family:sans-serif;">
        <tr><td style="padding:4px 12px;color:#64748b;">Nome:</td><td style="padding:4px 12px;">${fullName}</td></tr>
        <tr><td style="padding:4px 12px;color:#64748b;">Email:</td><td style="padding:4px 12px;">${email}</td></tr>
        <tr><td style="padding:4px 12px;color:#64748b;">Lega:</td><td style="padding:4px 12px;">${nome_lega}</td></tr>
        <tr><td style="padding:4px 12px;color:#64748b;">Squadre:</td><td style="padding:4px 12px;">${num_squadre || '—'}</td></tr>
        <tr><td style="padding:4px 12px;color:#64748b;">Piattaforma:</td><td style="padding:4px 12px;">${piattaforma || '—'}</td></tr>
        <tr><td style="padding:4px 12px;color:#64748b;">Come trovati:</td><td style="padding:4px 12px;">${come_trovato || '—'}</td></tr>
        <tr><td style="padding:4px 12px;color:#64748b;">Codice assegnato:</td><td style="padding:4px 12px;font-weight:700;color:#2563eb;">${assignedCode}</td></tr>
      </table>`
    ).catch(() => {});

    res.json({ success: true, code: assignedCode, alreadyExists: !!existing });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/superadmin/requests", async (req, res) => {
  if (!supabase) return res.json({ success: true, requests: [] });
  try {
    const { data, error } = await supabase
      .from("code_requests")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, requests: data || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ==========================================================================
   SUPERADMIN PASSWORD (caricata da DB, fallback env)
   ========================================================================== */
let SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || "DraftArena2025!";

async function loadSuperadminPassword() {
  try {
    const { data } = await supabase.from("platform_settings").select("value").eq("key", "superadmin_password").maybeSingle();
    if (data) SUPERADMIN_PASSWORD = data.value;
  } catch (e) {
    console.warn("[SERVER] Impossibile caricare password superadmin da DB, uso default.");
  }
}

/* ==========================================================================
   API CODICI ACCESSO (solo superadmin)
   ========================================================================== */

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

app.post("/api/superadmin/change-password", async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (currentPassword !== SUPERADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Password corrente errata." });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ success: false, error: "La nuova password deve avere almeno 6 caratteri." });
  }
  SUPERADMIN_PASSWORD = newPassword;
  await supabase.from("platform_settings").upsert(
    { key: "superadmin_password", value: newPassword, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  res.json({ success: true });
});

app.get("/api/superadmin/rooms", async (req, res) => {
  const { data, error } = await supabase.from("rooms").select("*").order("created_at", { ascending: false }).limit(50);
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, rooms: data });
});

app.get("/api/superadmin/stats", (req, res) => {
  const allSockets = io.sockets.sockets;
  let landingViewers = 0;
  allSockets.forEach(s => {
    if (s.isViewingLanding && !s.roomCode) landingViewers++;
  });

  let totalInRooms = 0;
  const activeRooms = [];
  for (const [code, room] of rooms.entries()) {
    const roomSockets = io.sockets.adapter.rooms.get(code);
    const count = roomSockets ? roomSockets.size : 0;
    if (count > 0) {
      activeRooms.push({ code, count, auctionName: room.auctionName, teams: Object.keys(room.teams).length });
      totalInRooms += count;
    }
  }

  res.json({
    success: true,
    landingViewers,
    totalInRooms,
    activeRooms,
    activeRoomsCount: activeRooms.length,
    pageViewsSinceStart,
    pageViewsTotal,
    totalSockets: allSockets.size
  });
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

const FREE_TIER_TEAM_LIMIT = 8;

app.get("/api/room/create", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  if (rateLimit(ip, 5)) return res.status(429).json({ success: false, error: "Troppe richieste. Riprova tra un minuto." });

  const accessCode = String(req.query.accessCode || "").trim().toUpperCase();
  const teamCount = parseInt(req.query.teamCount) || 0;
  const isFree = teamCount > 0 && teamCount <= FREE_TIER_TEAM_LIMIT;

  try {
    let codeType = "free";
    if (!isFree) {
      const validation = await validateAccessCode(accessCode);
      if (!validation.valid) return res.status(403).json({ success: false, error: validation.error });
      codeType = validation.data.type;
      if (codeType !== "superadmin") await incrementCodeUses(accessCode);
    }

    let code;
    let attempts = 0;
    do { code = generateRoomCode(); attempts++; } while (rooms.has(code) && attempts < 30);

    const adminPin = generateAdminPin();
    await creaStanzaDB(code, adminPin, isFree ? null : accessCode);

    const room = createRoomData(code, adminPin);
    rooms.set(code, room);

    console.log(`[SERVER] Stanza creata: ${code} (${isFree ? `free, ${teamCount} squadre` : `codice: ${accessCode}`})`);
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
   QR CODE LOCALE (non richiede connessione internet)
   ========================================================================== */
app.get("/qr", async (req, res) => {
  try {
    const data = req.query.data || "";
    const buffer = await QRCode.toBuffer(data, { width: 200, margin: 2, color: { dark: "#000000", light: "#ffffff" } });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(buffer);
  } catch (e) {
    res.status(500).send("Errore QR");
  }
});

/* ==========================================================================
   UPLOAD EXCEL
   ========================================================================== */
// Preview colonne Excel — restituisce le prime righe per far scegliere all'utente quale colonna è il valore
app.post("/preview-columns", upload.single("file"), async (req, res) => {
  if (!req.file) {
    console.error("[SERVER] preview-columns: nessun file ricevuto da multer");
    return res.status(400).json({ success: false, error: "Nessun file caricato. Verifica che il file non sia vuoto e riprova." });
  }
  console.log("[SERVER] preview-columns: file ricevuto:", req.file.originalname, "size:", req.file.size, "path:", req.file.path);
  try {
    const workbook = xlsx.readFile(req.file.path, { cellDates: true, cellNF: false, cellText: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const matrix = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    // Trova la riga di intestazione (prime 5 righe)
    let headerRow = -1;
    const detected = { nome: -1, ruolo: -1, squadra: -1, valore: -1, id: -1 };
    for (let r = 0; r < Math.min(5, matrix.length); r++) {
      const row = matrix[r];
      for (let c = 0; c < row.length; c++) {
        const v = String(row[c]).toLowerCase().trim();
        if (["nome", "calciatore", "giocatore", "rilancio"].includes(v) && detected.nome === -1) detected.nome = c;
        if (["ruolo", "rm", "r", "ruolo mantra"].includes(v) && detected.ruolo === -1) detected.ruolo = c;
        if (["squadra", "club", "team", "squadra di a"].includes(v) && detected.squadra === -1) detected.squadra = c;
        if (["valore", "quotazione", "prezzo", "qt", "costo"].includes(v) && detected.valore === -1) detected.valore = c;
        if (["id", "id giocatore", "idgiocatore", "codice", "code"].includes(v) && detected.id === -1) detected.id = c;
      }
      if (detected.nome !== -1 && detected.ruolo !== -1) { headerRow = r; break; }
    }

    // Se nessuna intestazione trovata, usa la prima riga
    if (headerRow === -1) headerRow = 0;

    const headers = (matrix[headerRow] || []).map((v, i) => ({
      index: i,
      name: String(v || `Colonna ${i + 1}`),
      detectedAs: i === detected.nome ? "nome" : i === detected.ruolo ? "ruolo" : i === detected.squadra ? "squadra" : i === detected.valore ? "valore" : i === detected.id ? "id" : null
    }));

    // Prime 3 righe di dati per anteprima
    const sampleRows = [];
    for (let r = headerRow + 1; r < Math.min(headerRow + 4, matrix.length); r++) {
      sampleRows.push(matrix[r] || []);
    }

    res.json({ success: true, headerRow, headers, sampleRows, detected });
  } catch (e) {
    console.error("[SERVER] Errore preview colonne:", e);
    res.status(500).json({ success: false, error: "Errore nella lettura del file: " + e.message });
  } finally {
    if (req.file && req.file.path) {
      try { require("fs").unlinkSync(req.file.path); } catch(_) {}
    }
  }
});

app.post("/upload", upload.single("file"), async (req, res) => {
  const roomCode = String(req.query.room || "").toUpperCase().trim();
  const room = rooms.get(roomCode);
  if (!room) return res.status(400).send("Stanza non trovata");
  if (!req.file) return res.status(400).send("Nessun file caricato");

  const modeRiparazione = req.query.mode === "riparazione";

  try {
    const workbook = xlsx.readFile(req.file.path, { cellDates: true, cellNF: false, cellText: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const matrix = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    let rigaIntestazione = -1, indexNome = -1, indexRuolo = -1, indexSquadra = -1, indexPrezzo = -1, indexId = -1;

    for (let r = 0; r < matrix.length; r++) {
      const row = matrix[r];
      for (let c = 0; c < row.length; c++) {
        const v = String(row[c]).toLowerCase().trim();
        if (["nome", "calciatore", "giocatore", "rilancio"].includes(v)) indexNome = c;
        if (["ruolo", "rm", "r", "ruolo mantra"].includes(v)) indexRuolo = c;
        if (["squadra", "club", "team", "squadra di a"].includes(v)) indexSquadra = c;
        if (["valore", "quotazione", "prezzo", "qt", "costo"].includes(v)) indexPrezzo = c;
        if (["id", "id giocatore", "idgiocatore", "codice", "code"].includes(v)) indexId = c;
      }
      if (indexNome !== -1 && indexRuolo !== -1) { rigaIntestazione = r; break; }
    }

    if (rigaIntestazione === -1) {
      indexNome = 0; indexRuolo = 1; indexSquadra = 2; indexPrezzo = 3; rigaIntestazione = 0;
    }

    // Override manuale della colonna valore (da query string)
    const manualValueCol = req.query.valueCol !== undefined ? parseInt(req.query.valueCol) : null;
    if (manualValueCol !== null && !isNaN(manualValueCol)) {
      indexPrezzo = manualValueCol;
    }

    const sogliaMinima = parseInt(req.query.soglia) || 0;

    // Costruisce la lista dal file Excel
    const fromFile = [];
    for (let r = rigaIntestazione + 1; r < matrix.length; r++) {
      const row = matrix[r];
      if (!row || row.length === 0) continue;
      const nome = row[indexNome] ? String(row[indexNome]).trim() : "";
      const ruolo = row[indexRuolo] ? String(row[indexRuolo]).trim() : "";
      const squadra = indexSquadra !== -1 && row[indexSquadra] ? String(row[indexSquadra]).trim() : "Svincolato";
      const valoreEffettivo = indexPrezzo !== -1 && row[indexPrezzo] ? parseInt(row[indexPrezzo]) : 1;
      const playerId = indexId !== -1 && row[indexId] ? String(row[indexId]).trim() : "";
      if (valoreEffettivo < sogliaMinima) continue;
      if (nome && ruolo) fromFile.push({ nome, ruolo: ruolo.toUpperCase(), squadra, id: playerId, valore: valoreEffettivo });
    }

    let alreadySold = 0, alreadyInList = 0;

    if (modeRiparazione) {
      // Insiemi di nomi già presenti (lowercase per confronto case-insensitive)
      const soldNames = new Set(room.soldPlayers.map(p => p.player.toLowerCase().trim()));
      const listNames = new Set(room.playersList.map(p => p.nome.toLowerCase().trim()));

      for (const p of fromFile) {
        const key = p.nome.toLowerCase().trim();
        if (soldNames.has(key)) { alreadySold++; continue; }
        if (listNames.has(key)) { alreadyInList++; continue; }
        room.playersList.push(p);
        listNames.add(key); // evita duplicati all'interno dello stesso file
      }
    } else {
      room.playersList = fromFile;
    }

    const warnings = [];
    room.playersList.forEach(p => {
      const tokens = p.ruolo.split(/[\s,;\-]+/).map(t => t.trim()).filter(Boolean);
      const unknown = tokens.filter(t => !MANTRA_MAP[t]);
      if (unknown.length > 0) warnings.push({ nome: p.nome, ruolo: p.ruolo, squadra: p.squadra, tokensIgnorati: unknown });
    });

    await salvaSessioneDB(room);
    io.to(roomCode).emit("playersList", room.playersList);
    io.to(roomCode).emit("discardedList", room.discardedPlayers || []);
    res.json({
      success: true,
      count: room.playersList.length,
      warnings,
      riparazione: modeRiparazione ? { alreadySold, alreadyInList, added: fromFile.length - alreadySold - alreadyInList } : null
    });
  } catch (e) {
    console.error("[SERVER] Errore parsing Excel:", e);
    res.status(500).send("Errore nel parsing del file Excel: " + e.message);
  } finally {
    if (req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch(_) {}
    }
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

// GET /export-csv?room=CODE → CSV con squadra,idgiocatore,prezzo separato da righe $,$,$
app.get("/export-csv", (req, res) => {
  const roomCode = String(req.query.room || "").toUpperCase().trim();
  const room = rooms.get(roomCode);
  if (!room) return res.status(404).send("Stanza non trovata.");

  try {
    const teamKeys = Object.keys(room.teams);
    let csv = "$,$,$\n";

    for (const key of teamKeys) {
      const squadra = room.teams[key];
      const acquisti = room.soldPlayers.filter(p =>
        p.winner.toLowerCase().trim() === squadra.name.toLowerCase().trim()
      );

      for (const sp of acquisti) {
        const playerId = sp.id || "";
        const prezzo = sp.price || 0;
        csv += `${squadra.name},${playerId},${prezzo}\n`;
      }

      if (teamKeys.indexOf(key) < teamKeys.length - 1) {
        csv += "$,$,$\n";
      }
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=asta_${roomCode}.csv`);
    res.send(csv);
  } catch (e) {
    console.error("[SERVER] Errore export CSV:", e);
    res.status(500).send("Errore durante la generazione del file CSV.");
  }
});

/* ==========================================================================
   BACKUP STORICI — REST API
   ========================================================================== */

// GET /api/room/:code/backups  → lista backup per rose.html (pubblica)
app.get("/api/room/:code/backups", async (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();
  if (LOCAL_MODE) return res.json({ success: true, backups: [] });
  try {
    const { data, error } = await supabase
      .from("auction_backups")
      .select("id, year, auction_name, label, exported_at")
      .eq("room_code", code)
      .order("year", { ascending: false });
    if (error) throw error;
    res.json({ success: true, backups: data || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/room/:code/backups/:id  → dati completi di un backup
app.get("/api/room/:code/backups/:id", async (req, res) => {
  if (LOCAL_MODE) return res.status(404).json({ success: false, error: "Non disponibile in LOCAL_MODE" });
  try {
    const { data, error } = await supabase
      .from("auction_backups")
      .select("*")
      .eq("id", req.params.id)
      .eq("room_code", String(req.params.code).toUpperCase().trim())
      .single();
    if (error || !data) return res.status(404).json({ success: false, error: "Backup non trovato" });
    res.json({ success: true, backup: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/room/:code/backups/:id  → elimina un backup (solo con pin admin in header)
app.delete("/api/room/:code/backups/:id", async (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();
  const room = rooms.get(code);
  const pin = String(req.headers["x-admin-pin"] || "");
  if (!room || String(room.adminPin) !== pin) {
    return res.status(403).json({ success: false, error: "PIN admin non valido." });
  }
  if (LOCAL_MODE) return res.json({ success: true });
  try {
    const { error } = await supabase
      .from("auction_backups")
      .delete()
      .eq("id", req.params.id)
      .eq("room_code", code);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ==========================================================================
   IMPORT DA STANZA PRECEDENTE (nuova stagione collegata)
   ========================================================================== */

// GET /api/legacy/:code/overview → verifica se la stanza vecchia esiste e restituisce un riepilogo
app.get("/api/legacy/:code/overview", async (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();
  if (LOCAL_MODE) return res.json({ success: false, error: "Non disponibile in LOCAL_MODE" });
  try {
    const dbRoom = await trovaStanzaDB(code);
    if (!dbRoom) return res.json({ success: false, error: "Stanza non trovata." });

    // Conta i backup storici
    const { data: backups, error: bErr } = await supabase
      .from("auction_backups")
      .select("id, year, label, auction_name, exported_at")
      .eq("room_code", code)
      .order("year", { ascending: false });
    if (bErr) throw bErr;

    // Prova a caricare la sessione "default" per vedere se ci sono dati asta
    const tmpRoom = createRoomData(code, dbRoom.admin_pin);
    const loaded = await caricaSessioneDB(tmpRoom);

    res.json({
      success: true,
      roomCode: code,
      hasAuctionData: loaded && (tmpRoom.teams.length > 0 || Object.keys(tmpRoom.teams).length > 0 || tmpRoom.soldPlayers.length > 0),
      teamCount: Object.keys(tmpRoom.teams).length,
      soldCount: tmpRoom.soldPlayers.length,
      playerListCount: tmpRoom.playersList.length,
      backups: backups || [],
      backupCount: (backups || []).length
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/legacy/:code/export → scarica il backup JSON completo della sessione "default" della stanza vecchia
app.get("/api/legacy/:code/export", async (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();
  if (LOCAL_MODE) return res.status(400).json({ success: false, error: "Non disponibile in LOCAL_MODE" });
  try {
    const dbRoom = await trovaStanzaDB(code);
    if (!dbRoom) return res.status(404).json({ success: false, error: "Stanza non trovata." });

    const tmpRoom = createRoomData(code, dbRoom.admin_pin);
    await caricaSessioneDB(tmpRoom);

    const year = parseInt(req.query.year) || new Date().getFullYear();
    const label = String(req.query.label || "").trim() || `Asta ${year}`;

    const teamsArray = Object.entries(tmpRoom.teams).map(([key, t]) => ({
      key, name: t.name, finalBudget: t.budget, slots: t.slots
    }));

    const backup = {
      version: 1,
      app: "DraftARENA",
      year,
      label,
      exportedAt: new Date().toISOString(),
      auctionName: tmpRoom.auctionName,
      config: tmpRoom.CONFIG,
      timerDuration: tmpRoom.state.timerDuration,
      teams: teamsArray,
      soldPlayers: tmpRoom.soldPlayers,
      unsoldPlayers: tmpRoom.playersList
    };

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename=DraftARENA_backup_${code}_${year}.json`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/legacy/:oldCode/import-albo → copia tutti i backup storici dalla stanza vecchia a quella corrente
// Richiede x-admin-pin della stanza CORRENTE (in cui si sta importando)
app.post("/api/legacy/:oldCode/import-albo", async (req, res) => {
  const oldCode = String(req.params.oldCode).toUpperCase().trim();
  const newCode = String(req.body.newCode || "").toUpperCase().trim();
  if (!newCode) return res.status(400).json({ success: false, error: "Codice nuova stanza mancante." });

  const room = rooms.get(newCode);
  const pin = String(req.headers["x-admin-pin"] || "");
  if (!room || String(room.adminPin) !== pin) {
    return res.status(403).json({ success: false, error: "PIN admin non valido." });
  }
  if (LOCAL_MODE) return res.json({ success: true, copied: 0 });
  if (oldCode === newCode) return res.status(400).json({ success: false, error: "La stanza di destinazione deve essere diversa da quella di origine." });

  try {
    const { data: oldBackups, error } = await supabase
      .from("auction_backups")
      .select("*")
      .eq("room_code", oldCode);
    if (error) throw error;
    if (!oldBackups || oldBackups.length === 0) {
      return res.json({ success: true, copied: 0, message: "Nessun backup storico nella stanza di origine." });
    }

    // Controlla quali backup esistono già nella stanza nuova (per anno+label) per evitare duplicati
    const { data: existing } = await supabase
      .from("auction_backups")
      .select("year, label, auction_name")
      .eq("room_code", newCode);
    const existingKeys = new Set((existing || []).map(b => `${b.year}|${b.label}|${b.auction_name}`));

    const toInsert = oldBackups
      .filter(b => !existingKeys.has(`${b.year}|${b.label}|${b.auction_name}`))
      .map(b => ({
        room_code: newCode,
        year: b.year,
        auction_name: b.auction_name,
        label: b.label,
        backup_data: b.backup_data,
        season_data: b.season_data,
        exported_at: b.exported_at
      }));

    if (toInsert.length > 0) {
      const { error: insErr } = await supabase.from("auction_backups").insert(toInsert);
      if (insErr) throw insErr;
    }

    // Copia anche trophy_config e team_aliases se esistenti
    const { data: trophyCfg } = await supabase
      .from("trophy_config")
      .select("competitions")
      .eq("room_code", oldCode)
      .maybeSingle();
    if (trophyCfg && trophyCfg.competitions) {
      await supabase.from("trophy_config")
        .upsert({ room_code: newCode, competitions: trophyCfg.competitions, updated_at: new Date().toISOString() }, { onConflict: "room_code" });
    }

    const { data: oldAliases } = await supabase
      .from("team_aliases")
      .select("canonical_name, aliases")
      .eq("room_code", oldCode);
    if (oldAliases && oldAliases.length > 0) {
      const aliasRows = oldAliases.map(a => ({
        room_code: newCode,
        canonical_name: a.canonical_name,
        aliases: a.aliases
      }));
      await supabase.from("team_aliases").insert(aliasRows);
    }

    res.json({ success: true, copied: toInsert.length, skipped: oldBackups.length - toInsert.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ==========================================================================
   ALBO D'ORO
   ========================================================================== */

app.get("/albo", (req, res) => { trackPageView(); res.sendFile(path.join(__dirname, "public", "albo.html")); });
app.get("/albo.html", (req, res) => res.sendFile(path.join(__dirname, "public", "albo.html")));

// GET /api/lega/:code/albo  → tutte le stagioni con season_data (pubblica)
app.get("/api/lega/:code/albo", async (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();
  if (LOCAL_MODE) return res.json({ success: true, seasons: [] });
  try {
    const { data, error } = await supabase
      .from("auction_backups")
      .select("id, year, label, auction_name, exported_at, backup_data, season_data")
      .eq("room_code", code)
      .order("year", { ascending: false });
    if (error) throw error;
    res.json({ success: true, seasons: data || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/room/:code/albo/stagione  → crea una stagione storica manuale (richiede x-admin-pin)
app.post("/api/room/:code/albo/stagione", async (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();
  const room = rooms.get(code);
  const pin = String(req.headers["x-admin-pin"] || "");
  if (!room || String(room.adminPin) !== pin) {
    return res.status(403).json({ success: false, error: "PIN admin non valido." });
  }
  if (LOCAL_MODE) return res.json({ success: true, id: "local" });

  const { year, label, classifica, competizioni } = req.body;
  if (!year || !label) return res.status(400).json({ success: false, error: "Anno e nome stagione obbligatori." });
  if (!Array.isArray(classifica) || classifica.length === 0) {
    return res.status(400).json({ success: false, error: "Classifica non valida." });
  }
  const comps = Array.isArray(competizioni) ? competizioni : [];

  try {
    const teamsStub = classifica
      .filter(c => c && c.nome && c.nome.trim())
      .map(c => ({ name: String(c.nome).trim().slice(0, 80), presidente: String(c.presidente || "").trim().slice(0, 80) }));
    const { data, error } = await supabase.from("auction_backups").insert({
      room_code: code,
      year: parseInt(year),
      auction_name: "storico",
      label: String(label).trim().slice(0, 120),
      backup_data: { app: "DraftARENA", version: 1, teams: teamsStub },
      season_data: {
        classifica: classifica.map((c, i) => ({
          pos: i + 1,
          nome: String(c.nome || "").trim().slice(0, 80),
          presidente: c.presidente ? String(c.presidente).trim().slice(0, 80) : null,
          punti: c.punti != null && c.punti !== "" ? Number(c.punti) : null,
          trofeo: c.trofeo ? String(c.trofeo).trim().slice(0, 80) : null,
          altro: c.altro ? String(c.altro).trim().slice(0, 120) : null
        })).filter(c => c.nome),
        competizioni: comps.map(c => ({
          id: c.id || Date.now() + Math.random(),
          emoji: c.emoji || "🏅",
          nome: String(c.nome || "").trim().slice(0, 80),
          vincitore: c.vincitore ? String(c.vincitore).trim().slice(0, 80) : null
        })).filter(c => c.nome)
      }
    }).select("id").single();
    if (error) throw error;
    res.json({ success: true, id: data.id });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/room/:code/albo/stagione/:id  → elimina una stagione storica manuale (richiede x-admin-pin)
app.delete("/api/room/:code/albo/stagione/:id", async (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();
  const room = rooms.get(code);
  const pin = String(req.headers["x-admin-pin"] || "");
  if (!room || String(room.adminPin) !== pin) {
    return res.status(403).json({ success: false, error: "PIN admin non valido." });
  }
  if (LOCAL_MODE) return res.json({ success: true });
  try {
    const { error } = await supabase.from("auction_backups")
      .delete()
      .eq("id", req.params.id)
      .eq("room_code", code)
      .eq("auction_name", "storico");
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /api/room/:code/backups/:id/season  → aggiorna season_data (richiede x-admin-pin)
app.patch("/api/room/:code/backups/:id/season", async (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();
  const room = rooms.get(code);
  const pin = String(req.headers["x-admin-pin"] || "");
  if (!room || String(room.adminPin) !== pin) {
    return res.status(403).json({ success: false, error: "PIN admin non valido." });
  }
  if (LOCAL_MODE) return res.json({ success: true });

  const { classifica, competizioni } = req.body;
  if (!Array.isArray(classifica) || !Array.isArray(competizioni)) {
    return res.status(400).json({ success: false, error: "Dati stagione non validi." });
  }

  try {
    const { error } = await supabase
      .from("auction_backups")
      .update({ season_data: { classifica, competizioni } })
      .eq("id", req.params.id)
      .eq("room_code", code);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ==========================================================================
   TROPHY CONFIG & TEAM ALIASES (Classifica Trofei Generale)
   ========================================================================== */

// GET /api/lega/:code/trophy-config  → leggi config coppe (pubblico)
app.get("/api/lega/:code/trophy-config", async (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();
  if (LOCAL_MODE || !supabase) return res.json({ success: true, config: getDefaultTrophyConfig() });
  try {
    const { data, error } = await supabase
      .from("trophy_config")
      .select("competitions")
      .eq("room_code", code)
      .maybeSingle();
    if (error) throw error;
    res.json({ success: true, config: (data && data.competitions) ? data.competitions : getDefaultTrophyConfig() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/room/:code/trophy-config  → salva config coppe (richiede x-admin-pin)
app.put("/api/room/:code/trophy-config", async (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();
  const room = rooms.get(code);
  const pin = String(req.headers["x-admin-pin"] || "");
  if (!room || String(room.adminPin) !== pin) {
    return res.status(403).json({ success: false, error: "PIN admin non valido." });
  }
  if (LOCAL_MODE || !supabase) return res.json({ success: true });
  const { competitions } = req.body;
  if (!Array.isArray(competitions)) {
    return res.status(400).json({ success: false, error: "Configurazione competizioni non valida." });
  }
  const clean = competitions.map(c => ({
    id: String(c.id || "").trim().slice(0, 40),
    name: String(c.name || "").trim().slice(0, 80),
    emoji: String(c.emoji || "🏅").slice(0, 10),
    points: parseInt(c.points) || 0,
    priority: parseInt(c.priority) || 99
  })).filter(c => c.name);
  try {
    const { error } = await supabase
      .from("trophy_config")
      .upsert({ room_code: code, competitions: clean, updated_at: new Date().toISOString() }, { onConflict: "room_code" });
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/lega/:code/team-aliases  → leggi alias squadre (pubblico)
app.get("/api/lega/:code/team-aliases", async (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();
  if (LOCAL_MODE || !supabase) return res.json({ success: true, aliases: [] });
  try {
    const { data, error } = await supabase
      .from("team_aliases")
      .select("id, canonical_name, aliases")
      .eq("room_code", code)
      .order("canonical_name", { ascending: true });
    if (error) throw error;
    res.json({ success: true, aliases: data || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/room/:code/team-aliases  → salva tutte le alias (richiede x-admin-pin)
app.put("/api/room/:code/team-aliases", async (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();
  const room = rooms.get(code);
  const pin = String(req.headers["x-admin-pin"] || "");
  if (!room || String(room.adminPin) !== pin) {
    return res.status(403).json({ success: false, error: "PIN admin non valido." });
  }
  if (LOCAL_MODE || !supabase) return res.json({ success: true });
  const { aliases } = req.body;
  if (!Array.isArray(aliases)) {
    return res.status(400).json({ success: false, error: "Dati alias non validi." });
  }
  try {
    // Delete existing, then insert fresh
    await supabase.from("team_aliases").delete().eq("room_code", code);
    const rows = aliases
      .filter(a => a.canonical_name && String(a.canonical_name).trim())
      .map(a => ({
        room_code: code,
        canonical_name: String(a.canonical_name).trim().slice(0, 80),
        aliases: Array.isArray(a.aliases) ? a.aliases.map(x => String(x).trim().slice(0, 80)).filter(x => x) : [],
        updated_at: new Date().toISOString()
      }));
    if (rows.length > 0) {
      const { error } = await supabase.from("team_aliases").insert(rows);
      if (error) throw error;
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

function getDefaultTrophyConfig() {
  return [
    { id: "campionato", name: "Campionato", emoji: "🏆", points: 100, priority: 1 },
    { id: "champions",  name: "Champion's League", emoji: "⭐", points: 40, priority: 2 },
    { id: "coppaitalia",name: "Coppa Italia", emoji: "🥈", points: 20, priority: 3 },
    { id: "coppachiappe",name:"Coppa Chiappe", emoji: "🥿", points: 10, priority: 4 }
  ];
}

/* ==========================================================================
   FEEDBACK & SUPPORTO
   ========================================================================== */

/* GET pubblico — feedback approvati e pubblici (per la homepage) */
app.get("/api/feedback/pubblici", async (req, res) => {
  if (!supabase) return res.json({ success: true, feedback: [] });
  try {
    const { data, error } = await supabase
      .from("feedback_submissions")
      .select("id, nome, voto, messaggio, approved_at")
      .eq("status", "approved")
      .eq("visibilita", "pubblico")
      .order("approved_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json({ success: true, feedback: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* POST pubblico — invia nuovo feedback o richiesta supporto */
app.post("/api/feedback/invia", async (req, res) => {
  if (!supabase) return res.json({ success: true });
  const { tipo, visibilita, nome, email, voto, messaggio } = req.body;
  if (!messaggio || messaggio.trim().length < 5) {
    return res.status(400).json({ success: false, error: "Messaggio troppo corto." });
  }
  if (tipo === "supporto" && !email) {
    return res.status(400).json({ success: false, error: "Email obbligatoria per le richieste di supporto." });
  }
  if (voto !== undefined && voto !== null && (voto < 1 || voto > 5)) {
    return res.status(400).json({ success: false, error: "Voto non valido." });
  }
  try {
    const { error } = await supabase.from("feedback_submissions").insert({
      tipo: tipo || "feedback",
      visibilita: tipo === "supporto" ? "privato" : (visibilita || "pubblico"),
      nome: nome ? String(nome).trim().slice(0, 80) : null,
      email: email ? String(email).trim().slice(0, 200) : null,
      voto: voto ? parseInt(voto) : null,
      messaggio: String(messaggio).trim().slice(0, 2000),
      status: "pending"
    });
    if (error) throw error;

    // Invia notifica email a chi gestisce la piattaforma
    const tipoLabel = tipo === 'supporto' ? 'Richiesta di supporto' : 'Recensione';
    sendNotificationEmail(
      `${tipoLabel} da ${nome || 'Anonimo'}`,
      `<h2>${tipoLabel}</h2>
      <table style="border-collapse:collapse;font-size:14px;font-family:sans-serif;">
        <tr><td style="padding:4px 12px;color:#64748b;">Tipo:</td><td style="padding:4px 12px;">${tipoLabel}</td></tr>
        <tr><td style="padding:4px 12px;color:#64748b;">Nome:</td><td style="padding:4px 12px;">${nome || '—'}</td></tr>
        <tr><td style="padding:4px 12px;color:#64748b;">Email:</td><td style="padding:4px 12px;">${email || '—'}</td></tr>
        ${voto ? `<tr><td style="padding:4px 12px;color:#64748b;">Voto:</td><td style="padding:4px 12px;">${'★'.repeat(voto)}${'☆'.repeat(5-voto)}</td></tr>` : ''}
        <tr><td style="padding:4px 12px;color:#64748b;">Visibilità:</td><td style="padding:4px 12px;">${visibilita || '—'}</td></tr>
      </table>
      <p style="margin-top:16px;padding:12px;background:#f8fafb;border-radius:8px;font-size:14px;line-height:1.6;">${String(messaggio).trim()}</p>`
    ).catch(() => {});

    // Invia email automatica di conferma a chi ha richiesto supporto
    if (tipo === 'supporto' && email && emailTransporter) {
      const contactEmail = await getContactEmail();
      emailTransporter.sendMail({
        from: `DraftARENA <${GMAIL_USER}>`,
        to: email,
        subject: 'Richiesta di supporto ricevuta — DraftARENA',
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
          <h2 style="color:#0f172a;">Ciao${nome ? ' ' + nome : ''},</h2>
          <p style="font-size:15px;line-height:1.6;color:#334155;">Abbiamo ricevuto la tua richiesta di supporto. Il nostro team la esaminerà e ti risponderà il prima possibile a questa email.</p>
          <p style="font-size:13px;color:#64748b;margin-top:24px;padding:12px;background:#f8fafb;border-radius:8px;line-height:1.6;"><strong>Il tuo messaggio:</strong><br>${String(messaggio).trim()}</p>
          <p style="font-size:14px;color:#334155;margin-top:24px;">Grazie per aver scritto a DraftARENA.</p>
          <p style="font-size:12px;color:#94a3b8;margin-top:32px;border-top:1px solid #e2e8f0;padding-top:16px;">Questa è un'email automatica, non rispondere a questo messaggio. Per ulteriori richieste scrivi a ${contactEmail}.</p>
        </div>`
      }).catch((e) => console.error('[EMAIL] Errore invio conferma supporto:', e.message));
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* GET superadmin — tutti i feedback/supporto */
app.get("/api/superadmin/feedback", async (req, res) => {
  if (!supabase) return res.json({ success: true, submissions: [] });
  try {
    const { data, error } = await supabase.rpc('get_all_feedback_submissions');
    if (error) throw error;
    res.json({ success: true, submissions: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* PATCH superadmin — approva / rifiuta / aggiungi risposta */
app.patch("/api/superadmin/feedback/:id", async (req, res) => {
  const { id } = req.params;
  const { status, risposta_admin } = req.body;
  if (!["approved", "rejected", "pending"].includes(status)) {
    return res.status(400).json({ success: false, error: "Status non valido." });
  }
  if (!supabase) return res.json({ success: true });
  try {
    const rispostaVal = risposta_admin !== undefined ? String(risposta_admin).trim().slice(0, 1000) : null;
    const approvedAt = status === "approved" ? new Date().toISOString() : null;
    const { error } = await supabase.rpc('update_feedback_submission', {
      p_id: id,
      p_status: status,
      p_risposta_admin: rispostaVal,
      p_approved_at: approvedAt
    });
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
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
    socket.emit("discardedList", room.discardedPlayers || []);
    socket.emit("configUpdate", { CONFIG: room.CONFIG, timerDuration: room.state.timerDuration });
    socket.emit("takenTeams", Object.keys(room.claimedTeams || {}));
    socket.emit("auctionEndedState", !!room.auctionEnded);
  }

  socket.on("viewingLanding", () => {
    socket.isViewingLanding = true;
  });

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
    if (room.auctionEnded) { socket.emit("errorNotify", "⛔ Asta conclusa. Non è più possibile fare offerte."); return; }
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

  // Estrazione random con filtri (ruolo, squadra, valore min/max, ordinamento)
  socket.on("startRandomFiltered", (filters) => {
    const room = getRoom(); if (!room || room.playersList.length === 0) return;
    if (!requireAdmin()) return;
    let pool = [...room.playersList];
    if (filters) {
      if (filters.ruoli && filters.ruoli.length > 0) {
        pool = pool.filter(p => filters.ruoli.some(r => p.ruolo.toUpperCase().includes(r.toUpperCase())));
      }
      if (filters.squadre && filters.squadre.length > 0) {
        pool = pool.filter(p => filters.squadre.some(s => (p.squadra || "").toLowerCase() === s.toLowerCase()));
      }
      if (filters.valoreMin !== undefined && filters.valoreMin > 0) {
        pool = pool.filter(p => (p.valore || 0) >= filters.valoreMin);
      }
      if (filters.valoreMax !== undefined && filters.valoreMax > 0) {
        pool = pool.filter(p => (p.valore || 0) <= filters.valoreMax);
      }
    }
    if (pool.length === 0) {
      socket.emit("errorNotify", "⚠️ Nessun giocatore trovato con questi filtri!");
      return;
    }
    // Ordinamento
    if (filters && filters.sort) {
      if (filters.sort === 'az') pool.sort((a, b) => a.nome.localeCompare(b.nome));
      else if (filters.sort === 'za') pool.sort((a, b) => b.nome.localeCompare(a.nome));
      else if (filters.sort === 'valoreDesc') pool.sort((a, b) => (b.valore || 0) - (a.valore || 0));
      else if (filters.sort === 'valoreAsc') pool.sort((a, b) => (a.valore || 0) - (b.valore || 0));
      else if (filters.sort === 'ruolo') pool.sort((a, b) => a.ruolo.localeCompare(b.ruolo));
    }
    // Se sort è specificato e non è "random", prendi il primo (utile per selezione ordinata)
    if (filters && filters.sort && filters.sort !== 'random') {
      eseguiLancioGiocatore(socket.roomCode, pool[0]);
    } else {
      eseguiLancioGiocatore(socket.roomCode, pool[Math.floor(Math.random() * pool.length)]);
    }
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

  // ─── TERMINA / RIPRENDI ASTA ──────────────────────────────────────────────

  socket.on("adminEndAuction", async () => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    room.auctionEnded = true;
    room.state.isPaused = true;
    if (room.state.player) {
      room.playersList.unshift(room.state.player);
      room.state.player = null;
      room.state.currentPrice = 0;
      room.state.highestBidder = null;
      room.state.history = [];
    }
    const rc = socket.roomCode;
    await salvaSessioneDB(room);
    io.to(rc).emit("update", room.state);
    io.to(rc).emit("playersList", room.playersList);
    io.to(rc).emit("auctionEndedState", true);
    socket.emit("errorNotify", "🏁 Asta conclusa! La stanza è ora in modalità riepilogo.");
  });

  socket.on("adminResumeAuction", async () => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    room.auctionEnded = false;
    room.state.isPaused = false;
    const rc = socket.roomCode;
    await salvaSessioneDB(room);
    io.to(rc).emit("update", room.state);
    io.to(rc).emit("auctionEndedState", false);
    socket.emit("errorNotify", "▶️ Asta ripresa! È ora possibile continuare con le offerte.");
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
    io.to(rc).emit("discardedList", room.discardedPlayers || []);
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

  socket.on("adminFixPlayerRuolo", async (data) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    const { nome, nuovoRuolo } = data;
    if (!nome || !nuovoRuolo) return;
    const player = room.playersList.find(p => p.nome === nome);
    if (!player) { socket.emit("errorNotify", "Giocatore non trovato!"); return; }
    player.ruolo = nuovoRuolo.toUpperCase().trim();
    io.to(socket.roomCode).emit("playersList", room.playersList);
    await salvaSessioneDB(room);
  });

  socket.on("adminScartaDalMazzo", async (playerName) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    if (!room.discardedPlayers) room.discardedPlayers = [];
    const idx = room.playersList.findIndex(pl => pl.nome.toLowerCase() === playerName.toLowerCase().trim());
    if (idx !== -1) {
      const [removed] = room.playersList.splice(idx, 1);
      if (!room.discardedPlayers.some(dp => dp.nome.toLowerCase() === removed.nome.toLowerCase())) {
        room.discardedPlayers.push({ nome: removed.nome, ruolo: removed.ruolo, squadra: removed.squadra, id: removed.id || "" });
      }
    }
    const rc = socket.roomCode;
    io.to(rc).emit("playersList", room.playersList);
    io.to(rc).emit("discardedList", room.discardedPlayers);
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

  socket.on("adminManualAssign", async (data) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    const { player, squadra, prezzo } = data;
    if (!player || !squadra) { socket.emit("errorNotify", "Dati mancanti!"); return; }
    const nameKey = squadra.toLowerCase().trim();
    if (!room.teams[nameKey]) { socket.emit("errorNotify", "Squadra non valida!"); return; }
    const totali = Object.values(room.teams[nameKey].slots).reduce((a, b) => a + b, 0);
    if (totali >= room.CONFIG.MAX_TOTAL_PLAYERS) { socket.emit("errorNotify", "Rosa piena!"); return; }
    const repartiPossibili = ottieniMacroReparti(player.ruolo);
    let repartoScelto = null;
    for (let i = 0; i < repartiPossibili.length; i++) {
      const rep = repartiPossibili[i];
      if (room.CONFIG.LIMITS[rep] === 0 || (room.teams[nameKey].slots[rep] || 0) < room.CONFIG.LIMITS[rep]) { repartoScelto = rep; break; }
    }
    if (!repartoScelto) { socket.emit("errorNotify", "Spazio esaurito nei ruoli!"); return; }
    const price = parseInt(prezzo) || 1;
    room.playersList = room.playersList.filter(pl => pl.nome !== player.nome);
    room.soldPlayers.push({ player: player.nome, ruolo: player.ruolo, squadra: player.squadra, winner: room.teams[nameKey].name, price, repartoAssegnato: repartoScelto });
    room.teams[nameKey].budget -= price;
    room.teams[nameKey].slots[repartoScelto] = (room.teams[nameKey].slots[repartoScelto] || 0) + 1;
    const rc2 = socket.roomCode;
    io.to(rc2).emit("updateSold", room.soldPlayers);
    io.to(rc2).emit("updateTeams", room.teams);
    io.to(rc2).emit("teamsUpdate", room.teams);
    io.to(rc2).emit("playersList", room.playersList);
    await salvaSessioneDB(room);
  });

  socket.on("adminRiciclaInvenduti", async () => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    if (!room.discardedPlayers || room.discardedPlayers.length === 0) {
      if (room.playersList.length === 0) {
        socket.emit("errorNotify", "❌ Nessun giocatore svincolato nel mazzo!"); return;
      }
      socket.emit("errorNotify", "❌ Nessun giocatore scartato da richiamare!"); return;
    }
    // Richiama tutti i giocatori scartati nel mazzo principale
    const scartati = room.discardedPlayers.splice(0);
    for (const p of scartati) {
      if (!room.playersList.some(pl => pl.nome.toLowerCase() === p.nome.toLowerCase())) {
        room.playersList.push(p);
      }
    }
    room.state = { player: null, currentPrice: 0, highestBidder: null, time: room.state.timerDuration, timerDuration: room.state.timerDuration, isPaused: false, history: [] };
    const rc = socket.roomCode;
    io.to(rc).emit("update", room.state);
    io.to(rc).emit("playersList", room.playersList);
    io.to(rc).emit("discardedList", room.discardedPlayers);
    await salvaSessioneDB(room);
    socket.emit("errorNotify", `🔄 GIRO DI GARA! ${scartati.length} giocatori scartati richiamati. ${room.playersList.length} totali nel mazzo.`);
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

  // ─── SCAMBIO TRA SQUADRE (switch giocatore mantenendo prezzo) ──────────────
  socket.on("adminSwitchPlayer", async (data) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    const { playerName, fromTeam, toTeam } = data;
    if (!playerName || !fromTeam || !toTeam) {
      socket.emit("errorNotify", "Dati mancanti per lo scambio!"); return;
    }
    const fromKey = String(fromTeam).toLowerCase().trim();
    const toKey = String(toTeam).toLowerCase().trim();
    if (!room.teams[fromKey] || !room.teams[toKey]) {
      socket.emit("errorNotify", "Squadra non valida!"); return;
    }
    if (fromKey === toKey) {
      socket.emit("errorNotify", "La squadra di origine e destinazione coincidono!"); return;
    }

    const idx = room.soldPlayers.findIndex(sp =>
      sp.player.toLowerCase() === String(playerName).toLowerCase() &&
      sp.winner.toLowerCase().trim() === fromKey
    );
    if (idx === -1) {
      socket.emit("errorNotify", "Giocatore non trovato in quella squadra!"); return;
    }

    const soldRec = room.soldPlayers[idx];
    const reparto = soldRec.repartoAssegnato;
    const price = soldRec.price;

    // Verifica spazio nella squadra destinataria
    const totali = Object.values(room.teams[toKey].slots).reduce((a, b) => a + b, 0);
    if (totali >= room.CONFIG.MAX_TOTAL_PLAYERS) {
      socket.emit("errorNotify", "La squadra destinataria ha la rosa piena!"); return;
    }
    if (room.CONFIG.LIMITS[reparto] > 0 && (room.teams[toKey].slots[reparto] || 0) >= room.CONFIG.LIMITS[reparto]) {
      socket.emit("errorNotify", "La squadra destinataria non ha spazio per questo ruolo!"); return;
    }

    // Sposta il giocatore: mantiene il prezzo, non modifica i crediti
    soldRec.winner = room.teams[toKey].name;
    room.teams[fromKey].slots[reparto] = Math.max(0, (room.teams[fromKey].slots[reparto] || 0) - 1);
    room.teams[toKey].slots[reparto] = (room.teams[toKey].slots[reparto] || 0) + 1;

    const rc = socket.roomCode;
    io.to(rc).emit("updateSold", room.soldPlayers);
    io.to(rc).emit("updateTeams", room.teams);
    io.to(rc).emit("teamsUpdate", room.teams);
    await salvaSessioneDB(room);
    socket.emit("errorNotify", `🔄 ${soldRec.player} spostato da ${room.teams[fromKey].name} a ${room.teams[toKey].name} (prezzo: ${price} cr invariato)`);
  });

  socket.on("getSoldPlayers", () => {
    const room = getRoom(); if (!room) return;
    socket.emit("updateSold", room.soldPlayers);
  });

  socket.on("getDiscarded", () => {
    const room = getRoom(); if (!room) return;
    socket.emit("discardedList", room.discardedPlayers || []);
  });

  socket.on("adminRichiamaSingoloScartato", async (playerName) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    if (!room.discardedPlayers || room.discardedPlayers.length === 0) {
      socket.emit("errorNotify", "❌ Nessun giocatore scartato da richiamare!"); return;
    }
    const idx = room.discardedPlayers.findIndex(dp => dp.nome.toLowerCase() === playerName.toLowerCase().trim());
    if (idx === -1) { socket.emit("errorNotify", "Giocatore non trovato tra gli scartati!"); return; }
    const [p] = room.discardedPlayers.splice(idx, 1);
    if (!room.playersList.some(pl => pl.nome.toLowerCase() === p.nome.toLowerCase())) {
      room.playersList.push(p);
    }
    const rc = socket.roomCode;
    io.to(rc).emit("playersList", room.playersList);
    io.to(rc).emit("discardedList", room.discardedPlayers);
    await salvaSessioneDB(room);
    socket.emit("errorNotify", `✅ ${p.nome} richiamato nel mazzo!`);
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

  // ─── BACKUP EXPORT ───────────────────────────────────────────────────────

  socket.on("adminExportBackup", (opts) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;

    const year = opts?.year || new Date().getFullYear();
    const label = opts?.label || `${room.auctionName} ${year}`;

    // Costruisce la struttura backup
    const teamsArray = Object.entries(room.teams).map(([key, t]) => ({
      key,
      name: t.name,
      finalBudget: t.budget,
      slots: t.slots
    }));

    const backup = {
      version: 1,
      app: "DraftARENA",
      year,
      label,
      exportedAt: new Date().toISOString(),
      auctionName: room.auctionName,
      config: room.CONFIG,
      timerDuration: room.state.timerDuration,
      teams: teamsArray,
      soldPlayers: room.soldPlayers,
      unsoldPlayers: room.playersList
    };

    socket.emit("backupReady", { backup, filename: `DraftARENA_backup_${room.auctionName}_${year}.json` });
  });

  // ─── BACKUP IMPORT CONFIGURAZIONE ────────────────────────────────────────

  socket.on("adminImportBackupConfig", async (backupData) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;

    try {
      const b = typeof backupData === "string" ? JSON.parse(backupData) : backupData;
      if (!b.version || b.app !== "DraftARENA") {
        socket.emit("errorNotify", "❌ File di backup non valido."); return;
      }

      // Ripristina config e timer
      if (b.config) room.CONFIG = b.config;
      if (b.timerDuration) room.state.timerDuration = b.timerDuration;

      // Ricrea le squadre con budget iniziale (rosa vuota)
      room.teams = {};
      if (b.teams && Array.isArray(b.teams)) {
        b.teams.forEach(t => {
          const key = String(t.name).toLowerCase().trim();
          room.teams[key] = {
            name: t.name,
            budget: room.CONFIG.STARTING_BUDGET,
            slots: { P: 0, D: 0, C: 0, A: 0 }
          };
        });
      }

      // Reset stato asta
      room.soldPlayers = [];
      room.playersList = b.unsoldPlayers || [];
      room.state.player = null;
      room.state.currentPrice = 0;
      room.state.highestBidder = null;
      room.state.time = room.state.timerDuration;
      room.state.isPaused = false;

      const rc = socket.roomCode;
      await salvaSessioneDB(room);
      io.to(rc).emit("updateTeams", room.teams);
      io.to(rc).emit("teamsUpdate", room.teams);
      io.to(rc).emit("updateSold", room.soldPlayers);
      io.to(rc).emit("playersList", room.playersList);
      io.to(rc).emit("update", room.state);
      io.to(rc).emit("configUpdate", { CONFIG: room.CONFIG, timerDuration: room.state.timerDuration });
      socket.emit("backupImportSuccess", { label: b.label || b.auctionName, year: b.year });
      socket.emit("errorNotify", `✅ Backup "${b.label || b.year}" caricato! ${Object.keys(room.teams).length} squadre pronte.`);
    } catch (e) {
      socket.emit("errorNotify", "❌ Errore lettura backup: " + e.message);
    }
  });

  socket.on("adminImportBackupFull", async (backupData) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;

    try {
      const b = typeof backupData === "string" ? JSON.parse(backupData) : backupData;
      if (!b.version || b.app !== "DraftARENA") {
        socket.emit("errorNotify", "❌ File di backup non valido."); return;
      }

      // Ripristina config e timer
      if (b.config) room.CONFIG = b.config;
      if (b.timerDuration) room.state.timerDuration = b.timerDuration;

      // Ricrea le squadre con budget finale e slots dal backup
      room.teams = {};
      if (b.teams && Array.isArray(b.teams)) {
        b.teams.forEach(t => {
          const key = String(t.name).toLowerCase().trim();
          room.teams[key] = {
            name: t.name,
            budget: t.finalBudget != null ? t.finalBudget : room.CONFIG.STARTING_BUDGET,
            slots: t.slots ? { ...t.slots } : { P: 0, D: 0, C: 0, A: 0 }
          };
        });
      }

      // Ripristina giocatori venduti esattamente come nel backup
      room.soldPlayers = Array.isArray(b.soldPlayers) ? b.soldPlayers : [];

      // Ripristina giocatori svincolati come lista disponibile
      room.playersList = Array.isArray(b.unsoldPlayers) ? b.unsoldPlayers : [];

      // Stato asta: conclusa, nessun giocatore in corso, in pausa
      room.state.player = null;
      room.state.currentPrice = 0;
      room.state.highestBidder = null;
      room.state.time = room.state.timerDuration;
      room.state.isPaused = true;

      const rc = socket.roomCode;
      await salvaSessioneDB(room);
      io.to(rc).emit("updateTeams", room.teams);
      io.to(rc).emit("teamsUpdate", room.teams);
      io.to(rc).emit("updateSold", room.soldPlayers);
      io.to(rc).emit("playersList", room.playersList);
      io.to(rc).emit("update", room.state);
      io.to(rc).emit("configUpdate", { CONFIG: room.CONFIG, timerDuration: room.state.timerDuration });
      socket.emit("backupImportSuccess", { label: b.label || b.auctionName, year: b.year });
      socket.emit("errorNotify", `✅ Asta completa "${b.label || b.year}" ripristinata! ${Object.keys(room.teams).length} squadre, ${room.soldPlayers.length} giocatori venduti.`);
    } catch (e) {
      socket.emit("errorNotify", "❌ Errore ripristino asta: " + e.message);
    }
  });

  // ─── BACKUP SALVA COME STORICO ────────────────────────────────────────────

  socket.on("adminSaveHistoricalBackup", async (backupData) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    if (LOCAL_MODE) { socket.emit("errorNotify", "⚠️ Storico non disponibile in LOCAL_MODE."); return; }

    try {
      const b = typeof backupData === "string" ? JSON.parse(backupData) : backupData;
      if (!b.version || b.app !== "DraftARENA") {
        socket.emit("errorNotify", "❌ File di backup non valido."); return;
      }

      const { error } = await supabase.from("auction_backups").insert({
        room_code: socket.roomCode,
        year: b.year || new Date().getFullYear(),
        auction_name: b.auctionName || "default",
        label: b.label || `${b.auctionName} ${b.year}`,
        backup_data: b,
        exported_at: b.exportedAt || new Date().toISOString()
      });

      if (error) throw error;
      socket.emit("errorNotify", `📚 Storico "${b.label || b.year}" salvato con successo!`);
      socket.emit("historicalBackupSaved");
    } catch (e) {
      socket.emit("errorNotify", "❌ Errore salvataggio storico: " + e.message);
    }
  });

  socket.on("setHostUrl", async (data) => {
    const url = (data.url || "").trim();
    if (socket.roomCode) {
      const room = getRoom();
      if (room) {
        room.hostUrl = url || null;
        if (!LOCAL_MODE) await supabase.from("rooms").update({ host_url: room.hostUrl }).eq("code", socket.roomCode);
        io.to(socket.roomCode).emit("connectionData", buildConnectionData(socket.roomCode));
      }
    }
    if (!socket.roomCode) CUSTOM_HOST_URL = url || null;
    socket.emit("hostUrlUpdate", { hostUrl: url || CUSTOM_HOST_URL || LOCAL_IP, isCustom: !!url });
  });

  socket.on("adminAddCredits", async (data) => {
    const room = getRoom(); if (!room) return;
    if (!requireAdmin()) return;
    const teamKey = String(data.teamKey || "").toLowerCase().trim();
    const amount = parseInt(data.amount);
    if (!room.teams[teamKey]) { socket.emit("errorNotify", "Squadra non trovata!"); return; }
    if (isNaN(amount) || amount === 0) { socket.emit("errorNotify", "Importo non valido."); return; }
    room.teams[teamKey].budget += amount;
    await salvaSessioneDB(room);
    io.to(socket.roomCode).emit("updateTeams", room.teams);
    io.to(socket.roomCode).emit("teamsUpdate", room.teams);
    const segno = amount > 0 ? "+" : "";
    socket.emit("errorNotify", `💰 ${room.teams[teamKey].name}: ${segno}${amount} cr (nuovo budget: ${room.teams[teamKey].budget} cr)`);
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
   VIDEO GALLERY — API
   ========================================================================== */
const videoUpload = multer({
  dest: "uploads/videos/",
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(mp4|webm|ogg|mov|avi|mkv)$/i;
    if (allowed.test(path.extname(file.originalname))) cb(null, true);
    else cb(new Error("Formato video non supportato. Usa mp4, webm, ogg, mov, avi o mkv."));
  }
});

app.get("/api/videos", async (req, res) => {
  if (!supabase) return res.json({ success: true, videos: [] });
  try {
    const { data, error } = await supabase
      .from("videos")
      .select("*")
      .order("sort_order", { ascending: true });
    if (error) throw error;
    res.json({ success: true, videos: data || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/superadmin/videos/youtube", async (req, res) => {
  const { password, title, url, sortOrder } = req.body;
  if (password !== SUPERADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Password errata." });
  }
  if (!title || !url) {
    return res.status(400).json({ success: false, error: "Titolo e URL sono obbligatori." });
  }
  if (!supabase) return res.json({ success: true });
  try {
    const { data, error } = await supabase
      .from("videos")
      .insert({
        title: String(title).trim().slice(0, 200),
        type: "youtube",
        url: String(url).trim().slice(0, 500),
        sort_order: parseInt(sortOrder) || 0
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, video: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/superadmin/videos/upload", videoUpload.single("video"), async (req, res) => {
  const password = req.headers["x-sa-password"] || "";
  if (password !== SUPERADMIN_PASSWORD) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(401).json({ success: false, error: "Password errata." });
  }
  if (!req.file) return res.status(400).json({ success: false, error: "Nessun file caricato." });
  const title = req.body.title || req.file.originalname.replace(/\.[^.]+$/, "");
  const sortOrder = parseInt(req.body.sortOrder) || 0;
  if (!supabase) {
    fs.unlink(req.file.path, () => {});
    return res.json({ success: true });
  }
  try {
    const ext = path.extname(req.file.originalname) || ".mp4";
    const newFilename = `video_${Date.now()}${ext}`;
    const newPath = path.join(__dirname, "..", "public", "videos", newFilename);
    if (!fs.existsSync(path.dirname(newPath))) fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.renameSync(req.file.path, newPath);

    const { data, error } = await supabase
      .from("videos")
      .insert({
        title: String(title).trim().slice(0, 200),
        type: "file",
        url: `/videos/${newFilename}`,
        sort_order: sortOrder
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, video: data });
  } catch (e) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlink(req.file.path, () => {});
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete("/api/superadmin/videos/:id", async (req, res) => {
  const password = req.headers["x-sa-password"] || "";
  if (password !== SUPERADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Password errata." });
  }
  const { id } = req.params;
  if (!supabase) return res.json({ success: true });
  try {
    const { data: video } = await supabase.from("videos").select("type, url").eq("id", id).maybeSingle();
    const { error } = await supabase.from("videos").delete().eq("id", id);
    if (error) throw error;
    if (video && video.type === "file" && video.url && video.url.startsWith("/videos/")) {
      const filePath = path.join(__dirname, "..", "public", video.url);
      if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Error handler per errori multer (file troppo grande, formato errato, ecc.)
app.use((err, req, res, next) => {
  if (err && err.code && err.code.startsWith("LIMIT_")) {
    console.error("[SERVER] Multer error:", err.code, err.message);
    return res.status(400).json({ success: false, error: "Errore nel caricamento del file: " + err.message });
  }
  if (err) {
    console.error("[SERVER] Errore generico middleware:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
  next();
});

/* ==========================================================================
   AVVIO SERVER
   ========================================================================== */
const PORT = process.env.PORT || 3000;
Promise.all([loadSuperadminPassword(), loadPageViewsTotal()]).then(() => {
  server.listen(PORT, () => {
    console.log("====================================================");
    console.log(`🚀 SERVER APERTO SU http://localhost:${PORT}`);
    console.log(`📡 Rete locale: http://${LOCAL_IP}:${PORT}`);
    if (LOCAL_MODE) {
      console.log("💾 Modalità LOCAL — dati salvati su file JSON locali");
    } else {
      console.log(`🗄️  Supabase: ${SUPABASE_URL}`);
    }
    if (CUSTOM_HOST_URL) {
      console.log(`🌐 Modalità ONLINE — URL pubblico: ${CUSTOM_HOST_URL}`);
    } else {
      console.log("📺 Modalità LAN — QR basato su IP locale");
    }
    console.log("====================================================");
  });
});
