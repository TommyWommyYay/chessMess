// Visual effects: the animated backdrop, and the particle bursts (explosions, fireworks) drawn over the page.
(function (root) {
  'use strict';

  const rand = (min, max) => min + Math.random() * (max - min);

  // These are soft, fast-moving effects, so the canvases stay at one pixel per CSS pixel even on
  // high-density screens: a quarter of the pixels to fill each frame, with no visible difference.
  function fit(canvas) {
    const dpr = 1;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  // ---------------------------------------------------------------------------
  // Backdrop: twinkling stars drifting upwards, plus large chess pieces floating by.
  // ---------------------------------------------------------------------------

  const bgCanvas = document.getElementById('bg');
  let bgCtx = fit(bgCanvas);

  const stars = Array.from({ length: 90 }, () => ({
    x: Math.random(), y: Math.random(),
    radius: rand(0.4, 1.9), speed: rand(0.04, 0.3),
    phase: rand(0, Math.PI * 2), twinkle: rand(0.6, 2.2),
    hue: [190, 265, 320][Math.floor(Math.random() * 3)],
  }));

  // The stars move slowly, so they are redrawn at about 30 frames per second rather than every frame.
  let lastBackdrop = 0;
  function drawBackdrop(time) {
    requestAnimationFrame(drawBackdrop);
    const elapsed = time - lastBackdrop;
    if (elapsed < 30) return;
    lastBackdrop = time;
    const step = Math.min(elapsed / 16.67, 6);
    bgCtx.clearRect(0, 0, innerWidth, innerHeight);
    for (const s of stars) {
      s.y -= s.speed * step / innerHeight;
      if (s.y < -0.01) { s.y = 1.01; s.x = Math.random(); }
      const alpha = 0.2 + 0.7 * (0.5 + 0.5 * Math.sin(time / 1000 * s.twinkle + s.phase));
      bgCtx.fillStyle = `hsla(${s.hue}, 95%, 82%, ${alpha})`;
      bgCtx.beginPath();
      bgCtx.arc(s.x * innerWidth, s.y * innerHeight, s.radius, 0, Math.PI * 2);
      bgCtx.fill();
    }
  }
  requestAnimationFrame(drawBackdrop);

  const floaters = document.getElementById('floaters');
  const glyphs = ['♟', '♞', '♝', '♜', '♛', '♚'];
  for (let i = 0; i < 10; i++) {
    const el = document.createElement('span');
    el.className = 'floater';
    el.textContent = glyphs[i % glyphs.length] + '︎';
    const duration = rand(26, 58);
    el.style.setProperty('--x', rand(0, 96) + 'vw');
    el.style.setProperty('--size', rand(36, 130) + 'px');
    el.style.setProperty('--duration', duration + 's');
    // A negative delay starts each piece part-way up, so the screen is not empty at first.
    el.style.setProperty('--delay', -rand(0, duration) + 's');
    el.style.setProperty('--spin', rand(-220, 220) + 'deg');
    floaters.append(el);
  }

  // ---------------------------------------------------------------------------
  // Particle effects, drawn on a canvas that covers the whole window.
  // ---------------------------------------------------------------------------

  const fxCanvas = document.getElementById('fx');
  let fxCtx = fit(fxCanvas);
  let particles = [];
  let running = false;
  let lastTime = 0;
  let timers = [];

  addEventListener('resize', () => {
    bgCtx = fit(bgCanvas);
    fxCtx = fit(fxCanvas);
  });

  function start() {
    if (running) return;
    running = true;
    lastTime = performance.now();
    requestAnimationFrame(frame);
  }

  function frame(now) {
    // `step` is 1 at 60 frames per second, so speeds below are in pixels per 60 Hz frame.
    const step = Math.max(0, Math.min((now - lastTime) / 16.67, 3));
    lastTime = now;
    fxCtx.clearRect(0, 0, innerWidth, innerHeight);
    particles = particles.filter((p) => {
      p.life += step;
      if (p.life >= p.ttl) return false;
      draw(p, step, p.life / p.ttl);
      return true;
    });
    fxCtx.globalAlpha = 1;
    fxCtx.globalCompositeOperation = 'source-over';
    if (particles.length) requestAnimationFrame(frame);
    else running = false;
  }

  function draw(p, step, t) {
    const ctx = fxCtx;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = p.kind === 'smoke' || p.kind === 'chunk' || p.kind === 'confetti' ? 'source-over' : 'lighter';

    if (p.kind === 'flash') {
      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius);
      glow.addColorStop(0, `rgba(255, 255, 240, ${1 - t})`);
      glow.addColorStop(0.35, `rgba(255, 190, 80, ${0.8 * (1 - t)})`);
      glow.addColorStop(1, 'rgba(255, 90, 20, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    if (p.kind === 'ring') {
      p.radius += p.grow * step * (1 - t * 0.6);
      ctx.strokeStyle = `hsla(${p.hue}, 100%, 78%, ${1 - t})`;
      ctx.lineWidth = p.width * (1 - t) + 0.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }

    if (p.kind === 'smoke') {
      p.x += p.vx * step; p.y += p.vy * step;
      p.radius += p.grow * step;
      ctx.fillStyle = `rgba(120, 112, 150, ${0.32 * (1 - t)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    // Everything else flies: apply drag and gravity.
    const drag = Math.pow(p.drag, step);
    p.vx *= drag; p.vy = p.vy * drag + p.gravity * step;
    p.x += p.vx * step; p.y += p.vy * step;

    if (p.kind === 'spark') {
      ctx.strokeStyle = `hsla(${p.hue}, 100%, ${72 - 28 * t}%, ${1 - t * t})`;
      ctx.lineWidth = p.width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * p.tail, p.y - p.vy * p.tail);
      ctx.stroke();
      return;
    }

    // Chunks of the captured piece, and confetti: small spinning rectangles.
    p.angle += p.spin * step;
    ctx.globalAlpha = t > 0.7 ? (1 - t) / 0.3 : 1;
    ctx.fillStyle = p.color;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    // Confetti flutters by squashing its height as it turns.
    const height = p.kind === 'confetti' ? p.size * 0.6 * Math.cos(p.life * p.flutter) : p.size;
    ctx.fillRect(-p.size / 2, -height / 2, p.size, height);
    ctx.restore();
  }

  function sparks(x, y, count, scale, hue, hueSpread, speed, gravity, ttl) {
    for (let i = 0; i < count; i++) {
      const angle = rand(0, Math.PI * 2), v = rand(speed * 0.2, speed) * scale;
      particles.push({
        kind: 'spark', x, y, vx: Math.cos(angle) * v, vy: Math.sin(angle) * v,
        hue: hue + rand(-hueSpread, hueSpread), width: rand(1, 2.6) * Math.max(scale, 0.7), tail: rand(1.5, 3.2),
        drag: 0.955, gravity: gravity * scale, life: 0, ttl: rand(ttl * 0.5, ttl),
      });
    }
  }

  // A capture: flash, shockwave, fiery sparks, smoke and flying bits of the captured piece.
  // `size` is the width of a board square; `whitePiece` says which colour was captured.
  function explode(x, y, size, whitePiece) {
    const scale = size / 64;
    for (let i = 0; i < 8; i++) {
      particles.push({
        kind: 'smoke', x: x + rand(-0.2, 0.2) * size, y: y + rand(-0.2, 0.2) * size,
        vx: rand(-0.5, 0.5) * scale, vy: rand(-0.9, -0.2) * scale,
        radius: size * rand(0.15, 0.3), grow: rand(0.4, 0.9) * scale, life: 0, ttl: rand(40, 75),
      });
    }
    for (let i = 0; i < 18; i++) {
      const angle = rand(0, Math.PI * 2), v = rand(1.5, 6.5) * scale;
      particles.push({
        kind: 'chunk', x, y, vx: Math.cos(angle) * v, vy: Math.sin(angle) * v - 2.5 * scale,
        size: rand(3, 8) * scale, angle: rand(0, 6), spin: rand(-0.4, 0.4),
        color: whitePiece ? '#f8f6ff' : '#1b1736',
        drag: 0.98, gravity: 0.32 * scale, life: 0, ttl: rand(40, 75),
      });
    }
    particles.push({ kind: 'flash', x, y, radius: size * 1.5, life: 0, ttl: 16 });
    particles.push({ kind: 'ring', x, y, radius: size * 0.15, grow: size * 0.085, width: 6 * scale, hue: 38, life: 0, ttl: 26 });
    particles.push({ kind: 'ring', x, y, radius: size * 0.05, grow: size * 0.05, width: 3 * scale, hue: 15, life: 0, ttl: 34 });
    sparks(x, y, 60, scale, 32, 20, 11, 0.16, 58);
    start();
  }

  function firework(x, y) {
    const hue = rand(0, 360);
    const scale = Math.max(Math.min(innerWidth, innerHeight) / 700, 0.6);
    particles.push({ kind: 'flash', x, y, radius: 90 * scale, life: 0, ttl: 12 });
    particles.push({ kind: 'ring', x, y, radius: 4, grow: 5 * scale, width: 3, hue, life: 0, ttl: 30 });
    sparks(x, y, 80, scale, hue, 25, 10, 0.05, 95);
    start();
  }

  function confetti(count) {
    for (let i = 0; i < count; i++) {
      particles.push({
        kind: 'confetti', x: rand(0, innerWidth), y: rand(-innerHeight * 0.6, -10),
        vx: rand(-1.2, 1.2), vy: rand(1.5, 4), size: rand(6, 12), angle: rand(0, 6), spin: rand(-0.2, 0.2),
        flutter: rand(0.1, 0.3), color: `hsl(${rand(0, 360)}, 95%, 65%)`,
        drag: 0.995, gravity: 0.03, life: 0, ttl: rand(200, 330),
      });
    }
    start();
  }

  // The player won: a few seconds of fireworks and falling confetti.
  function celebrate() {
    stop();
    confetti(170);
    for (let i = 0; i < 12; i++) {
      timers.push(setTimeout(() => {
        firework(rand(0.12, 0.88) * innerWidth, rand(0.1, 0.55) * innerHeight);
      }, i * 300 + rand(0, 140)));
    }
  }

  // Cancels fireworks that have not gone off yet; particles already in the air finish falling.
  function stop() {
    timers.forEach(clearTimeout);
    timers = [];
  }

  root.FX = { explode, celebrate, stop };
})(window);
