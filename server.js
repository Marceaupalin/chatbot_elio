// Elio — serveur local du chatbot de pré-diagnostic.
// Aucune dépendance : nécessite seulement Node.js 18 ou plus récent.
// Rôle : servir l'interface (dossier public/) et relayer les messages vers l'API
// NVIDIA en gardant la clé côté serveur (jamais envoyée au navigateur).

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const ASSETS_DIR = path.join(PUBLIC_DIR, "assets");
const PROMPT_FILE = path.join(ROOT, "system-prompt.txt");

// ---------- Configuration (.env) ----------
function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnv();

const DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b";

const CONFIG = {
  apiKey: (process.env.NVIDIA_API_KEY || process.env.API_KEY || "").trim(),
  baseUrl: (process.env.API_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, ""),
  // Modèle principal puis modèles de secours, essayés dans l'ordre si le premier est indisponible.
  models: [
    ...new Set(
      [process.env.MODEL || DEFAULT_MODEL, ...(process.env.FALLBACK_MODELS || "").split(",")]
        .map((m) => m.trim())
        .filter(Boolean)
    ),
  ],
  thinking: process.env.THINKING === "true",
  temperature: Number(process.env.TEMPERATURE || 0.4),
  maxTokens: Number(process.env.MAX_TOKENS || 1024),
  port: Number(process.env.PORT || 3000),
  openBrowser: process.env.OPEN_BROWSER !== "false",
};

// Délai maximal pour recevoir le début d'une réponse avant de passer au modèle suivant.
const FIRST_CHUNK_TIMEOUT = 20000;

// Modèles retirés par le fournisseur (absents de sa liste, ou réponse 404/410) : on ne les essaie plus.
const retiredModels = new Set();
// Modèles saturés récemment : essayés en dernier pendant 5 minutes.
const slowUntil = new Map();
const isSlow = (m) => (slowUntil.get(m) || 0) > Date.now();
const usableModels = () => {
  const list = CONFIG.models.filter((m) => !retiredModels.has(m));
  const pool = list.length ? list : CONFIG.models;
  return [...pool.filter((m) => !isSlow(m)), ...pool.filter(isSlow)];
};
const currentModel = () => usableModels()[0];

// État de la clé, vérifié au démarrage et affiché dans l'interface si besoin.
const health = { status: "checking", message: "Vérification de la clé API en cours…" };

// Les modèles « raisonneurs » réfléchissent plusieurs secondes avant d'écrire.
// Pour un chat fluide, cette réflexion est désactivée (THINKING=true dans .env pour la garder).
function modelOptions(model) {
  if (CONFIG.thinking) return {};
  if (/nemotron-3|nemotron-nano-3/i.test(model)) return { chat_template_kwargs: { enable_thinking: false } };
  if (/gpt-oss/i.test(model)) return { reasoning_effort: "low" };
  return {};
}

// ---------- Utilitaires ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too_large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function upstreamErrorMessage(status, detail, model = currentModel()) {
  if (status === 401 || status === 403)
    return "La clé API a été refusée par NVIDIA. Vérifiez NVIDIA_API_KEY dans le fichier .env (une clé NVIDIA commence en général par « nvapi- »).";
  if (status === 404 || status === 410)
    return `Le modèle « ${model} » n'est plus disponible chez NVIDIA. Changez MODEL dans le fichier .env.`;
  if (status === 429) return "Trop de requêtes envoyées à NVIDIA en peu de temps. Patientez une minute puis réessayez.";
  if (status >= 500) return "Le service NVIDIA ne répond pas correctement pour le moment. Réessayez dans quelques instants.";
  return `Erreur renvoyée par l'API (${status}). ${detail || ""}`.trim();
}

// ---------- Vérification de la clé au démarrage ----------
async function checkApiKey() {
  if (!CONFIG.apiKey) {
    health.status = "error";
    health.message = "Aucune clé API configurée. Ajoutez NVIDIA_API_KEY dans le fichier .env puis relancez le serveur.";
    return;
  }
  try {
    const r = await fetch(`${CONFIG.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${CONFIG.apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      health.status = "error";
      health.message = upstreamErrorMessage(r.status);
      return;
    }
    const data = await r.json().catch(() => ({}));
    const ids = Array.isArray(data.data) ? data.data.map((m) => m.id) : [];
    if (ids.length) CONFIG.models.filter((m) => !ids.includes(m)).forEach((m) => retiredModels.add(m));
    if (retiredModels.size === CONFIG.models.length) {
      health.status = "warning";
      health.message = `La clé fonctionne, mais le modèle « ${CONFIG.models[0]} » n'apparaît pas dans la liste NVIDIA. Si les réponses échouent, changez MODEL dans .env.`;
      return;
    }
    if (currentModel() !== CONFIG.models[0]) {
      console.log(`  Modèle « ${CONFIG.models[0]} » indisponible : utilisation de « ${currentModel()} ».`);
    }
    health.status = "ok";
    health.message = "Clé API valide.";
  } catch (e) {
    health.status = "warning";
    health.message = "Impossible de joindre l'API NVIDIA pour vérifier la clé (connexion internet ?). L'application essaiera quand même.";
  }
}

