/* ==========================================================================
   背景动态：粒子 / 数据流 / 扫描光束
   —— 纯 Canvas 2D，低开销，跟随明暗主题切换配色，遵循 prefers-reduced-motion
   ========================================================================== */
(() => {
  const canvas = document.getElementById("bgFx");
  if (!canvas) return;

  const ctx = canvas.getContext("2d", { alpha: true });
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const PALETTES = {
    dark: [
      [62, 224, 176],
      [255, 217, 61],
      [132, 190, 255],
    ],
    light: [
      [12, 96, 78],
      [172, 116, 0],
      [44, 70, 88],
    ],
  };

  let palette = PALETTES.dark;
  let alphaMin = 0.16;
  let alphaMax = 0.55;

  let W = 0;
  let H = 0;
  let particles = [];
  let streaks = [];
  let rafId = 0;

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function readPalette() {
    const light = document.documentElement.dataset.theme === "light";
    palette = light ? PALETTES.light : PALETTES.dark;
    alphaMin = light ? 0.34 : 0.16;
    alphaMax = light ? 0.78 : 0.55;
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
    if (reduceMotion) drawStatic();
  }

  function seed() {
    const count = Math.round(Math.min(96, Math.max(28, (W * H) / 26000)));
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      vx: rand(-0.09, 0.09),
      vy: rand(-0.26, -0.06),
      size: Math.random() < 0.14 ? 2.6 : 1.4,
      alpha: rand(alphaMin, alphaMax),
      c: palette[(Math.random() * palette.length) | 0],
      pulse: Math.random() * Math.PI * 2,
    }));

    streaks = Array.from({ length: 5 }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      len: rand(40, 110),
      speed: rand(0.5, 1.4),
      alpha: rand(0.06, 0.18),
    }));
  }

  function drawParticles() {
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.pulse += 0.01;

      if (p.y < -10) {
        p.y = H + 10;
        p.x = Math.random() * W;
      }
      if (p.x < -10) p.x = W + 10;
      if (p.x > W + 10) p.x = -10;

      const a = p.alpha * (0.65 + 0.35 * Math.sin(p.pulse));
      ctx.fillStyle = `rgba(${p.c[0]},${p.c[1]},${p.c[2]},${a.toFixed(3)})`;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
  }

  function drawLinks() {
    const maxDist = 120;
    ctx.lineWidth = 0.6;
    for (let i = 0; i < particles.length; i++) {
      const a = particles[i];
      for (let j = i + 1; j < particles.length; j++) {
        const b = particles[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > maxDist * maxDist) continue;
        const alpha = (1 - Math.sqrt(d2) / maxDist) * 0.09;
        ctx.strokeStyle = `rgba(${a.c[0]},${a.c[1]},${a.c[2]},${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  }

  function drawStreaks() {
    const c = palette[0];
    for (const s of streaks) {
      s.y -= s.speed;
      if (s.y + s.len < 0) {
        s.y = H + s.len;
        s.x = Math.random() * W;
        s.len = rand(40, 110);
      }
      const grad = ctx.createLinearGradient(s.x, s.y, s.x, s.y + s.len);
      grad.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},0)`);
      grad.addColorStop(0.5, `rgba(${c[0]},${c[1]},${c[2]},${s.alpha})`);
      grad.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x, s.y + s.len);
      ctx.stroke();
    }
  }

  function drawBeam(t) {
    const period = 9000;
    const phase = (t % period) / period;
    const y = phase * (H + 160) - 80;
    const c = palette[0];
    const grad = ctx.createLinearGradient(0, y - 90, 0, y + 90);
    grad.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},0)`);
    grad.addColorStop(0.5, `rgba(${c[0]},${c[1]},${c[2]},0.06)`);
    grad.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, y - 90, W, 180);
  }

  function frame(t) {
    ctx.clearRect(0, 0, W, H);
    drawBeam(t);
    drawLinks();
    drawStreaks();
    drawParticles();
    rafId = requestAnimationFrame(frame);
  }

  function drawStatic() {
    ctx.clearRect(0, 0, W, H);
    drawLinks();
    drawParticles();
  }

  function start() {
    if (reduceMotion || rafId) return;
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 160);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });

  // 跟随主题切换配色
  new MutationObserver(() => {
    readPalette();
    for (const p of particles) {
      p.c = palette[(Math.random() * palette.length) | 0];
      p.alpha = rand(alphaMin, alphaMax);
    }
    if (reduceMotion) drawStatic();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  readPalette();
  resize();
  start();
})();
