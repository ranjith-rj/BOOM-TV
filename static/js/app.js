/* GTV IPTV Player - frontend logic */
(() => {
  "use strict";

  // ------------------------------------------------------------------ config
  const LS = { last: "gtv.lastChannel", volume: "gtv.volume", muted: "gtv.muted", proxy: "gtv.useProxy", favorites: "gtv.favoriteChannels" };
  const REFRESH_MS = 5 * 60 * 1000;     // auto-refresh channel list
  const HEALTH_MS = 30 * 1000;          // server status polling
  const MAX_NET_RETRIES = 3;
  const MAX_MEDIA_RECOVERIES = 2;
  const AUTO_OPEN_LIMIT = 200;          // groups start collapsed above this many channels

  // ---------------------------------------------------------------- helpers
  const $ = (sel) => document.querySelector(sel);
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  async function fetchJson(url, timeoutMs = 25000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      let data = null;
      try { data = await res.json(); } catch { /* non-JSON body */ }
      if (!res.ok) throw new Error((data && data.error) || `Server returned HTTP ${res.status}`);
      if (!data) throw new Error("Server returned an invalid response.");
      return data;
    } catch (err) {
      if (err.name === "AbortError") throw new Error("The request timed out.");
      if (err instanceof TypeError) throw new Error("Cannot reach the GTV server. Is app.py running?");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // --------------------------------------------------------------- elements
  const el = {
    video: $("#video"), wrap: $("#playerWrap"), overlay: $("#overlay"), overlayText: $("#overlayText"), overlayBtn: $("#overlayBtn"),
    list: $("#channelList"), listState: $("#listState"), search: $("#searchInput"), category: $("#categorySelect"), count: $("#countLabel"),
    tabs: $("#channelTabs"), favCount: $("#favCount"), npStar: $("#npStar"),
    status: $("#serverStatus"), refresh: $("#refreshBtn"), proxy: $("#proxyToggle"),
    play: $("#playBtn"), prev: $("#prevBtn"), next: $("#nextBtn"), mute: $("#muteBtn"), volume: $("#volume"),
    reload: $("#reloadBtn"), fs: $("#fsBtn"), toast: $("#toast"),
    npName: $("#npName"), npGroup: $("#npGroup"), npLogo: $("#npLogo"),
  };

  // ------------------------------------------------------------------ state
  const state = {
    channels: [], byId: new Map(), category: "all", query: "",
    favorites: loadFavorites(), tab: "all",
    current: null, hls: null, token: 0,
    netRetries: 0, mediaRecoveries: 0, proxyFallbackTried: false, directTried: false, usingProxy: false,
    signature: "", retryTimer: null,
  };

  function loadFavorites() {
    try {
      const saved = JSON.parse(store.get(LS.favorites, "[]"));
      return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : []);
    } catch {
      return new Set();
    }
  }

  // ------------------------------------------------------------- UI helpers
  let toastTimer;
  function toast(msg, ms = 3500) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), ms);
  }

  function setServerStatus(stateName, text) {
    el.status.dataset.state = stateName;
    el.status.querySelector("span").textContent = text;
  }

  function setOverlay(mode, text = "", showRetry = false) {
    el.overlay.dataset.mode = mode;
    el.overlayText.textContent = text;
    el.overlayBtn.hidden = !showRetry;
  }

  function setIcon(btn, id) { btn.querySelector("use").setAttribute("href", `#${id}`); }

  function showListState(kind, message = "") {
    const box = el.listState;
    box.hidden = false;
    box.className = "list-state" + (kind === "error" ? " error" : "");
    if (kind === "loading") {
      box.innerHTML = '<div class="spinner"></div><div>Loading channels…</div>';
    } else if (kind === "error") {
      box.innerHTML = `<strong>Couldn't load channels</strong><div>${esc(message)}</div><button class="btn primary" id="listRetry" type="button">Try again</button>`;
      $("#listRetry").addEventListener("click", () => loadChannels({ force: true }));
    } else {
      box.textContent = message;
    }
  }
  const hideListState = () => { el.listState.hidden = true; };

  // --------------------------------------------------------------- channels
  async function loadChannels({ force = false, silent = false } = {}) {
    if (!silent) {
      showListState("loading");
      el.list.innerHTML = "";
    }
    el.refresh.classList.add("spinning");
    try {
      const data = await fetchJson("/api/channels" + (force ? "?refresh=1" : ""));
      const sig = data.channels.map((c) => c.id + "|" + c.url).join("\n");
      const changed = sig !== state.signature;
      state.signature = sig;
      state.channels = data.channels;
      state.byId = new Map(data.channels.map((c) => [c.id, c]));

      if (changed || !silent) {
        buildCategorySelect(data.categories);
        renderChannels();
      }
      if (!data.channels.length) {
        showListState("info", "The playlist was loaded but contains no channels.");
      } else {
        hideListState();
      }
      if (data.stale) {
        setServerStatus("warn", `Showing cached list (${data.count})`);
        if (!silent) toast("IPTV server unreachable – showing the last known channel list.");
      } else {
        setServerStatus("ok", `${data.count} channels`);
      }
      if (!state.current) restoreLastChannel();
      if (silent && changed) toast("Channel list updated.");
      else if (force && !silent) toast("Channel list refreshed.");
    } catch (err) {
      if (state.channels.length) {
        setServerStatus("warn", "Refresh failed");
        toast(`Couldn't refresh channels: ${err.message}`);
      } else {
        setServerStatus("error", "Unavailable");
        showListState("error", err.message);
      }
    } finally {
      el.refresh.classList.remove("spinning");
    }
  }

  function buildCategorySelect(categories) {
    const prev = state.category;
    el.category.innerHTML = '<option value="all">All categories</option>' +
      categories.map((c) => `<option value="${esc(c.name)}">${esc(c.name)} (${c.count})</option>`).join("");
    const exists = categories.some((c) => c.name === prev);
    state.category = exists ? prev : "all";
    el.category.value = state.category;
  }

  function filteredChannels() {
    const q = state.query.trim().toLowerCase();
    return state.channels.filter((c) =>
      (state.tab !== "fav" || state.favorites.has(c.id)) &&
      (state.category === "all" || c.group === state.category) &&
      (!q || c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)));
  }

  function renderChannels() {
    const items = filteredChannels();
    const favoriteCount = state.channels.filter((ch) => state.favorites.has(ch.id)).length;
    const total = state.tab === "fav" ? favoriteCount : state.channels.length;
    el.count.textContent = `${items.length} / ${total}`;
    el.favCount.textContent = String(favoriteCount);
    el.tabs.querySelectorAll(".tab").forEach((tab) => {
      const active = tab.dataset.tab === state.tab;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-pressed", String(active));
    });
    if (!items.length) {
      el.list.innerHTML = "";
      if (state.tab === "fav") {
        const hasFavorites = state.channels.some((ch) => state.favorites.has(ch.id));
        el.list.innerHTML = `<div class="empty">${hasFavorites ? "No favorite channels match your filters." : "No favorites yet. Select ☆ beside a channel to add it."}</div>`;
        hideListState();
      } else if (state.channels.length) {
        showListState("info", "No channels match your search.");
      }
      return;
    }
    hideListState();

    const groups = new Map();
    for (const ch of items) {
      if (!groups.has(ch.group)) groups.set(ch.group, []);
      groups.get(ch.group).push(ch);
    }
    const openAll = state.query.trim() !== "" || state.category !== "all" || items.length <= AUTO_OPEN_LIMIT;
    const currentGroup = state.current ? state.current.group : null;

    const html = [];
    for (const [name, chans] of groups) {
      const open = openAll || name === currentGroup;
      html.push(`<details${open ? " open" : ""}><summary>${esc(name)}<b>${chans.length}</b></summary>`);
      for (const ch of chans) html.push(channelHtml(ch));
      html.push("</details>");
    }
    el.list.innerHTML = html.join("");
  }

  function channelHtml(ch) {
    const initial = esc((ch.name.trim()[0] || "?").toUpperCase());
    const logo = ch.logo
      ? `<img src="${esc(ch.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.textContent='${initial}'">`
      : initial;
    const active = state.current && state.current.id === ch.id ? " active" : "";
    const favorite = state.favorites.has(ch.id);
    const favoriteTitle = favorite ? `Remove ${ch.name} from favorites` : `Add ${ch.name} to favorites`;
    return `<div class="chrow">
      <button type="button" class="channel${active}" role="listitem" data-id="${esc(ch.id)}" title="${esc(ch.name)}">
        <span class="logo">${logo}</span>
        <span class="meta"><div class="name">${esc(ch.name)}</div><div class="grp">${esc(ch.group)}</div></span>
      </button>
      <button type="button" class="star${favorite ? " on" : ""}" data-id="${esc(ch.id)}" title="${esc(favoriteTitle)}" aria-label="${esc(favoriteTitle)}" aria-pressed="${favorite}">${favorite ? "★" : "☆"}</button>
    </div>`;
  }

  function markActive() {
    el.list.querySelectorAll(".channel.active").forEach((n) => n.classList.remove("active"));
    if (!state.current) return;
    const node = el.list.querySelector(`.channel[data-id="${CSS.escape(state.current.id)}"]`);
    if (node) {
      node.classList.add("active");
      const details = node.closest("details");
      if (details && !details.open) details.open = true;
      node.scrollIntoView({ block: "nearest" });
    }
  }

  function restoreLastChannel() {
    const id = store.get(LS.last);
    const ch = id && state.byId.get(id);
    if (ch) {
      setNowPlaying(ch);
      state.current = ch;
      markActive();
      setOverlay("idle", `Press play to resume “${ch.name}”`, false);
    }
  }

  function setNowPlaying(ch) {
    el.npName.textContent = ch.name;
    el.npGroup.textContent = ch.group;
    el.npStar.hidden = false;
    updateNowPlayingStar(ch);
    if (ch.logo) { el.npLogo.src = ch.logo; el.npLogo.hidden = false; el.npLogo.onerror = () => { el.npLogo.hidden = true; }; }
    else el.npLogo.hidden = true;
    document.title = `${ch.name} – GTV IPTV Player`;
  }

  function updateNowPlayingStar(ch = state.current) {
    if (!ch) return;
    const favorite = state.favorites.has(ch.id);
    const label = favorite
      ? `Remove ${ch.name} from favorites`
      : `Add ${ch.name} to favorites`;
    el.npStar.textContent = favorite ? "★" : "☆";
    el.npStar.classList.toggle("on", favorite);
    el.npStar.title = label;
    el.npStar.setAttribute("aria-label", label);
    el.npStar.setAttribute("aria-pressed", String(favorite));
  }

  function toggleFavorite(id) {
    const channel = state.byId.get(id);
    if (!channel) return;
    if (state.favorites.has(id)) state.favorites.delete(id);
    else state.favorites.add(id);
    store.set(LS.favorites, JSON.stringify([...state.favorites]));
    renderChannels();
    markActive();
    updateNowPlayingStar();
  }

  function stepChannel(delta) {
    const list = filteredChannels();
    if (!list.length) return;
    const idx = state.current ? list.findIndex((c) => c.id === state.current.id) : -1;
    const next = list[(idx + delta + list.length) % list.length];
    playChannel(next);
  }

  // ----------------------------------------------------------------- player
  function destroyPlayer() {
    clearTimeout(state.retryTimer);
    if (state.hls) { try { state.hls.destroy(); } catch { /* ignore */ } state.hls = null; }
    el.video.removeAttribute("src");
    el.video.load();
  }

  function playChannel(ch) {
    state.current = ch;
    store.set(LS.last, ch.id);
    setNowPlaying(ch);
    markActive();
    state.netRetries = 0;
    state.mediaRecoveries = 0;
    state.proxyFallbackTried = false;
    state.directTried = false;
    startStream(ch, el.proxy.checked);
  }

  function streamSrc(ch, viaProxy) {
    return viaProxy ? `/api/stream?url=${encodeURIComponent(ch.url)}` : ch.url;
  }

  function startStream(ch, viaProxy) {
    destroyPlayer();
    const token = ++state.token;
    state.usingProxy = viaProxy;
    setOverlay("loading", `Loading ${ch.name}…`);
    const src = streamSrc(ch, viaProxy);

    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({ lowLatencyMode: true, maxBufferLength: 30, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 2, fragLoadingMaxRetry: 3 });
      state.hls = hls;
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => { if (token === state.token) tryPlay(); });
      hls.on(window.Hls.Events.ERROR, (_e, data) => { if (token === state.token) onHlsError(ch, data); });
      hls.loadSource(src);
      hls.attachMedia(el.video);
    } else if (el.video.canPlayType("application/vnd.apple.mpegurl")) {
      el.video.src = src; // Safari / iOS native HLS
      tryPlay();
    } else {
      el.video.src = src;
      tryPlay();
    }
  }

  function tryPlay() {
    const p = el.video.play();
    if (p && p.catch) {
      p.catch((err) => {
        if (err && err.name === "NotAllowedError") setOverlay("idle", "Click play to start the stream", false);
      });
    }
  }

  function onHlsError(ch, data) {
    if (!data.fatal) return;
    const H = window.Hls;
    const details = data.details || "";
    console.warn("HLS fatal error:", data.type, details);

    // Not an HLS manifest at all (e.g. direct MP4): hand it to the browser.
    if (details === H.ErrorDetails.MANIFEST_PARSING_ERROR && !state.directTried) {
      state.directTried = true;
      destroyPlayer();
      el.video.src = streamSrc(ch, state.usingProxy);
      tryPlay();
      return;
    }

    if (data.type === H.ErrorTypes.NETWORK_ERROR) {
      if (state.netRetries < MAX_NET_RETRIES) {
        state.netRetries++;
        const wait = 1000 * state.netRetries;
        setOverlay("loading", `Connection problem – reconnecting (${state.netRetries}/${MAX_NET_RETRIES})…`);
        state.retryTimer = setTimeout(() => {
          if (state.hls && state.current && state.current.id === ch.id) state.hls.startLoad();
        }, wait);
        return;
      }
      if (!state.usingProxy && !state.proxyFallbackTried) {
        state.proxyFallbackTried = true;
        state.netRetries = 0;
        toast("Direct playback failed – retrying through the server proxy…");
        startStream(ch, true);
        return;
      }
      return failStream(`The stream is unreachable (${details || "network error"}).`);
    }

    if (data.type === H.ErrorTypes.MEDIA_ERROR && state.mediaRecoveries < MAX_MEDIA_RECOVERIES) {
      state.mediaRecoveries++;
      setOverlay("loading", "Recovering playback…");
      state.hls.recoverMediaError();
      return;
    }
    failStream(`This stream can't be played (${details || "unsupported format"}).`);
  }

  function failStream(message) {
    destroyPlayer();
    setOverlay("error", message, true);
  }

  // Video element events
  el.video.addEventListener("playing", () => { state.netRetries = 0; setOverlay("hidden"); });
  el.video.addEventListener("waiting", () => { if (state.current && !el.video.paused) setOverlay("buffering"); });
  el.video.addEventListener("canplay", () => { if (!el.video.paused) setOverlay("hidden"); });
  el.video.addEventListener("play", () => { setIcon(el.play, "i-pause"); el.wrap.classList.remove("paused"); });
  el.video.addEventListener("pause", () => { setIcon(el.play, "i-play"); el.wrap.classList.add("paused"); });
  el.video.addEventListener("error", () => {
    if (!state.hls && state.current && el.video.getAttribute("src")) {
      failStream("The browser couldn't play this stream. It may use a format browsers don't support (e.g. raw .ts or RTMP).");
    }
  });
  el.video.addEventListener("volumechange", syncVolumeUi);
  el.video.addEventListener("click", togglePlay);
  el.video.addEventListener("dblclick", toggleFullscreen);

  function togglePlay() {
    if (!state.current) return;
    if (!el.video.currentSrc && !state.hls) return playChannel(state.current);
    if (el.video.paused) tryPlay(); else el.video.pause();
  }

  function syncVolumeUi() {
    el.volume.value = el.video.muted ? 0 : el.video.volume;
    setIcon(el.mute, el.video.muted || el.video.volume === 0 ? "i-mute" : "i-volume");
    store.set(LS.volume, String(el.video.volume));
    store.set(LS.muted, el.video.muted ? "1" : "0");
  }

  function toggleFullscreen() {
    const doc = document;
    const active = doc.fullscreenElement || doc.webkitFullscreenElement;
    if (active) { (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc); return; }
    const w = el.wrap;
    const req = w.requestFullscreen || w.webkitRequestFullscreen;
    if (req) req.call(w);
    else if (el.video.webkitEnterFullscreen) el.video.webkitEnterFullscreen(); // iOS
  }

  // Auto-hide controls while playing
  let hideTimer;
  el.wrap.addEventListener("mousemove", () => {
    el.wrap.classList.add("show-controls");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => el.wrap.classList.remove("show-controls"), 2500);
  });

  // ---------------------------------------------------------------- wiring
  el.list.addEventListener("click", (e) => {
    const star = e.target.closest(".star");
    if (star) {
      toggleFavorite(star.dataset.id);
      return;
    }
    const btn = e.target.closest(".channel");
    if (!btn) return;
    const ch = state.byId.get(btn.dataset.id);
    if (ch) playChannel(ch);
  });
  el.tabs.addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    state.tab = tab.dataset.tab === "fav" ? "fav" : "all";
    renderChannels();
    markActive();
  });
  el.npStar.addEventListener("click", () => {
    if (state.current) toggleFavorite(state.current.id);
  });
  el.search.addEventListener("input", debounce(() => { state.query = el.search.value; renderChannels(); markActive(); }, 150));
  el.category.addEventListener("change", () => { state.category = el.category.value; renderChannels(); });
  el.refresh.addEventListener("click", () => loadChannels({ force: true }));
  el.play.addEventListener("click", togglePlay);
  el.prev.addEventListener("click", () => stepChannel(-1));
  el.next.addEventListener("click", () => stepChannel(1));
  el.mute.addEventListener("click", () => { el.video.muted = !el.video.muted; });
  el.volume.addEventListener("input", () => { el.video.muted = false; el.video.volume = Number(el.volume.value); });
  el.reload.addEventListener("click", () => { if (state.current) playChannel(state.current); });
  el.fs.addEventListener("click", toggleFullscreen);
  el.overlayBtn.addEventListener("click", () => { if (state.current) playChannel(state.current); });
  el.overlay.addEventListener("click", (e) => {
    if (e.target === el.overlayBtn) return;
    if (el.overlay.dataset.mode === "idle" && state.current) togglePlay();
  });
  el.proxy.addEventListener("change", () => {
    store.set(LS.proxy, el.proxy.checked ? "1" : "0");
    if (state.current && !el.video.paused) playChannel(state.current);
  });

  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if ((tag === "input" && e.target.type !== "range") || tag === "button") return;
    if (tag === "select" || e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case " ": e.preventDefault(); togglePlay(); break;
      case "f": case "F": toggleFullscreen(); break;
      case "m": case "M": el.video.muted = !el.video.muted; break;
      case "ArrowUp": e.preventDefault(); stepChannel(-1); break;
      case "ArrowDown": e.preventDefault(); stepChannel(1); break;
      default: break;
    }
  });

  // Server health
  async function checkHealth() {
    try {
      await fetchJson("/api/health", 6000);
      if (el.status.dataset.state === "error" || el.status.dataset.state === "checking") {
        setServerStatus(state.channels.length ? "ok" : "warn", state.channels.length ? `${state.channels.length} channels` : "Server online");
      }
    } catch {
      setServerStatus("error", "Server offline");
    }
  }

  // ------------------------------------------------------------------- init
  function init() {
    const vol = parseFloat(store.get(LS.volume, "1"));
    el.video.volume = Number.isFinite(vol) ? Math.min(Math.max(vol, 0), 1) : 1;
    el.video.muted = store.get(LS.muted, "0") === "1";
    el.proxy.checked = store.get(LS.proxy, "0") === "1";
    el.wrap.classList.add("paused");
    syncVolumeUi();
    loadChannels();
    setInterval(() => loadChannels({ silent: true }), REFRESH_MS);
    setInterval(checkHealth, HEALTH_MS);
  }
  init();
})();
