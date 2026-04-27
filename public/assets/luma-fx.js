// luma-fx.js — shared interaction layer
// Mounted by every page. Hooks: scroll fade-in, number count-up,
// projection bar fill, live indicator ticker, map tooltip,
// cursor follower, 3D card tilt, map pan/zoom + drill panel,
// Bayesian prior slider, audit-log row slide-in.

(function () {
  // -----------------------------------------------------------
  // Page-load fade
  // -----------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    document.body.classList.add("fx-page-loaded");
    initFadeIn();
    initLiveIndicator();
    initButtonPress();
    initMobileNav();
  });

  // -----------------------------------------------------------
  // Mobile nav — auto-injects a hamburger button on every page
  // so we don't have to edit each .html file. Activated by
  // CSS media query (max-width: 800px) — see luma-fx.css.
  // -----------------------------------------------------------
  function initMobileNav() {
    const nav = document.querySelector(".nav");
    if (!nav) return;
    const home = nav.querySelector(".home-link");
    if (!home) return;
    if (nav.querySelector(".nav-mobile-btn")) return; // idempotent

    const btn = document.createElement("button");
    btn.className = "nav-mobile-btn";
    btn.setAttribute("aria-label", "Toggle navigation");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = '<span></span><span></span><span></span>';
    home.insertAdjacentElement("afterend", btn);

    btn.addEventListener("click", () => {
      const isOpen = nav.classList.toggle("is-open");
      btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });

    // Close menu when a nav link is tapped (so it doesn't stay open after navigating)
    nav.addEventListener("click", (e) => {
      if (e.target.tagName === "A" && e.target !== home) {
        nav.classList.remove("is-open");
        btn.setAttribute("aria-expanded", "false");
      }
    });
  }

  // -----------------------------------------------------------
  // Section fade-in on scroll
  // -----------------------------------------------------------
  function initFadeIn() {
    const candidates = document.querySelectorAll("section, .section, .endpoint, .anchor-row");
    candidates.forEach((el, i) => {
      el.classList.add("fx-fade-in");
      el.style.transitionDelay = Math.min(i * 30, 240) + "ms";
    });
    if (!("IntersectionObserver" in window)) {
      candidates.forEach((el) => el.classList.add("fx-visible"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("fx-visible");
            observer.unobserve(e.target);
          }
        }
      },
      { rootMargin: "-40px 0px", threshold: 0.05 },
    );
    candidates.forEach((el) => observer.observe(el));
  }

  // -----------------------------------------------------------
  // Number count-up animation
  // -----------------------------------------------------------
  function animateCountUp(el) {
    const target = parseFloat(el.dataset.countTarget);
    if (isNaN(target)) return;
    const decimals = parseInt(el.dataset.countDecimals || "0", 10);
    const prefix = el.dataset.countPrefix || "";
    const suffix = el.dataset.countSuffix || "";
    const duration = parseInt(el.dataset.countDuration || "1100", 10);
    const start = performance.now();

    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      const value = target * eased;
      el.textContent = prefix + value.toFixed(decimals) + suffix;
      if (t < 1) requestAnimationFrame(step);
      else el.textContent = prefix + target.toFixed(decimals) + suffix;
    }
    requestAnimationFrame(step);
  }

  function animateAllCounters(root) {
    const els = (root || document).querySelectorAll("[data-count-target]:not([data-counted])");
    els.forEach((el) => {
      el.dataset.counted = "1";
      animateCountUp(el);
    });
  }

  // -----------------------------------------------------------
  // Projection bar fill
  // -----------------------------------------------------------
  function animateBars(root) {
    const bars = (root || document).querySelectorAll(".bar-fill, .bar-ci");
    bars.forEach((b) => {
      const w = b.style.width;
      if (!w) return;
      b.style.setProperty("--target-width", w);
      b.classList.remove("bar-fill-animated");
      void b.offsetWidth;
      b.classList.add("bar-fill-animated");
    });
  }

  // -----------------------------------------------------------
  // Live indicator
  // -----------------------------------------------------------
  let lastSyncTs = Date.now();
  const liveEls = [];

  function initLiveIndicator() {
    document.querySelectorAll(".luma-live").forEach((el) => {
      if (!el.querySelector(".dot")) {
        const dot = document.createElement("span");
        dot.className = "dot";
        el.prepend(dot);
      }
      if (!el.querySelector(".age")) {
        const age = document.createElement("span");
        age.className = "age";
        age.textContent = "synced 0s ago";
        el.appendChild(age);
      }
      liveEls.push(el);
    });
    setInterval(updateLiveIndicators, 1000);
    updateLiveIndicators();
  }

  function updateLiveIndicators() {
    const ageSec = Math.floor((Date.now() - lastSyncTs) / 1000);
    let label;
    if (ageSec < 60) label = `synced ${ageSec}s ago`;
    else if (ageSec < 3600) label = `synced ${Math.floor(ageSec / 60)}m ago`;
    else label = `synced ${Math.floor(ageSec / 3600)}h ago`;
    liveEls.forEach((el) => {
      const ageEl = el.querySelector(".age");
      if (ageEl) ageEl.textContent = label;
    });
  }

  function markSync() {
    lastSyncTs = Date.now();
    updateLiveIndicators();
  }

  // -----------------------------------------------------------
  // Button press feedback (universal)
  // -----------------------------------------------------------
  function initButtonPress() {
    document.addEventListener("pointerdown", (e) => {
      const t = e.target.closest && e.target.closest("button, .btn, .tss-submit, a.home-link, .nav a");
      if (!t) return;
      t.style.transition = "transform 0.05s linear";
      t.style.transform = "translateY(1px) scale(0.985)";
      const release = () => {
        t.style.transition = "";
        t.style.transform = "";
        document.removeEventListener("pointerup", release);
        document.removeEventListener("pointercancel", release);
      };
      document.addEventListener("pointerup", release);
      document.addEventListener("pointercancel", release);
    }, { passive: true });
  }

  // -----------------------------------------------------------
  // Map tooltip
  // -----------------------------------------------------------
  let tooltipEl = null;
  function ensureTooltip() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement("div");
    tooltipEl.className = "luma-tooltip";
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }
  function escapeAttr(s) {
    return (s || "").toString().replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function attachMapTooltips(root) {
    const r = root || document;
    r.querySelectorAll(".map-hex, .map-district").forEach((g) => {
      if (g.dataset.tooltipBound) return;
      g.dataset.tooltipBound = "1";

      g.addEventListener("mouseenter", (e) => {
        const t = ensureTooltip();
        const district = g.dataset.district || "";
        const count = g.dataset.count || "0";
        const share = g.dataset.share || "—";
        const topSeverity = g.dataset.topSeverity || "";
        const topTopic = g.dataset.topTopic || "";
        const topCondition = g.dataset.topCondition || "";
        const emergencies = g.dataset.emergencies || "0";
        const isZero = count === "0";

        const html = isZero
          ? `<div class="t-name">${escapeAttr(district)}</div>
             <div class="t-row" style="font-style: italic; color: rgba(255,255,255,0.5);">No CHW activity recorded in the last 30 days.</div>`
          : `<div class="t-name">${escapeAttr(district)}</div>
             <div class="t-row"><span class="t-k">INTERACTIONS · 30D</span><span><strong>${escapeAttr(count)}</strong></span></div>
             <div class="t-row"><span class="t-k">SHARE OF NETWORK</span><span>${escapeAttr(share)}</span></div>
             ${topTopic ? `<div class="t-row"><span class="t-k">TOP TOPIC</span><span>${escapeAttr(topTopic)}</span></div>` : ""}
             ${topCondition ? `<div class="t-row"><span class="t-k">TOP CONDITION</span><span style="text-align: right; max-width: 130px;">${escapeAttr(topCondition)}</span></div>` : ""}
             ${topSeverity ? `<div class="t-row"><span class="t-k">TOP SEVERITY</span><span>${escapeAttr(topSeverity)}</span></div>` : ""}
             ${emergencies !== "0" ? `<div class="t-row"><span class="t-k">EMERGENCIES</span><span style="color:#E0A86A;"><strong>${escapeAttr(emergencies)}</strong></span></div>` : ""}
             <div class="t-row" style="margin-top:6px; font-style:italic; color: rgba(255,255,255,0.45);">Click for details</div>`;

        t.innerHTML = html;
        t.classList.add("visible");
        positionTooltip(t, e);
      });
      g.addEventListener("mousemove", (e) => {
        if (tooltipEl) positionTooltip(tooltipEl, e);
      });
      g.addEventListener("mouseleave", () => {
        if (tooltipEl) tooltipEl.classList.remove("visible");
      });
    });
  }

  function positionTooltip(t, e) {
    const x = e.clientX + 14;
    const y = e.clientY + 14;
    t.style.left = x + "px";
    t.style.top = y + "px";
  }

  // -----------------------------------------------------------
  // Generic data-tip tooltip handler. Any element with [data-tip]
  // gets a hover tooltip showing that text. Multi-line via <br>.
  // Optional [data-tip-title] for a bold header line.
  // Call attachDataTips(root) after rendering new content.
  // -----------------------------------------------------------
  function attachDataTips(root) {
    const r = root || document;
    r.querySelectorAll("[data-tip]").forEach((el) => {
      if (el.dataset.tipBound) return;
      el.dataset.tipBound = "1";
      el.addEventListener("mouseenter", (e) => {
        const t = ensureTooltip();
        const title = el.getAttribute("data-tip-title");
        const body = el.getAttribute("data-tip");
        let html = "";
        if (title) html += `<div class="t-name">${escapeAttr(title)}</div>`;
        // Body supports newline-style: lines split on `||`, key:value split on `::`
        const lines = body.split("||");
        for (const ln of lines) {
          const kv = ln.split("::");
          if (kv.length === 2) {
            html += `<div class="t-row"><span class="t-k">${escapeAttr(kv[0].trim())}</span><span><strong>${escapeAttr(kv[1].trim())}</strong></span></div>`;
          } else {
            html += `<div class="t-row"><span>${escapeAttr(ln.trim())}</span></div>`;
          }
        }
        t.innerHTML = html;
        positionTooltip(t, e);
        t.classList.add("visible");
      });
      el.addEventListener("mousemove", (e) => {
        if (tooltipEl && tooltipEl.classList.contains("visible")) {
          positionTooltip(tooltipEl, e);
        }
      });
      el.addEventListener("mouseleave", () => {
        if (tooltipEl) tooltipEl.classList.remove("visible");
      });
    });
  }

  // -----------------------------------------------------------
  // Map pan / zoom + drill panel + live activity pulses
  // Call: window.lumaFx.makeMapInteractive(mapWrapEl, opts?)
  // opts: { zoom: true, drag: true, drill: true, pulses: true, controls: true, hint: true }
  // The element is the .map-wrap div (with the SVG inside).
  // -----------------------------------------------------------
  function makeMapInteractive(wrap, opts) {
    if (!wrap || wrap.dataset.fxMap) return;
    wrap.dataset.fxMap = "1";
    const o = Object.assign(
      { zoom: true, drag: true, drill: true, pulses: true, controls: true, hint: true },
      opts || {},
    );

    const svg = wrap.querySelector("svg");
    if (!svg) return;

    // Wrap the SVG in a "stage" we can transform
    const stage = document.createElement("div");
    stage.className = "map-stage";
    if (!o.drag && !o.zoom) stage.classList.add("map-stage-static");
    svg.parentNode.insertBefore(stage, svg);
    stage.appendChild(svg);

    // Pulse layer (overlays the SVG)
    let pulses = null;
    if (o.pulses) {
      pulses = document.createElement("div");
      pulses.className = "map-pulse-layer";
      stage.appendChild(pulses);
    }

    // Controls
    let controls = null;
    if (o.controls && (o.zoom || o.drag)) {
      controls = document.createElement("div");
      controls.className = "map-controls";
      controls.innerHTML = `
        <button data-act="zoom-in" aria-label="Zoom in">+</button>
        <button data-act="zoom-out" aria-label="Zoom out">−</button>
        <button data-act="reset" aria-label="Reset view">⟲</button>
      `;
      stage.appendChild(controls);
    }

    let hint = null;
    if (o.hint && (o.zoom || o.drag)) {
      hint = document.createElement("div");
      hint.className = "map-hint";
      hint.textContent = o.zoom
        ? "DRAG · SCROLL TO ZOOM · CLICK A DISTRICT"
        : "CLICK A DISTRICT";
      stage.appendChild(hint);
    }

    // Drill panel
    let drill = null;
    if (o.drill) {
      drill = document.createElement("div");
      drill.className = "drill-panel";
      drill.innerHTML = `
        <button class="dp-close" aria-label="Close">✕</button>
        <h4 class="dp-name">—</h4>
        <div class="dp-body"></div>
      `;
      stage.appendChild(drill);
      drill.querySelector(".dp-close").addEventListener("click", () => closeDrillPanel());
    }

    // State
    let scale = 1, tx = 0, ty = 0;
    const minScale = 0.7, maxScale = 4.5;
    let isDragging = false, dragStartX = 0, dragStartY = 0, startTx = 0, startTy = 0;
    let pointerMoved = false;

    function applyTransform() {
      svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      svg.style.transformOrigin = "center center";
    }

    function clampPan() {
      // Allow generous slack so user can pan beyond bounds, but pull back
      const r = stage.getBoundingClientRect();
      const lim = (Math.max(0, scale - 1)) * r.width * 0.6 + 80;
      if (tx > lim) tx = lim;
      if (tx < -lim) tx = -lim;
      if (ty > lim) ty = lim;
      if (ty < -lim) ty = -lim;
    }

    if (o.drag) {
      stage.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".map-controls") || e.target.closest(".drill-panel")) return;
        isDragging = true;
        pointerMoved = false;
        stage.classList.add("is-dragging");
        dragStartX = e.clientX; dragStartY = e.clientY;
        startTx = tx; startTy = ty;
        stage.setPointerCapture(e.pointerId);
      });
      stage.addEventListener("pointermove", (e) => {
        if (!isDragging) return;
        const dx = e.clientX - dragStartX, dy = e.clientY - dragStartY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) pointerMoved = true;
        tx = startTx + dx;
        ty = startTy + dy;
        clampPan();
        applyTransform();
      });
      function endDrag(e) {
        if (!isDragging) return;
        isDragging = false;
        stage.classList.remove("is-dragging");
        try { stage.releasePointerCapture(e.pointerId); } catch (_) {}
      }
      stage.addEventListener("pointerup", endDrag);
      stage.addEventListener("pointercancel", endDrag);
    } else {
      stage.style.cursor = "default";
    }

    if (o.zoom) {
      stage.addEventListener("wheel", (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        const newScale = Math.min(maxScale, Math.max(minScale, scale * factor));
        // Zoom toward the cursor
        const r = stage.getBoundingClientRect();
        const cx = e.clientX - r.left - r.width / 2;
        const cy = e.clientY - r.top - r.height / 2;
        tx = cx - ((cx - tx) * (newScale / scale));
        ty = cy - ((cy - ty) * (newScale / scale));
        scale = newScale;
        clampPan();
        applyTransform();
      }, { passive: false });
    }

    if (controls) {
      controls.addEventListener("click", (e) => {
        const b = e.target.closest("button"); if (!b) return;
        const act = b.dataset.act;
        if (act === "zoom-in" && o.zoom)  scale = Math.min(maxScale, scale * 1.4);
        if (act === "zoom-out" && o.zoom) scale = Math.max(minScale, scale / 1.4);
        if (act === "reset")    { scale = 1; tx = 0; ty = 0; }
        clampPan();
        applyTransform();
      });
    }

    // Click district → open drill panel (only if user wasn't dragging)
    if (o.drill) {
      svg.addEventListener("click", (e) => {
        if (pointerMoved) return;
        const d = e.target.closest(".map-district, .map-hex");
        if (!d) return;
        svg.querySelectorAll(".is-selected").forEach((x) => x.classList.remove("is-selected"));
        d.classList.add("is-selected");
        openDrillPanel(d);
      });
    }

    function openDrillPanel(node) {
      const name = node.dataset.district || "—";
      const count = node.dataset.count || "0";
      const share = node.dataset.share || "—";
      const topSeverity = node.dataset.topSeverity || "—";
      const topTopic = node.dataset.topTopic || "—";
      const topCondition = node.dataset.topCondition || "—";
      const emergencies = node.dataset.emergencies || "0";

      drill.querySelector(".dp-name").textContent = name.toUpperCase();
      const body = drill.querySelector(".dp-body");
      body.innerHTML = `
        <div class="dp-row"><span class="k">Interactions · 30d</span><span class="v">${escapeAttr(count)}</span></div>
        <div class="dp-row"><span class="k">Share of network</span><span class="v">${escapeAttr(share)}</span></div>
        <div class="dp-row"><span class="k">Top topic</span><span class="v">${escapeAttr(topTopic)}</span></div>
        <div class="dp-row"><span class="k">Top condition</span><span class="v" style="text-align:right;max-width:140px">${escapeAttr(topCondition)}</span></div>
        <div class="dp-row"><span class="k">Top severity</span><span class="v">${escapeAttr(topSeverity)}</span></div>
        <div class="dp-row dp-emergency"><span class="k">Emergencies</span><span class="v">${escapeAttr(emergencies)}</span></div>
      `;
      drill.classList.add("fx-open");
      hint.style.opacity = "0.45";
    }

    function closeDrillPanel() {
      drill.classList.remove("fx-open");
      svg.querySelectorAll(".is-selected").forEach((x) => x.classList.remove("is-selected"));
      hint.style.opacity = "";
    }

    // Live activity pulses — spawn periodically on districts with activity
    function spawnPulse() {
      const districts = svg.querySelectorAll(".map-district[data-count], .map-hex[data-count]");
      const live = Array.from(districts).filter((d) => parseInt(d.dataset.count, 10) > 0);
      if (live.length === 0) return;
      const node = live[Math.floor(Math.random() * live.length)];
      const bbox = node.getBoundingClientRect();
      const sbox = stage.getBoundingClientRect();
      // Random offset within the district, in stage coordinates
      const x = bbox.left - sbox.left + bbox.width * (0.3 + Math.random() * 0.4);
      const y = bbox.top - sbox.top + bbox.height * (0.3 + Math.random() * 0.4);

      const p = document.createElement("div");
      p.className = "map-pulse";
      p.style.left = x + "px";
      p.style.top = y + "px";
      pulses.appendChild(p);
      setTimeout(() => p.remove(), 1900);
    }
    // Stagger pulses; weighted toward more activity = more pulses
    const pulseTick = () => {
      if (!document.hidden) spawnPulse();
      const next = 1500 + Math.random() * 2400;
      setTimeout(pulseTick, next);
    };
    setTimeout(pulseTick, 800);

    // Expose so external callers can close
    wrap._fxMap = { open: openDrillPanel, close: closeDrillPanel, reset: () => { scale = 1; tx = 0; ty = 0; applyTransform(); } };
  }

  // -----------------------------------------------------------
  // Bayesian prior strength slider
  // -----------------------------------------------------------
  // Adds an interactive slider to each .proj-card. Slider controls
  // the Beta-Binomial "prior strength" K. Posterior recomputes live.
  // We back out the server's K from data_weight_pct + observed.trials:
  //   data_weight = trials / (trials + K)  →  K = trials * (1 - dw) / dw
  // Slider goes from K * 0.1 (trust data) to K * 6 (trust prior).
  function attachBayesSliders(root, projectionsByLabel) {
    if (!projectionsByLabel) return;
    const r = root || document;
    const cards = r.querySelectorAll(".proj-card:not([data-bs-bound])");
    cards.forEach((card) => {
      const labelEl = card.querySelector(".label");
      if (!labelEl) return;
      const label = labelEl.textContent.trim();
      const p = projectionsByLabel[label];
      if (!p || !p.observed || !p.prior) return;
      const trials = p.observed.trials || 0;
      // No observed data → slider has nothing to do. Skip silently.
      if (trials === 0) return;
      card.dataset.bsBound = "1";

      // Back out original K
      const dw = (p.data_weight_pct || 0) / 100;
      let K0;
      if (trials > 0 && dw > 0 && dw < 1) {
        K0 = (trials * (1 - dw)) / dw;
      } else if (p.posterior && p.posterior.effective_sample_size && trials > 0) {
        K0 = Math.max(1, p.posterior.effective_sample_size - trials);
      } else {
        K0 = 50; // fallback
      }
      const Kmin = Math.max(1, K0 * 0.1);
      const Kmax = Math.max(Kmin * 4, K0 * 6);

      const slider = document.createElement("div");
      slider.className = "bayes-slider";
      slider.innerHTML = `
        <div class="bs-row">
          <span>Prior strength</span>
          <span class="bs-val">K = ${K0.toFixed(0)} <span style="opacity:0.55">(default)</span></span>
        </div>
        <input type="range" min="${Kmin}" max="${Kmax}" step="${(Kmax - Kmin) / 200}" value="${K0}" />
        <div class="bs-extents"><span>↑ trust data</span><span>trust prior ↑</span></div>
      `;
      card.appendChild(slider);

      const input = slider.querySelector("input");
      const valEl = slider.querySelector(".bs-val");

      const recompute = (K, isDefault) => {
        const successes = p.observed.successes || 0;
        const aPrior = p.prior.mean * K;
        const bPrior = (1 - p.prior.mean) * K;
        const aPost = aPrior + successes;
        const bPost = bPrior + (trials - successes);
        const postMean = aPost / (aPost + bPost);
        // Normal approx for 95% CI on the mean
        const variance = (aPost * bPost) / (Math.pow(aPost + bPost, 2) * (aPost + bPost + 1));
        const sd = Math.sqrt(variance);
        const lower = Math.max(0, postMean - 1.96 * sd);
        const upper = Math.min(1, postMean + 1.96 * sd);
        const dataWeight = trials / (trials + K);

        // Update value label
        valEl.innerHTML = `K = ${K.toFixed(0)} ${isDefault ? '<span style="opacity:0.55">(default)</span>' : ''} · data weight ${(dataWeight * 100).toFixed(1)}%`;

        // Update posterior bar + label
        const priorPct = p.prior.mean * 100;
        const observedPct = p.observed.share * 100;
        const postPct = postMean * 100;
        const lowerPct = lower * 100;
        const upperPct = upper * 100;
        const axisMax = Math.max(priorPct, observedPct, upperPct, 1) * 1.25;
        const w = (pct) => Math.min(100, (pct / axisMax) * 100) + "%";
        const left = (pct) => (pct / axisMax) * 100 + "%";
        const wid = (a, b) => (((b - a) / axisMax) * 100) + "%";

        const rows = card.querySelectorAll(".bars > .bar-track");
        // rows: [0] prior track, [1] observed track, [2] posterior track
        if (rows.length >= 3) {
          const priorFill = rows[0].querySelector(".bar-fill");
          const observedFill = rows[1].querySelector(".bar-fill");
          const postFill = rows[2].querySelector(".bar-fill");
          const ci = rows[2].querySelector(".bar-ci");
          if (priorFill) priorFill.style.width = w(priorPct);
          if (observedFill) observedFill.style.width = w(observedPct);
          if (postFill) postFill.style.width = w(postPct);
          if (ci) {
            ci.style.left = left(lowerPct);
            ci.style.width = wid(lowerPct, upperPct);
          }
        }
        // Update posterior numeric label
        const valueCells = card.querySelectorAll(".bars > .row-value");
        if (valueCells.length >= 3) {
          valueCells[2].innerHTML =
            `<strong>${(postMean * 100).toFixed(1)}%</strong> [${(lower * 100).toFixed(1)}%–${(upper * 100).toFixed(1)}%]`;
        }
      };

      input.addEventListener("input", () => {
        const K = parseFloat(input.value);
        recompute(K, false);
        card.classList.add("is-bs-active");
      });
      input.addEventListener("change", () => {
        // Fade out the active highlight after a beat
        setTimeout(() => card.classList.remove("is-bs-active"), 400);
      });

      // Initial sync — show defaults computed locally too (matches server)
      recompute(K0, true);
    });
  }

  // -----------------------------------------------------------
  // Audit-log row slide-in (called by log.html after rows render)
  // -----------------------------------------------------------
  function animateRows(root, selector) {
    const r = root || document;
    const sel = selector || ".convo";
    const rows = r.querySelectorAll(sel + ":not([data-row-anim])");
    rows.forEach((row, i) => {
      row.dataset.rowAnim = "1";
      row.style.animationDelay = Math.min(i * 24, 480) + "ms";
      row.classList.add("fx-row-in");
    });
  }

  // -----------------------------------------------------------
  // Landing page parallax (hero / phone / sections)
  // -----------------------------------------------------------
  function initParallax() {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const targets = document.querySelectorAll(".fx-parallax");
    if (targets.length === 0) return;
    let ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const sy = window.scrollY;
        targets.forEach((t) => {
          const speed = parseFloat(t.dataset.parallaxSpeed || "0.18");
          t.style.transform = `translate3d(0, ${(-sy * speed).toFixed(2)}px, 0)`;
        });
        ticking = false;
      });
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // -----------------------------------------------------------
  // Public API
  // -----------------------------------------------------------
  window.lumaFx = {
    /** Run after dynamic content is rendered to (re-)trigger animations. */
    animate(root) {
      animateAllCounters(root);
      animateBars(root);
      attachMapTooltips(root);
      attachDataTips(root);
    },
    markSync,
    animateCountUp,
    animateRows,
    makeMapInteractive,
    attachBayesSliders,
    initParallax,
    attachDataTips,
  };
})();
