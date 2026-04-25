require('dotenv').config();
const { Server } = require("socket.io");
const crypto = require("crypto");

const PORT = process.env.PORT || 5000;
const io = new Server(PORT, {
  cors: {
    origin: [
      "http://localhost:3000",
      "https://localhost:3000",
      "https://v0-asrguru.vercel.app",
      "https://shrewdly-switch-sponge.ngrok-free.dev"
    ],
    methods: ["GET", "POST"],
    credentials: true
  }
});

console.log(`🚀 Premium Signaling Server running on port ${PORT}`);

const users = new Map(); // userId -> socketId

// ─── TURN Credential Strategies ──────────────────────────────────────────────

// Strategy 1: Metered.ca REST API (if METERED_API_KEY is set)
// Sign up free at https://www.metered.ca/ — gives you 50GB/month free TURN
// Then set METERED_API_KEY and METERED_APP_NAME in your .env
async function getMeteredTurnCredentials() {
  const apiKey = process.env.METERED_API_KEY;
  const appName = process.env.METERED_APP_NAME; // e.g. 'aura' from your Metered.ca dashboard
  if (!apiKey || !appName) {
    if (apiKey && !appName) console.warn('[TURN] METERED_API_KEY set but METERED_APP_NAME missing!');
    return null;
  }
  try {
    const url = `https://${appName}.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`;
    console.log('[TURN] Fetching from Metered.ca:', url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Metered API ${res.status}: ${await res.text()}`);
    const servers = await res.json();
    console.log(`[TURN] ✅ Got ${servers.length} servers from Metered.ca API`);
    return servers; // Already in RTCIceServer format
  } catch (err) {
    console.error('[TURN] ⚠️ Metered.ca API failed:', err.message);
    return null;
  }
}

// Strategy 2: HMAC-based credentials for self-hosted Coturn
// Only works if you run your OWN Coturn server with this shared secret
function generateCoturnCredentials(username, secret, expiryHours = 24) {
  const expiryDate = Math.floor(Date.now() / 1000) + expiryHours * 3600;
  const turnUsername = `${expiryDate}:${username}`;
  const hmac = crypto.createHmac("sha1", secret);
  hmac.update(turnUsername);
  const credential = hmac.digest("base64");
  return { turnUsername, credential, expiryDate };
}

// Strategy 3: Static fallback — OpenRelay only (Metered.ca public free TURN)
function getStaticTurnServers() {
  return [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: [
        "turn:openrelay.metered.ca:443?transport=tcp", // TCP 443 — best for WiFi firewalls
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:3478",
      ],
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ];
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("register-user", (userId) => {
    users.set(userId, socket.id);
    console.log(`[AUTH] Registered: ${userId} -> ${socket.id}`);
  });

  // --- TURN Credential Handling (multi-strategy) ---
  socket.on("request-turn-credentials", async ({ userId }, callback) => {
    console.log(`[TURN] Request from user: ${userId}`);

    // Try Metered.ca API first (best quality, temporary creds)
    const meteredServers = await getMeteredTurnCredentials();
    if (meteredServers && meteredServers.length > 0) {
      console.log(`[TURN] ✅ Serving Metered.ca API credentials`);
      callback({
        success: true,
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          ...meteredServers
        ]
      });
      return;
    }

    // Try self-hosted Coturn (if COTURN_SERVER + COTURN_SECRET configured)
    const COTURN_SERVER = process.env.COTURN_SERVER;
    const COTURN_SECRET = process.env.COTURN_SECRET;
    if (COTURN_SERVER && COTURN_SECRET) {
      const creds = generateCoturnCredentials(userId, COTURN_SECRET, 24);
      console.log(`[TURN] ✅ Serving self-hosted Coturn credentials for ${COTURN_SERVER}`);
      callback({
        success: true,
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          {
            urls: [
              `turn:${COTURN_SERVER}:3478`,
              `turn:${COTURN_SERVER}:443`,
              `turn:${COTURN_SERVER}:443?transport=tcp`
            ],
            username: creds.turnUsername,
            credential: creds.credential,
          }
        ]
      });
      return;
    }

    // Fallback: static free TURN servers
    console.log(`[TURN] ⚠️ No API key or Coturn configured — using static free TURN`);
    callback({
      success: true,
      iceServers: getStaticTurnServers()
    });
  });

  // --- WebRTC Signaling Events ---
  socket.on("call-user", ({ from, to, video }) => {
    const targetSocket = users.get(to);
    if (!targetSocket) {
      socket.emit("user-offline");
      return;
    }
    io.to(targetSocket).emit("incoming-call", { from, video });
  });

  socket.on("call-accepted", ({ from, to }) => {
    const callerSocket = users.get(to);
    if (callerSocket) io.to(callerSocket).emit("call-accepted", { from });
  });

  socket.on("call-rejected", ({ to, from }) => {
    const callerSocket = users.get(to);
    if (callerSocket) io.to(callerSocket).emit("call-rejected", { from });
  });

  socket.on("callee-ready", ({ to, from }) => {
    const callerSocket = users.get(to);
    if (callerSocket) io.to(callerSocket).emit("callee-ready", { from });
  });

  socket.on("offer", ({ to, offer, from }) => {
    const targetSocket = users.get(to);
    if (targetSocket) io.to(targetSocket).emit("offer", { offer, from });
  });

  socket.on("answer", ({ to, answer, from }) => {
    const targetSocket = users.get(to);
    if (targetSocket) io.to(targetSocket).emit("answer", { answer, from });
  });

  socket.on("ice-candidate", ({ to, candidate, from }) => {
    const targetSocket = users.get(to);
    if (targetSocket) io.to(targetSocket).emit("ice-candidate", { candidate, from });
  });

  socket.on("end-call", ({ to, from }) => {
    const targetSocket = users.get(to);
    if (targetSocket) io.to(targetSocket).emit("end-call", { from });
  });

  socket.on("disconnect", () => {
    for (const [key, value] of users.entries()) {
      if (value === socket.id) {
        users.delete(key);
        break;
      }
    }
  });
});
