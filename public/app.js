// Elio — logique de l'interface de chat.
// Le navigateur n'a jamais accès à la clé API : il parle uniquement au serveur local (/api/chat).

(() => {
  "use strict";

  const CONTACT_URL = "https://www.elio-robot.fr/contact";
  const STORAGE_KEY = "elio-conversation-v1";
  const THEME_KEY = "elio-theme";

  const WELCOME =
    "Bonjour, je suis Elio, l'assistant de pré-diagnostic d'Elio Robot. En 5 questions maximum, environ 3 minutes, je vous dis franchement si un robot de service est pertinent pour votre activité, et lequel. Si c'est le cas, je vous prépare un récapitulatif à transmettre à nos ingénieurs.\n\n" +
    "Question 1/5 : dans quel secteur travaillez-vous ?\n" +
    "1. Restauration\n2. Hôtellerie\n3. Commerce / retail\n4. Santé / EHPAD\n5. Logistique / entrepôt\n6. Espaces verts\n7. Autre";

  const $ = (sel) => document.querySelector(sel);
  const thread = $("#thread");
  const form = $("#composer");
  const input = $("#input");
  const sendBtn = $("#sendBtn");
  const counter = $("#counter");
  const restartBtn = $("#restartBtn");
  const restartLabel = $("#restartLabel");
  const themeBtn = $("#themeBtn");
  const healthNotice = $("#healthNotice");
  const chatStatus = $("#chatStatus");
  const onlineDot = $("#onlineDot");
  const routeText = $("#routeText");
  const robotMarker = $("#robotMarker");
  const jumpBtn = $("#jumpBtn");
  const toastEl = $("#toast");

  const isTouch = window.matchMedia("(pointer: coarse)").matches;

  let history = [];
  let current = null; // requête en cours : { controller, reason }
  let stickToBottom = true;

  // Le stockage du navigateur peut être indisponible (navigation privée) : on s'en passe.
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignoré */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignoré */ } },
  };

  const icon = (id) => `<svg aria-hidden="true"><use href="#${id}"/></svg>`;

  // ---------------------------------------------------------------------------
  // Identité visuelle : mascotte et logo
  // ---------------------------------------------------------------------------

  // Illustration de remplacement si l'image de la mascotte n'a pas pu être récupérée.
  const FALLBACK_MASCOT =
    '<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Elio">' +
    '<line x1="60" y1="18" x2="60" y2="30" stroke="#f26b21" stroke-width="4" stroke-linecap="round"/>' +
    '<circle cx="60" cy="15" r="6" fill="#f26b21"/>' +
    '<rect x="22" y="32" width="76" height="58" rx="24" fill="#f26b21"/>' +
    '<rect x="31" y="42" width="58" height="36" rx="16" fill="#161d2e"/>' +
    '<circle cx="48" cy="59" r="6" fill="#ffb35c"/>' +
    '<circle cx="72" cy="59" r="6" fill="#ffb35c"/>' +
    '<rect x="44" y="94" width="32" height="10" rx="5" fill="#161d2e"/>' +
    "</svg>";

  let mascotSrc = null;

  function setupBrand() {
    const mascotImg = $("#mascotImg");
    const probe = new Image();
    probe.onload = () => {
      mascotSrc = probe.src;
      paintAvatars();
    };
    probe.onerror = () => {
      $("#mascotWrap").innerHTML = FALLBACK_MASCOT;
      paintAvatars();
    };
    probe.src = mascotImg.getAttribute("src");

    const logo = $("#brandLogo");
    const showWordmark = () => {
      logo.hidden = true;
      $("#brandWordmark").hidden = false;
    };
    if (logo.complete && logo.naturalWidth === 0) showWordmark();
    else logo.addEventListener("error", showWordmark);
  }

  function avatarMarkup() {
    return mascotSrc ? `<img src="${mascotSrc}" alt="">` : FALLBACK_MASCOT;
  }

  function paintAvatars() {
    document.querySelectorAll("[data-avatar]").forEach((el) => {
      el.innerHTML = avatarMarkup();
    });
    robotMarker.innerHTML = mascotSrc ? `<img src="${mascotSrc}" alt="">` : "";
    robotMarker.classList.toggle("no-img", !mascotSrc);
  }

  // ---------------------------------------------------------------------------
  // Thème clair / sombre
  // ---------------------------------------------------------------------------

  function currentTheme() {
    const t = document.documentElement.dataset.theme;
    if (t === "light" || t === "dark") return t;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function labelThemeButton() {
    themeBtn.setAttribute("aria-label", currentTheme() === "dark" ? "Passer en mode clair" : "Passer en mode sombre");
  }

  themeBtn.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set(THEME_KEY, next);
    labelThemeButton();
  });

  // ---------------------------------------------------------------------------
  // État de la clé API (vérifiée par le serveur au démarrage) et de la connexion
  // ---------------------------------------------------------------------------

  function showNotice(message, level) {
    healthNotice.textContent = message;
    healthNotice.classList.toggle("error", level === "error");
    healthNotice.hidden = false;
    onlineDot.classList.toggle("is-off", level === "error");
  }

  function hideNotice() {
    healthNotice.hidden = true;
    onlineDot.classList.remove("is-off");
  }

  async function checkHealth(attempt = 0) {
    try {
      const r = await fetch("/api/health");
      const h = await r.json();
      if (h.status === "checking" && attempt < 15) {
        setTimeout(() => checkHealth(attempt + 1), 1000);
        return;
      }
      if (h.status === "error" || h.status === "warning") showNotice(h.message, h.status);
      else hideNotice();
    } catch {
      showNotice("Le serveur local ne répond pas. Vérifiez que la fenêtre du serveur est toujours ouverte.", "error");
    }
  }

  window.addEventListener("offline", () =>
    showNotice("Connexion internet perdue : Elio pourra répondre dès qu'elle sera rétablie.", "error")
  );
  window.addEventListener("online", () => checkHealth());

  // ---------------------------------------------------------------------------
  // Lecture de la réponse du modèle
  // ---------------------------------------------------------------------------

  // Certains modèles écrivent leur raisonnement entre balises <think> : on le masque.
  function stripThinking(text) {
    let t = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
    const open = t.search(/<think>/i);
    if (open !== -1) t = t.slice(0, open);
    return t.replace(/^\s+/, "");
  }

  const VERDICT_RE = /Verdict\s*:?\s*\**\s*(Adapt[ée]|[ÀA]\s*[ée]tudier|Hors\s+p[ée]rim[èe]tre)/i;

  function detectVerdict(text) {
    const m = text.match(VERDICT_RE);
    if (!m) return null;
    const v = m[1].toLowerCase();
    if (v.startsWith("adapt")) return { key: "ok", label: "Adapté", icon: "i-check" };
    if (v.includes("tudier")) return { key: "warn", label: "À étudier", icon: "i-alert" };
    return { key: "off", label: "Hors périmètre", icon: "i-x" };
  }

  // Retire la mention « Verdict : … » du texte : elle est remplacée par un badge coloré.
  function stripVerdictLine(text) {
    return text.replace(
      /^[ \t>#•-]*\**\s*Verdict\s*:?\s*\**\s*(?:Adapt[ée]|[ÀA]\s*[ée]tudier|Hors\s+p[ée]rim[èe]tre)\s*\**\s*[.:—–-]?[ \t]*/im,
      ""
    );
  }

  function detectQuestion(text) {
    const all = [...text.matchAll(/Question\s*(\d)\s*(?:\/|sur)\s*5/gi)];
    return all.length ? Number(all[all.length - 1][1]) : null;
  }

  const OPTION_RE = /^\s*(?:[-*•]\s*)?(\d{1,2})\s*[.)]\s+(.+?)\s*$/;
  const OPTIONS_INTRO_RE = /^\s*\**\s*(options|choix|réponses possibles)\s*\**\s*:?\s*\**\s*$/i;

  // Repère la liste d'options numérotées pour en faire des boutons.
  // Cas courant : la liste termine le message. Certains modèles ajoutent ensuite
  // une courte phrase : on l'accepte si le message pose une « Question X/5 ».
  function extractOptions(text) {
    const lines = text.replace(/\s+$/, "").split("\n");

    let end = lines.length - 1;
    while (end >= 0 && !OPTION_RE.test(lines[end])) end--;
    if (end >= 0) {
      const trailing = lines.slice(end + 1).join("\n").trim();
      const tolerated = !trailing || (trailing.length <= 280 && detectQuestion(text) !== null);
      if (tolerated) {
        let start = end;
        const options = [];
        for (let i = end; i >= 0; i--) {
          if (!lines[i].trim()) continue; // lignes vides entre deux options
          const m = lines[i].match(OPTION_RE);
          if (!m) break;
          options.unshift(cleanOption(m[2]));
          start = i;
        }
        if (options.length >= 2) {
          let cut = start;
          if (cut > 0 && OPTIONS_INTRO_RE.test(lines[cut - 1])) cut--;
          const before = lines.slice(0, cut).join("\n").replace(/\s+$/, "");
          return { options, text: trailing ? `${before}\n\n${trailing}` : before };
        }
      }
    }

    // Options écrites sur une seule ligne : « 1. Restauration 2. Hôtellerie … »
    const last = lines[lines.length - 1] || "";
    if (/(^|\s)1\s*[.)]\s+\S.*\s2\s*[.)]\s+\S/.test(last)) {
      const start = last.search(/(^|\s)1\s*[.)]\s/);
      const parts = last
        .slice(start)
        .split(/\s*\b\d{1,2}\s*[.)]\s+/)
        .map((p) => cleanOption(p))
        .filter(Boolean);
      if (parts.length >= 2) {
        const prefix = last.slice(0, start).replace(/\s*(options|choix)\s*:?\s*$/i, "").trim();
        const kept = lines.slice(0, -1);
        if (prefix) kept.push(prefix);
        return { options: parts, text: kept.join("\n").replace(/\s+$/, "") };
      }
    }
    return { options: [], text };
  }

  function cleanOption(s) {
    return s.replace(/\*\*/g, "").replace(/[;,»]\s*$/, "").replace(/\s+[–-]\s*$/, "").trim();
  }

  // Une option du type « Autre (précisez) » ouvre la saisie au lieu d'envoyer directement.
  const needsDetail = (opt) => /\(\s*pr[ée]cisez\s*\)|^autre\s*$/i.test(opt);

  // ---------------------------------------------------------------------------
  // Mise en forme (Markdown simplifié, sans HTML injecté)
  // ---------------------------------------------------------------------------

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function inline(s) {
    let t = escapeHtml(s);
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    t = t.replace(/(^|[\s(«])(https?:\/\/[^\s<)»]+[^\s<)».,;:!?])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    t = t.replace(/(^|[\s(«])([\w.+-]+@[\w-]+\.[\w.-]+[a-z])/gi, '$1<a href="mailto:$2">$2</a>');
    return t;
  }

  // Si le modèle n'a pas mis le récapitulatif dans un bloc de code, on le repère quand même.
  function fenceRecap(text) {
    if (/```/.test(text)) return text;
    return text.replace(
      /^[ \t]*\**Pré-diagnostic Elio[^\n]*\n(?:[ \t]*[-•*][^\n]*(?:\n|$))+/m,
      (block) => "```\n" + block.replace(/\*\*/g, "").trim() + "\n```\n"
    );
  }

  function renderMarkdown(text) {
    const src = fenceRecap(text);
    const out = [];
    const lines = src.split("\n");
    let list = null; // { type: "ul"|"ol", items: [] }
    let para = [];

    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.type}>`);
      list = null;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/^\s*```/.test(line)) {
        flushPara(); flushList();
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        out.push(recapBlock(code.join("\n").trim()));
        continue;
      }

      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); flushList(); continue; }

      const ul = line.match(/^\s*[-*•]\s+(.*)$/);
      const ol = line.match(/^\s*\d{1,2}[.)]\s+(.*)$/);
      const h = line.match(/^\s*#{1,4}\s+(.*)$/);

      if (h) { flushPara(); flushList(); out.push(`<h3>${inline(h[1])}</h3>`); }
      else if (ul || ol) {
        flushPara();
        const type = ul ? "ul" : "ol";
        if (list && list.type !== type) flushList();
        if (!list) list = { type, items: [] };
        list.items.push((ul || ol)[1].trim());
      } else if (!line.trim()) { flushPara(); flushList(); }
      else { flushList(); para.push(line.trim()); }
    }
    flushPara(); flushList();
    return out.join("");
  }

  let recapCount = 0;
  function recapBlock(code) {
    const id = `recap-${++recapCount}`;
    return (
      `<div class="recap"><div class="recap-head"><span>Récapitulatif à envoyer</span>` +
      `<button type="button" class="copy-btn" data-copy="${id}">${icon("i-copy")}<span>Copier</span></button></div>` +
      `<pre id="${id}">${escapeHtml(code)}</pre></div>`
    );
  }

  // ---------------------------------------------------------------------------
  // Défilement : on suit la réponse, sauf si l'utilisateur est remonté lire
  // ---------------------------------------------------------------------------

  const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 90;

  thread.addEventListener("scroll", () => {
    stickToBottom = nearBottom();
    if (stickToBottom) jumpBtn.hidden = true;
  });

  function scrollToEnd(force) {
    if (force || stickToBottom) {
      thread.scrollTop = thread.scrollHeight;
      stickToBottom = true;
      jumpBtn.hidden = true;
    } else {
      jumpBtn.hidden = false;
    }
  }

  jumpBtn.addEventListener("click", () => {
    stickToBottom = true;
    thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" });
    jumpBtn.hidden = true;
  });

  // ---------------------------------------------------------------------------
  // Affichage des messages
  // ---------------------------------------------------------------------------

  function addUserMessage(text) {
    const el = document.createElement("div");
    el.className = "msg user";
    el.innerHTML = `<div class="msg-body"><div class="bubble"></div></div>`;
    el.querySelector(".bubble").textContent = text;
    thread.appendChild(el);
    return el;
  }

  function addBotShell() {
    const el = document.createElement("div");
    el.className = "msg bot pending";
    el.innerHTML =
      `<span class="avatar" data-avatar>${avatarMarkup()}</span>` +
      `<div class="msg-body"><div class="bubble">` +
      `<span class="thinking"><span class="typing" aria-hidden="true"><span></span><span></span><span></span></span>` +
      `<span class="thinking-label">Elio réfléchit…</span></span>` +
      `</div></div>`;
    thread.appendChild(el);
    // Le libellé n'apparaît que si l'attente se prolonge.
    setTimeout(() => {
      const label = el.querySelector(".thinking-label");
      if (label) label.classList.add("show");
    }, 1200);
    return el;
  }

  function renderBot(el, rawText, final, opts = {}) {
    const bubble = el.querySelector(".bubble");
    const body = el.querySelector(".msg-body");
    const text = stripThinking(rawText);

    if (!text) return; // l'indicateur « Elio réfléchit » reste affiché
    el.classList.remove("pending");

    if (!final) {
      bubble.classList.add("streaming");
      bubble.innerHTML = renderMarkdown(text);
      scrollToEnd();
      return;
    }

    bubble.classList.remove("streaming", "verdict", "v-ok", "v-warn", "v-off");
    const verdict = detectVerdict(text);
    const { options, text: shown } = verdict ? { options: [], text: stripVerdictLine(text) } : extractOptions(text);

    let html = renderMarkdown(shown);
    if (verdict) {
      bubble.classList.add("verdict", `v-${verdict.key}`);
      html = `<p class="verdict-badge"><span class="v-icon">${icon(verdict.icon)}</span>Verdict : ${verdict.label}</p>` + html;
    }
    bubble.innerHTML = html;

    body.querySelectorAll(".chips, .cta-row").forEach((n) => n.remove());

    if (options.length && opts.interactive !== false) {
      const chips = document.createElement("div");
      chips.className = "chips";
      chips.setAttribute("role", "group");
      chips.setAttribute("aria-label", "Réponses proposées");
      options.forEach((opt, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.style.animationDelay = `${80 + i * 45}ms`;
        b.innerHTML = `<span class="key" aria-hidden="true">${i + 1}</span><span></span>`;
        b.lastChild.textContent = opt;
        b.addEventListener("click", () => pickOption(opt));
        chips.appendChild(b);
      });
      body.appendChild(chips);
    }

    // Bouton d'action vers le formulaire de contact Elio dès que le lien est donné.
    if (/elio-robot\.fr\/contact|contact@elio-robot\.fr/i.test(text)) {
      const recap = bubble.querySelector(".recap pre");
      const row = document.createElement("div");
      row.className = "cta-row";
      const cta = document.createElement("button");
      cta.type = "button";
      cta.className = "cta";
      cta.innerHTML = `<span></span>${icon("i-arrow")}`;
      cta.firstChild.textContent = recap ? "Copier le récapitulatif et ouvrir le formulaire" : "Contacter l'équipe Elio";
      cta.addEventListener("click", async () => {
        if (recap && (await copyText(recap.textContent))) toast("Récapitulatif copié : collez-le dans « Votre message »");
        window.open(CONTACT_URL, "_blank", "noopener");
      });
      row.appendChild(cta);
      body.appendChild(row);
    }

    if (opts.scroll === false) return;
    // Un verdict est long : on le montre depuis son début plutôt que depuis sa fin.
    if (verdict) el.scrollIntoView({ block: "start", behavior: "smooth" });
    else scrollToEnd();
  }

  function addError(message, retry) {
    const el = document.createElement("div");
    el.className = "error-card";
    el.setAttribute("role", "alert");
    el.innerHTML = `<span></span>`;
    el.querySelector("span").textContent = message;
    if (retry) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Réessayer";
      b.addEventListener("click", () => {
        el.remove();
        retry();
      });
      el.appendChild(b);
    }
    thread.appendChild(el);
    scrollToEnd(true);
  }

  // Bouton « Modifier » sous la dernière réponse du prospect.
  function refreshEditTool() {
    thread.querySelectorAll(".msg-tools").forEach((n) => n.remove());
    if (current) return;
    const users = thread.querySelectorAll(".msg.user");
    const last = users[users.length - 1];
    if (!last) return;
    const tools = document.createElement("div");
    tools.className = "msg-tools";
    tools.innerHTML = `<button type="button" class="link-btn">${icon("i-edit")}<span>Modifier ma réponse</span></button>`;
    tools.firstChild.addEventListener("click", editLastAnswer);
    last.querySelector(".msg-body").appendChild(tools);
  }

  // Réaffiche toute la conversation (reprise après rechargement, modification).
  function renderAll() {
    thread.innerHTML = "";
    history.forEach((m, i) => {
      if (m.role === "user") addUserMessage(m.content);
      else renderBot(addBotShell(), m.content, true, { interactive: i === history.length - 1, scroll: false });
    });
    thread.querySelectorAll(".msg, .chip, .cta").forEach((n) => (n.style.animation = "none"));
    updateProgress();
    refreshEditTool();
    scrollToEnd(true);
  }

  let toastTimer = null;
  function toast(message) {
    toastEl.innerHTML = `${icon("i-check")}<span></span>`;
    toastEl.lastChild.textContent = message;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2800);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  }

  thread.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-copy]");
    if (!btn) return;
    const pre = document.getElementById(btn.dataset.copy);
    if (pre && (await copyText(pre.textContent))) {
      btn.classList.add("done");
      btn.innerHTML = `${icon("i-check")}<span>Copié</span>`;
      toast("Récapitulatif copié");
      setTimeout(() => {
        btn.classList.remove("done");
        btn.innerHTML = `${icon("i-copy")}<span>Copier</span>`;
      }, 2000);
    }
  });

  // ---------------------------------------------------------------------------
  // Progression : le robot avance sur le parcours
  // ---------------------------------------------------------------------------

  function progressState() {
    let lastQuestion = 1;
    let verdict = null;
    for (const m of history) {
      if (m.role !== "assistant") continue;
      const v = detectVerdict(m.content);
      if (v) verdict = v;
      const q = detectQuestion(m.content);
      if (q) lastQuestion = Math.max(lastQuestion, q);
    }
    return { lastQuestion, verdict, step: verdict ? 6 : lastQuestion };
  }

  function updateProgress() {
    const { lastQuestion, verdict, step } = progressState();

    // Avec un verdict anticipé, les étapes sautées restent en pointillé :
    // le parcours montre visuellement qu'Elio a écourté le questionnaire.
    const answered = verdict ? lastQuestion : lastQuestion - 1;
    const items = document.querySelectorAll(".route-track li");
    items.forEach((li) => {
      const n = Number(li.dataset.step);
      const passed = n <= answered || (verdict && n === 6);
      // trail = segment plein entre cette étape et la suivante.
      const trail = verdict ? n < answered || (n === 5 && answered === 5) : n <= answered;
      li.classList.toggle("passed", passed);
      li.classList.toggle("trail", Boolean(trail));
      li.classList.toggle("current", n === step);
      li.classList.toggle("reached", Boolean(verdict) && n === 6);
    });

    const goal = document.querySelector(".route-track li.goal");
    const route = document.getElementById("route");
    ["v-ok", "v-warn", "v-off"].forEach((c) => {
      goal.classList.remove(c);
      route.classList.remove(c);
    });
    if (verdict) {
      goal.classList.add(`v-${verdict.key}`);
      route.classList.add(`v-${verdict.key}`);
    }

    const target = document.querySelector(`.route-track li[data-step="${step}"] .node`);
    if (target) {
      const tr = target.getBoundingClientRect();
      const rr = route.getBoundingClientRect();
      robotMarker.style.left = `${tr.left - rr.left + tr.width / 2}px`;
      robotMarker.style.top = `${tr.top - rr.top + tr.height / 2 - robotMarker.offsetHeight / 2}px`;
    }

    if (verdict) {
      routeText.textContent = `Verdict : ${verdict.label}`;
      if (!current) chatStatus.textContent = "Pré-diagnostic terminé";
    } else {
      routeText.textContent = `Question ${step} sur 5`;
      if (!current) chatStatus.textContent = "Pré-diagnostic en cours";
    }
  }

  window.addEventListener("resize", updateProgress);

  // ---------------------------------------------------------------------------
  // Échange avec le serveur
  // ---------------------------------------------------------------------------

  function save() {
    store.set(STORAGE_KEY, JSON.stringify(history));
  }

  function updateSendState() {
    const busy = Boolean(current);
    sendBtn.classList.toggle("is-stop", busy);
    sendBtn.disabled = !busy && !input.value.trim();
    sendBtn.setAttribute("aria-label", busy ? "Arrêter la réponse" : "Envoyer");
    input.setAttribute("aria-busy", String(busy));
    const len = input.value.length;
    counter.hidden = len < 1200;
    counter.textContent = `${len}/1500`;
  }

  function setStatusBusy(busy) {
    if (busy) chatStatus.textContent = "Elio rédige sa réponse…";
    else updateProgress();
  }

  function pickOption(opt) {
    if (current) return;
    if (needsDetail(opt)) {
      input.value = opt.replace(/\s*\(\s*pr[ée]cisez\s*\)\s*/i, "").trim() + " : ";
      autosize();
      updateSendState();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    send(opt);
  }

  async function send(text) {
    const content = (text || "").trim();
    if (!content || current) return;

    // Les boutons de la question précédente ne servent plus.
    thread.querySelectorAll(".chips, .msg-tools").forEach((n) => n.remove());

    history.push({ role: "user", content });
    save();
    addUserMessage(content);
    scrollToEnd(true);
    input.value = "";
    autosize();
    await requestReply();
  }

  function abortCurrent(reason) {
    if (!current) return;
    current.reason = reason;
    current.controller.abort();
    current = null;
    updateSendState();
    setStatusBusy(false);
  }

  // Arrêt demandé avant tout début de réponse : la question est rendue à la saisie.
  function restoreLastUserMessage() {
    if (!history.length || history[history.length - 1].role !== "user") return;
    const text = history.pop().content;
    save();
    renderAll();
    input.value = text;
    autosize();
    updateSendState();
  }

  async function requestReply() {
    const req = { controller: new AbortController(), reason: null };
    current = req;
    updateSendState();
    setStatusBusy(true);

    const el = addBotShell();
    scrollToEnd(true);
    let raw = "";

    try {
      let r;
      try {
        r = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history }),
          signal: req.controller.signal,
        });
      } catch (e) {
        if (e.name === "AbortError") throw e;
        throw new Error("Le serveur local ne répond pas. Vérifiez que la fenêtre du serveur est toujours ouverte.");
      }

      if (!r.ok || !r.body) {
        let msg = "Elio n'a pas pu répondre.";
        try { msg = (await r.json()).error || msg; } catch { /* réponse non JSON */ }
        throw new Error(msg);
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;
          let json;
          try { json = JSON.parse(data); } catch { continue; /* fragment incomplet ignoré */ }
          if (json.error) throw new Error("La réponse d'Elio a été interrompue par le service. Réessayez.");
          const piece = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
          if (piece) {
            raw += piece;
            renderBot(el, raw, false);
          }
        }
      }

      const finalText = stripThinking(raw).trim();
      if (!finalText) throw new Error("Elio n'a renvoyé aucune réponse. Réessayez.");

      history.push({ role: "assistant", content: finalText });
      save();
      current = null;
      renderBot(el, finalText, true);
    } catch (err) {
      if (req.reason === "reset") return;
      if (req.reason === "stop") {
        const partial = stripThinking(raw).trim();
        if (partial) {
          history.push({ role: "assistant", content: partial });
          save();
          renderBot(el, partial, true);
        } else {
          el.remove();
          restoreLastUserMessage();
        }
      } else {
        el.remove();
        addError(err.message || "Elio n'a pas pu répondre.", () => requestReply());
      }
    } finally {
      if (current === req) current = null;
      if (req.reason !== "reset") {
        updateSendState();
        setStatusBusy(false);
        refreshEditTool();
        if (!isTouch) input.focus();
      }
    }
  }

  function editLastAnswer() {
    abortCurrent("reset");
    let idx = history.length - 1;
    while (idx >= 0 && history[idx].role !== "user") idx--;
    if (idx < 0) return;
    const text = history[idx].content;
    history = history.slice(0, idx);
    save();
    renderAll();
    input.value = text;
    autosize();
    updateSendState();
    input.focus();
    input.setSelectionRange(text.length, text.length);
  }

  // ---------------------------------------------------------------------------
  // Saisie
  // ---------------------------------------------------------------------------

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
    input.style.overflowY = input.scrollHeight > 160 ? "auto" : "hidden";
  }

  // Sur petit écran, un texte d'aide court tient sur une ligne.
  const narrow = window.matchMedia("(max-width: 520px)");
  const setPlaceholder = () => {
    input.placeholder = narrow.matches ? "Votre réponse…" : "Choisissez une option ou écrivez votre réponse…";
    autosize();
  };
  narrow.addEventListener("change", setPlaceholder);
  setPlaceholder();

  input.addEventListener("input", () => {
    autosize();
    updateSendState();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!current) send(input.value);
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (current) abortCurrent("stop");
    else send(input.value);
  });

  // Touches 1 à 9 : choisir une réponse proposée (quand la zone de saisie est vide).
  document.addEventListener("keydown", (e) => {
    if (current || e.ctrlKey || e.metaKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
    const active = document.activeElement;
    const typing = active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT");
    if (typing && (active !== input || input.value !== "")) return;
    const chips = thread.querySelectorAll(".chips .chip");
    const chip = chips[Number(e.key) - 1];
    if (!chip) return;
    e.preventDefault();
    chip.click();
  });

  // ---------------------------------------------------------------------------
  // Démarrage, reprise et remise à zéro
  // ---------------------------------------------------------------------------

  let confirmTimer = null;
  function resetConfirm() {
    clearTimeout(confirmTimer);
    restartBtn.classList.remove("is-confirm");
    restartLabel.textContent = "Recommencer";
    restartBtn.removeAttribute("aria-label");
  }

  restartBtn.addEventListener("click", () => {
    const started = history.some((m) => m.role === "user");
    if (started && !restartBtn.classList.contains("is-confirm")) {
      restartBtn.classList.add("is-confirm");
      restartLabel.textContent = "Confirmer ?";
      restartBtn.setAttribute("aria-label", "Confirmer : effacer la conversation et recommencer");
      toast("Cliquez à nouveau pour effacer la conversation");
      confirmTimer = setTimeout(resetConfirm, 4000);
      return;
    }
    resetConfirm();
    start();
  });

  function start() {
    abortCurrent("reset");
    history = [{ role: "assistant", content: WELCOME }];
    store.del(STORAGE_KEY);
    renderAll();
    thread.querySelectorAll(".msg, .chip").forEach((n) => (n.style.animation = ""));
    input.value = "";
    autosize();
    updateSendState();
    if (!isTouch) input.focus();
  }

  // Reprend la conversation en cours si la page a été rechargée.
  function resume() {
    try {
      const saved = JSON.parse(store.get(STORAGE_KEY) || "null");
      const valid =
        Array.isArray(saved) &&
        saved.length > 1 &&
        saved.every((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") &&
        saved[0].role === "assistant";
      if (!valid) return false;
      history = saved;
      renderAll();
      updateSendState();
      if (history[history.length - 1].role === "user") requestReply();
      return true;
    } catch {
      return false;
    }
  }

  setupBrand();
  labelThemeButton();
  checkHealth();
  if (!resume()) start();
})();
