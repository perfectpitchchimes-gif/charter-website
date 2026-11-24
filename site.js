document.body.classList.add('js');

// Mobile navigation
const menu = document.querySelector('.menu-toggle');
const nav = document.querySelector('#navigation');
function closeMenu() { nav?.classList.remove('open'); menu?.setAttribute('aria-expanded', 'false'); }
menu?.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(open));
  nav.classList.toggle('open', open);
});
nav?.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu?.getAttribute('aria-expanded') === 'true') { closeMenu(); menu.focus(); }
});

// Hero sea motion (auto-pauses when scrolled out of view so it never contends with lower loops)
const heroSection = document.querySelector('.hero');
const motion = document.querySelector('.hero-motion');
const motionButton = document.querySelector('.motion-toggle');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
let motionLoaded = false, heroWanted = false, heroVisible = true;
async function setMotion(play) {
  if (!motion || !motionButton) return;
  heroWanted = !!(play && !reduced.matches);
  if (heroWanted) {
    if (!motionLoaded) { const source = motion.querySelector('source'); source.src = source.dataset.src; motion.load(); motionLoaded = true; }
    try {
      if (heroVisible) await motion.play();
      motion.classList.add('playing');
      motionButton.textContent = 'Pause sea motion';
      motionButton.setAttribute('aria-pressed', 'true');
    } catch { motionButton.textContent = 'Play sea motion'; }
  } else {
    motion.pause(); motion.classList.remove('playing');
    motionButton.textContent = reduced.matches ? 'Motion reduced' : 'Play sea motion';
    motionButton.setAttribute('aria-pressed', 'false');
  }
}
motionButton?.addEventListener('click', () => setMotion(!heroWanted));
reduced.addEventListener('change', () => { if (motionButton) motionButton.disabled = reduced.matches; setMotion(false); });
if (motionButton) { motionButton.disabled = reduced.matches; if (reduced.matches) motionButton.textContent = 'Motion reduced'; }
if (heroSection && motion && 'IntersectionObserver' in window) {
  new IntersectionObserver(entries => {
    heroVisible = entries[0].isIntersecting;
    if (!heroWanted) return;
    if (heroVisible) motion.play().catch(() => {});
    else motion.pause();
  }, { threshold: 0.05 }).observe(heroSection);
}
if (motion && window.matchMedia('(min-width: 701px)').matches && !reduced.matches && !navigator.connection?.saveData) {
  window.addEventListener('load', () => setMotion(true), { once: true });
}

// Viewport-driven gameplay loops
const loops = [...document.querySelectorAll('video.loop')];
if (loops.length && !reduced.matches) {
  const loadLoop = video => {
    const source = video.querySelector('source');
    if (source && !source.src && source.dataset.src) { source.src = source.dataset.src; video.load(); }
  };
  const loopObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const video = entry.target;
      if (entry.isIntersecting) { loadLoop(video); video.play().catch(() => {}); }
      else { video.pause(); }
    }
  }, { rootMargin: '120px 0px', threshold: 0.15 });
  loops.forEach(video => loopObserver.observe(video));
}

// Restrained scroll reveal
const reveals = [...document.querySelectorAll('.reveal')];
if (reveals.length) {
  if (reduced.matches || !('IntersectionObserver' in window)) {
    reveals.forEach(el => el.classList.add('is-visible'));
  } else {
    const revealObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) { entry.target.classList.add('is-visible'); revealObserver.unobserve(entry.target); }
      }
    }, { rootMargin: '0px 0px -40px 0px', threshold: 0.08 });
    reveals.forEach(el => revealObserver.observe(el));
  }
}