// ---------- Mise en cache du logo et de la mascotte Elio ----------
// Téléchargés une seule fois depuis elio-robot.fr puis servis en local.
async function cacheBrandAssets() {
  const assets = [
    { url: "https://www.elio-robot.fr/logo-elio.webp", file: "logo-elio.webp" },
    { url: "https://www.elio-robot.fr/logo_elio_blanc.webp", file: "logo_elio_blanc.webp" },
    { url: "https://www.elio-robot.fr/mascot.webp", file: "mascot.webp" },
  ];
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  for (const a of assets) {
    const dest = path.join(ASSETS_DIR, a.file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
    try {
      const r = await fetch(a.url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(String(r.status));
      fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
      console.log(`  Image Elio récupérée : ${a.file}`);
    } catch {
      console.log(`  Image ${a.file} non récupérée (l'interface utilisera une illustration de remplacement).`);
    }
  }
}

// ---------- Relais vers l'API (streaming) ----------
async function handleChat(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Requête illisible." });
  }

  const history = Array.isArray(payload.messages) ? payload.messages : [];
  const messages = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-40)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return sendJson(res, 400, { error: "Aucun message à envoyer." });
  }
  if (!CONFIG.apiKey) {
    return sendJson(res, 500, { error: health.message });
  }

  // Le prompt système est relu à chaque message : on peut le modifier sans relancer le serveur.
  let systemPrompt = fs.readFileSync(PROMPT_FILE, "utf8");

  // Certains modèles exigent que la conversation commence par un message utilisateur.
  // Le message d'accueil affiché par l'interface est donc transmis comme contexte.
  const leading = [];
  while (messages.length && messages[0].role === "assistant") leading.push(messages.shift().content);
  if (leading.length) {
    systemPrompt += `\n\n# CONTEXTE DE LA CONVERSATION\nMessage d'accueil déjà affiché au prospect par l'interface :\n"""\n${leading.join("\n\n")}\n"""`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  res.on("close", () => controller.abort());

  // Le modèle principal d'abord, puis les modèles de secours s'il est retiré, en panne ou saturé.
  let stream = null;
  let failure = null;
  for (const model of usableModels()) {
    if (controller.signal.aborted) break;
    const attempt = await openStream(model, systemPrompt, messages, controller.signal);
    if (attempt.ok) {
      stream = attempt;
      if (model !== CONFIG.models[0]) console.log(`  Réponse fournie par le modèle de secours « ${model} ».`);
      break;
    }
    failure = attempt;
    if (attempt.fatal) break;
  }

  if (!stream) {
    clearTimeout(timeout);
    if (res.writableEnded || res.destroyed) return;
    return sendJson(res, 502, { error: (failure && failure.error) || "Elio n'a pas pu répondre." });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  try {
    let step = stream.first;
    while (!step.done) {
      if (res.destroyed) break;
      res.write(step.value);
      step = await stream.iterator.next();
    }
  } catch {
    // Coupure en cours de route : le navigateur affichera ce qui a été reçu.
  } finally {
    clearTimeout(timeout);
    if (!res.writableEnded) res.end();
  }
}

// Ouvre la réponse en continu d'un modèle et attend son premier fragment.
// Un modèle saturé qui ne renvoie rien dans le délai est abandonné au profit du suivant.
async function openStream(model, systemPrompt, messages, parentSignal) {
  const attempt = new AbortController();
  const relay = () => attempt.abort();
  parentSignal.addEventListener("abort", relay, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    attempt.abort();
  }, FIRST_CHUNK_TIMEOUT);

  try {
    const upstream = await fetch(`${CONFIG.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CONFIG.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        temperature: CONFIG.temperature,
        max_tokens: CONFIG.maxTokens,
        stream: true,
        ...modelOptions(model),
      }),
      signal: attempt.signal,
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      console.error(`  Erreur API ${upstream.status} (${model}) : ${detail.slice(0, 300)}`);
      if (upstream.status === 404 || upstream.status === 410) retiredModels.add(model);
      parentSignal.removeEventListener("abort", relay);
      return {
        ok: false,
        // Clé refusée ou quota atteint : inutile d'essayer un autre modèle.
        fatal: [401, 403, 429].includes(upstream.status),
        error: upstreamErrorMessage(upstream.status, "", model),
      };
    }

    const iterator = upstream.body[Symbol.asyncIterator]();
    const first = await iterator.next();
    slowUntil.delete(model);
    return { ok: true, iterator, first };
  } catch {
    parentSignal.removeEventListener("abort", relay);
    if (timedOut) {
      console.error(`  Le modèle « ${model} » n'a pas répondu en ${FIRST_CHUNK_TIMEOUT / 1000} s.`);
      slowUntil.set(model, Date.now() + 5 * 60 * 1000);
      return { ok: false, error: "Le service NVIDIA est saturé pour le moment. Réessayez dans quelques instants." };
    }
    return {
      ok: false,
      fatal: true,
      error: "Impossible de joindre l'API NVIDIA. Vérifiez votre connexion internet puis réessayez.",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Fichiers statiques ----------
function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Introuvable");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

// ---------- Serveur ----------
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") return handleChat(req, res);
  if (req.method === "GET" && req.url === "/api/health") {
    return sendJson(res, 200, { ...health, model: currentModel() });
  }
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405);
  res.end();
});

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* ouverture manuelle */
  }
}

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\nLe port ${CONFIG.port} est déjà utilisé. L'application tourne peut-être déjà : ouvrez http://localhost:${CONFIG.port}`);
    console.error("Sinon, changez PORT dans le fichier .env.\n");
    process.exit(1);
  }
  throw e;
});

server.listen(CONFIG.port, async () => {
  const url = `http://localhost:${CONFIG.port}`;
  console.log("\nElio — pré-diagnostic robotisation");
  console.log(`  Application : ${url}`);
  await Promise.all([checkApiKey(), cacheBrandAssets()]);
  console.log(`  Modèle      : ${currentModel()}`);
  console.log(`  Clé API     : ${health.message}`);
  console.log("\nLaissez cette fenêtre ouverte pendant l'utilisation. Ctrl+C pour arrêter.\n");
  if (CONFIG.openBrowser) openBrowser(url);
});
