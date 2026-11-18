// Development posts: clips that play while visible, before/after frames, and the fishing line demo.
(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Looping clips play only while on screen, and the reader can always pause them.
  const loops = [...document.querySelectorAll('video.loop')];
  const heldByReader = new WeakSet();
  for (const video of loops) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'clip-toggle';
    const label = () => {
      button.textContent = video.paused ? 'Play' : 'Pause';
      button.setAttribute('aria-label', `${video.paused ? 'Play' : 'Pause'}: ${video.getAttribute('aria-label') || 'clip'}`);
    };
    button.addEventListener('click', () => {
      if (video.paused) { heldByReader.delete(video); video.play().catch(() => {}); }
      else { heldByReader.add(video); video.pause(); }
    });
    video.addEventListener('play', label);
    video.addEventListener('pause', label);
    // The control sits on the caption line under the clip, so it never covers the footage.
    // In a gallery each clip gets its own cell; the gallery caption stays with the gallery.
    const meta = document.createElement('div');
    meta.className = 'media-meta';
    const figure = video.closest('figure');
    if (figure?.classList.contains('gallery')) {
      const cell = document.createElement('div');
      cell.className = 'gallery-cell';
      video.replaceWith(cell);
      cell.append(video, meta);
    } else {
      const caption = figure?.querySelector(':scope > figcaption');
      if (caption) meta.append(caption);
      (figure || video.parentElement).insertBefore(meta, video.nextSibling);
    }
    meta.append(button);
    label();
  }

  // Build slider: one frame per build, stacked; the range input picks which is visible.
  for (const figure of document.querySelectorAll('[data-scrubber]')) {
    const frames = [...figure.querySelectorAll('.scrub-frames img')];
    const input = figure.querySelector('input[type=range]');
    const name = figure.querySelector('[data-scrub-label]');
    input.max = String(frames.length - 1);
    const show = index => {
      frames.forEach((img, i) => { img.hidden = i !== index; });
      name.textContent = frames[index].dataset.label;
      input.setAttribute('aria-valuetext', frames[index].dataset.label);
    };
    input.addEventListener('input', () => show(Number(input.value)));
    frames.forEach(img => { img.loading = 'eager'; });
    show(Number(input.value) || 0);
  }
  if ('IntersectionObserver' in window) {
    const watcher = new IntersectionObserver(entries => {
      for (const { target, isIntersecting } of entries) {
        if (isIntersecting && !reduced.matches && !heldByReader.has(target)) target.play().catch(() => {});
        else if (!isIntersecting) target.pause();
      }
    }, { threshold: 0.5 });
    loops.forEach(video => watcher.observe(video));
  }

  // Before/after frames share one position; the buttons choose which is visible.
  for (const figure of document.querySelectorAll('[data-compare]')) {
    const buttons = [...figure.querySelectorAll('[data-show]')];
    const show = which => {
      figure.dataset.showing = which;
      buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.show === which)));
    };
    buttons.forEach(button => button.addEventListener('click', () => show(button.dataset.show)));
    show('before');
  }

  for (const figure of document.querySelectorAll('[data-line-demo]')) lineDemo(figure);

  // The prototype's line, in 2D: 21 Verlet points, 0.91 damping, 7 m/s² gravity, 18 constraint
  // passes and 5.5 to 0.2 percent spare length. The float uses the prototype's spring (90, 11)
  // on the z = 0 slice of its three-wave water, and the rod bend uses its spring (75, 12).
  function lineDemo(figure) {
    const canvas = figure.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const tensionInput = figure.querySelector('[data-tension]');
    const tensionOutput = figure.querySelector('[data-tension-value]');
    const originalInput = figure.querySelector('[data-original]');
    const dropButton = figure.querySelector('[data-drop]');
    const SEGMENTS = 20, STEP = 1 / 60, TOP = 3.6, HEIGHT = 5.1, NEAR = 4.6;
    const phase = (731 % 97) * 0.13;
    const waterAt = (x, t) => Math.sin(x * 0.18 + t * 0.85 + phase) * 0.32 + Math.sin(-t * 1.2 + phase * 0.7) * 0.16 + Math.sin(x * 0.52 + t * 1.7) * 0.06;
    const colors = { ink: '#302f28', paper: '#e7dfca', sea: '#253d40', shallows: '#bfd0c9', red: '#763c33', cream: '#efe6cf' };

    let width = 0, height = 0, scale = 1, viewWidth = 15, dpr = 1;
    let t = 0, tension = 0, bend = 0.04, bendVelocity = 0;
    const float = { x: 10, y: 0.17, vx: 0, vy: 0, mode: 'water' };
    let points = [], previous = [], tip = { x: 0, y: 0 }, drag = null;
    let running = false, last = 0, accumulator = 0;

    const toScreen = (x, y) => [x * scale, (TOP - y) * scale];
    const toWorld = (px, py) => ({ x: px / scale, y: TOP - py / scale });

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth; height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      scale = height / HEIGHT;
      viewWidth = width / scale;
      float.x = Math.min(Math.max(float.x, NEAR), viewWidth - 0.8);
      if (!running) draw();
    }

    function boatPose() {
      const x = -0.4;
      const y = waterAt(x, t) + 0.22;
      const angle = Math.atan2(waterAt(x + 2, t) - waterAt(x - 2, t), 4);
      return { x, y, angle };
    }
    const local = (pose, lx, ly) => {
      const c = Math.cos(pose.angle), s = Math.sin(pose.angle);
      return { x: pose.x + lx * c - ly * s, y: pose.y + lx * s + ly * c };
    };
    const rodPoint = (pose, u) => local(pose, 0.9 + 2.8 * u, 1.05 + 1.6 * u - bend * u * u * u);

    function resetLine(start, end) {
      points = []; previous = [];
      for (let i = 0; i <= SEGMENTS; i++) {
        const u = i / SEGMENTS;
        const p = { x: start.x + (end.x - start.x) * u, y: start.y + (end.y - start.y) * u - Math.sin(Math.PI * u) * 0.25 };
        points.push(p); previous.push({ ...p });
      }
    }

    function step(dt) {
      if (!reduced.matches) t += dt;
      const fighting = tension > 0;
      const desiredBend = fighting ? 0.35 + tension : 0.04;
      bendVelocity += (desiredBend - bend) * 75 * dt - bendVelocity * 12 * dt;
      bend += bendVelocity * dt;
      tip = rodPoint(boatPose(), 1);

      const surface = waterAt(float.x, t) + 0.17;
      if (float.mode === 'water') {
        float.vy += ((surface - float.y) * 90 - float.vy * 11) * dt;
        float.y += float.vy * dt;
      } else if (float.mode === 'fall') {
        float.vy -= 9.8 * dt;
        float.x = Math.min(Math.max(float.x + float.vx * dt, NEAR), viewWidth - 0.5);
        float.vx *= 0.99;
        float.y += float.vy * dt;
        if (float.y <= surface) { float.mode = 'water'; float.y = surface - 0.09; float.vy = -1.2; }
      }

      const end = { x: float.x, y: float.y + 0.1 };
      const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      if (!points.length || dist(points[0], tip) > 3 || dist(points[SEGMENTS], end) > 6) resetLine(tip, end);
      const tautness = fighting ? Math.min(1, tension + 0.5) : 0.1;
      const segment = Math.max(0.02, dist(tip, end) * (1.055 + (1.002 - 1.055) * tautness) / SEGMENTS);
      for (let i = 1; i < SEGMENTS; i++) {
        const p = points[i], q = previous[i], x = p.x, y = p.y;
        p.x += (p.x - q.x) * 0.91;
        p.y += (p.y - q.y) * 0.91 - 7.0 * dt * dt;
        q.x = x; q.y = y;
      }
      for (let pass = 0; pass < 18; pass++) {
        points[0].x = tip.x; points[0].y = tip.y;
        points[SEGMENTS].x = end.x; points[SEGMENTS].y = end.y;
        for (let i = 0; i < SEGMENTS; i++) {
          const a = points[i], b = points[i + 1];
          const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
          if (length < 0.00001) continue;
          const k = (length - segment) / length, cx = dx * k, cy = dy * k;
          if (i === 0) { b.x -= cx; b.y -= cy; }
          else if (i === SEGMENTS - 1) { a.x += cx; a.y += cy; }
          else { a.x += cx * 0.5; a.y += cy * 0.5; b.x -= cx * 0.5; b.y -= cy * 0.5; }
        }
      }
      points[0].x = tip.x; points[0].y = tip.y;
      points[SEGMENTS].x = end.x; points[SEGMENTS].y = end.y;
    }

    function path(list) {
      ctx.beginPath();
      list.forEach((p, i) => { const [x, y] = toScreen(p.x, p.y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    }

    function draw() {
      if (!width) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = colors.paper;
      ctx.fillRect(0, 0, width, height);

      // Water: the surface in ink, with fainter lines below it.
      const surface = [];
      for (let x = -0.5; x <= viewWidth + 0.5; x += 0.2) surface.push({ x, y: waterAt(x, t) });
      path(surface);
      ctx.lineTo(width + 20, height + 20); ctx.lineTo(-20, height + 20); ctx.closePath();
      ctx.fillStyle = colors.shallows; ctx.fill();
      for (const [depth, alpha] of [[0.7, 0.16], [1.4, 0.1]]) {
        path(surface.map(p => ({ x: p.x, y: p.y * 0.55 - depth })));
        ctx.strokeStyle = `rgba(37,61,64,${alpha * 1.6})`; ctx.lineWidth = 1; ctx.stroke();
      }
      path(surface); ctx.strokeStyle = colors.sea; ctx.lineWidth = 1.4; ctx.stroke();

      // Boat, rod and reel.
      const pose = boatPose();
      path([[-1.5, 0.95], [1.9, 0.95], [1.55, -0.3], [-1.25, -0.3]].map(([x, y]) => local(pose, x, y)));
      ctx.closePath(); ctx.fillStyle = colors.cream; ctx.fill();
      ctx.strokeStyle = colors.ink; ctx.lineWidth = 1.4; ctx.stroke();
      path([local(pose, -1.42, 0.45), local(pose, 1.72, 0.45)]); ctx.strokeStyle = colors.red; ctx.lineWidth = 3; ctx.stroke();
      const rod = [];
      for (let i = 0; i <= 12; i++) rod.push(rodPoint(pose, i / 12));
      path(rod); ctx.strokeStyle = colors.ink; ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.stroke();

      // Line: either the simulation or the original drawn curve.
      if (originalInput.checked) {
        const end = { x: float.x, y: float.y + 0.1 }, sag = tension > 0 ? 0.12 : 0.65, curve = [];
        for (let i = 0; i <= 32; i++) {
          const u = i / 32;
          curve.push({ x: tip.x + (end.x - tip.x) * u, y: tip.y + (end.y - tip.y) * u - Math.sin(u * Math.PI) * sag });
        }
        path(curve); ctx.strokeStyle = colors.ink; ctx.lineWidth = 1.1; ctx.stroke();
      } else {
        path(points); ctx.strokeStyle = colors.ink; ctx.lineWidth = 1.1; ctx.stroke();
        ctx.fillStyle = colors.red;
        for (const p of points) { const [x, y] = toScreen(p.x, p.y); ctx.beginPath(); ctx.arc(x, y, 1.9, 0, Math.PI * 2); ctx.fill(); }
      }

      // Float: cream body with a red cap.
      const [fx, fy] = toScreen(float.x, float.y);
      const r = Math.max(6, 0.13 * scale);
      ctx.beginPath(); ctx.arc(fx, fy, r, 0, Math.PI * 2); ctx.fillStyle = colors.cream; ctx.fill();
      ctx.beginPath(); ctx.arc(fx, fy, r, Math.PI, 0); ctx.fillStyle = colors.red; ctx.fill();
      ctx.beginPath(); ctx.arc(fx, fy, r, 0, Math.PI * 2); ctx.strokeStyle = colors.ink; ctx.lineWidth = 1.3; ctx.stroke();
    }

    function frame(now) {
      if (!running) return;
      accumulator += Math.min(0.1, (now - last) / 1000);
      last = now;
      let steps = 0;
      while (accumulator >= STEP && steps < 6) { step(STEP); accumulator -= STEP; steps++; }
      draw();
      requestAnimationFrame(frame);
    }
    function start() { if (running) return; running = true; last = performance.now(); requestAnimationFrame(frame); }
    function stop() { running = false; }

    const nearFloat = event => {
      const rect = canvas.getBoundingClientRect();
      const p = toWorld(event.clientX - rect.left, event.clientY - rect.top);
      const reach = event.pointerType === 'touch' ? Math.max(1.1, 34 / scale) : Math.max(0.7, 22 / scale);
      return { p, near: Math.hypot(p.x - float.x, p.y - float.y) < reach };
    };
    canvas.addEventListener('pointerdown', event => {
      const { p, near } = nearFloat(event);
      if (!near) return;
      drag = { id: event.pointerId, lastX: p.x, lastY: p.y, lastTime: performance.now() };
      float.mode = 'drag';
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = 'grabbing';
      event.preventDefault();
    });
    canvas.addEventListener('pointermove', event => {
      const { p, near } = nearFloat(event);
      if (!drag) { canvas.style.cursor = near ? 'grab' : 'default'; return; }
      const now = performance.now(), dt = Math.max(0.001, (now - drag.lastTime) / 1000);
      float.vx = (p.x - drag.lastX) / dt; float.vy = (p.y - drag.lastY) / dt;
      drag.lastX = p.x; drag.lastY = p.y; drag.lastTime = now;
      float.x = Math.min(Math.max(p.x, NEAR), viewWidth - 0.5);
      float.y = Math.min(Math.max(p.y, -1.2), TOP - 0.3);
      start();
    });
    const release = () => {
      if (!drag) return;
      drag = null;
      canvas.style.cursor = 'grab';
      float.vx = Math.max(-6, Math.min(6, float.vx));
      float.vy = Math.max(-6, Math.min(6, float.vy));
      float.mode = float.y > waterAt(float.x, t) + 0.17 ? 'fall' : 'water';
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    tensionInput.addEventListener('input', () => { tension = Number(tensionInput.value); tensionOutput.value = tension.toFixed(2); tensionOutput.textContent = tension.toFixed(2); start(); });
    originalInput.addEventListener('change', () => { if (!running) draw(); });
    dropButton.addEventListener('click', () => {
      float.mode = 'fall'; float.vx = 0; float.vy = 0;
      float.y = waterAt(float.x, t) + 2.2;
      start();
    });

    new ResizeObserver(resize).observe(canvas);
    resize();
    float.x = Math.min(10.5, Math.max(NEAR + 0.6, viewWidth - 2.2));
    float.y = waterAt(float.x, t) + 0.17;
    tip = rodPoint(boatPose(), 1);
    resetLine(tip, { x: float.x, y: float.y + 0.1 });
    for (let i = 0; i < 120; i++) step(STEP);
    draw();
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([entry]) => (entry.isIntersecting ? start() : stop()), { threshold: 0.1 }).observe(canvas);
    } else start();
  }
})();