// Interactive Field Guide Specimen Switcher
const speciesCatalog = {
  yellowfin_tuna: {
    index: 1, name: 'Yellowfin tuna.', latin: 'Thunnus albacares',
    summary: 'Streamlined blue pelagic hunter with bright yellow fins and real deck weight — heavy enough to swing aboard on the davit.',
    image: '/assets/guide-yellowfin-tuna.png', alt: 'Charter’s yellowfin tuna model, with a streamlined blue body and bright yellow fins.',
    url: '/field-guide/yellowfin-tuna/'
  },
  mackerel: {
    index: 2, name: 'Atlantic mackerel.', latin: 'Scomber scombrus',
    summary: 'Blue-green above and silver below, with broad dark bars along its back. Fast, schooling fish near the surface — a nimble catch to steady on the board.',
    image: '/assets/guide-atlantic-mackerel.png', alt: 'Charter’s Atlantic mackerel model, with blue-green bars and a silver belly.',
    url: '/field-guide/atlantic-mackerel/'
  },
  red_snapper: {
    index: 3, name: 'Red snapper.', latin: 'Lutjanus campechanus',
    summary: 'Deep-bodied reef fish with a pointed face and spiny dorsal fin. Prepared in two clean sections on the deck cutting board.',
    image: '/assets/guide-red-snapper.png', alt: 'Charter’s red snapper model, with a deep red body and spiny dorsal fin.',
    url: '/field-guide/red-snapper/'
  },
  halibut: {
    index: 4, name: 'Atlantic halibut.', latin: 'Hippoglossus hippoglossus',
    summary: 'The largest living flatfish, with both eyes on its upper side. Broad enough to take four fillet sections across two faces.',
    image: '/assets/guide-atlantic-halibut.png', alt: 'Charter’s Atlantic halibut model seen from above, showing its broad flat body.',
    url: '/field-guide/atlantic-halibut/'
  },
  mahi_mahi: {
    index: 5, name: 'Mahi-mahi.', latin: 'Coryphaena hippurus',
    summary: 'Long-bodied surface predator with a tall blue dorsal fin and golden-green sides that fade fast once landed.',
    image: '/assets/guide-mahi-mahi.png', alt: 'Charter’s mahi-mahi model, with a long blue dorsal fin and green-gold sides.',
    url: '/field-guide/mahi-mahi/'
  }
};
const pills = [...document.querySelectorAll('.species-pill')];
const spImg = document.getElementById('specimen-image');
const spTitle = document.getElementById('specimen-title');
const spLatin = document.getElementById('specimen-latin');
const spSummary = document.getElementById('specimen-summary');
const spCaption = document.getElementById('specimen-caption');
const spLink = document.getElementById('specimen-link');
pills.forEach(pill => {
  pill.addEventListener('click', () => {
    const item = speciesCatalog[pill.dataset.species];
    if (!item || !spImg) return;
    pills.forEach(b => b.setAttribute('aria-pressed', String(b === pill)));
    spImg.classList.add('is-swapping');
    window.setTimeout(() => {
      spImg.src = item.image;
      spImg.alt = item.alt;
      if (spTitle) spTitle.textContent = item.name;
      if (spLatin) spLatin.textContent = item.latin;
      if (spSummary) spSummary.textContent = item.summary;
      if (spCaption) spCaption.textContent = `Logbook specimen · ${item.index} of 5`;
      if (spLink) spLink.href = item.url;
      spImg.classList.remove('is-swapping');
    }, reduced.matches ? 0 : 120);
  });
});

// Keyboard-accessible Screenshot Lightbox
const shotLinks = [...document.querySelectorAll('.shots-grid a.shot-card')];
const lightbox = document.getElementById('lightbox');
if (shotLinks.length && lightbox) {
  const lbImg = document.getElementById('lightbox-image');
  const lbCaption = document.getElementById('lightbox-caption');
  const lbCount = document.getElementById('lightbox-count');
  const lbPrev = document.getElementById('lightbox-prev');
  const lbNext = document.getElementById('lightbox-next');
  const lbClose = lightbox.querySelector('.lightbox-close');
  let active = 0, returnFocus = null;

  function showShot(index) {
    active = (index + shotLinks.length) % shotLinks.length;
    const link = shotLinks[active];
    const thumb = link.querySelector('img');
    lbImg.src = link.getAttribute('href');
    lbImg.alt = thumb?.getAttribute('alt') || '';
    lbCaption.textContent = link.dataset.caption || thumb?.getAttribute('alt') || '';
    lbCount.textContent = `${active + 1} / ${shotLinks.length}`;
  }
  function openLightbox(index, trigger) {
    returnFocus = trigger;
    showShot(index);
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
    lbClose?.focus();
  }
  function closeLightbox() {
    if (lightbox.hidden) return;
    lightbox.hidden = true;
    document.body.style.overflow = '';
    returnFocus?.focus();
  }
  shotLinks.forEach((link, i) => {
    link.addEventListener('click', event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openLightbox(i, link);
    });
  });
  lightbox.querySelectorAll('[data-lb-close]').forEach(el => el.addEventListener('click', closeLightbox));
  lbPrev?.addEventListener('click', () => showShot(active - 1));
  lbNext?.addEventListener('click', () => showShot(active + 1));
  document.addEventListener('keydown', event => {
    if (lightbox.hidden) return;
    if (event.key === 'Escape') closeLightbox();
    else if (event.key === 'ArrowLeft') showShot(active - 1);
    else if (event.key === 'ArrowRight') showShot(active + 1);
  });
}

// Optional GA4 conversion events (no-op unless gtag is enabled in site.json)
function track(name, params = {}) {
  if (typeof window.gtag === 'function') window.gtag('event', name, params);
}
document.addEventListener('click', event => {
  const cta = event.target.closest('[data-steam-cta]');
  if (cta) track('cta_click', { label: cta.textContent.trim(), href: cta.getAttribute('href') || '' });
  const social = event.target.closest('.footer-social a, .link-list a.social');
  if (social) track('social_click', { network: social.textContent.trim(), href: social.getAttribute('href') || '' });
  const pill = event.target.closest('.species-pill');
  if (pill) track('field_guide_switch', { species: pill.dataset.species || '' });
  const shot = event.target.closest('.shots-grid a.shot-card');
  if (shot) track('screenshot_open', { shot: shot.querySelector('.shot-caption')?.textContent.trim() || '' });
});
