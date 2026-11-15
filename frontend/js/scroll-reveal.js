/**
 * Ignis — Scroll-Triggered Reveal Choreography & Planetary Horizon Parallax
 *
 * Uses a single shared IntersectionObserver + passive rAF parallax driver.
 * Animates GPU-composited transform & opacity only and strictly honors
 * prefers-reduced-motion.
 */

let revealObserver = null;
let parallaxBound = false;

function isReducedMotion() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function assignStaggerDelays(root) {
  root.querySelectorAll('[data-reveal-stagger]').forEach((group) => {
    const step = Number(group.dataset.revealStagger || 75);
    let idx = 0;
    Array.from(group.children).forEach((child) => {
      if (!(child instanceof HTMLElement)) return;
      if (!child.hasAttribute('data-reveal')) {
        child.setAttribute('data-reveal', group.dataset.revealDir || 'up');
      }
      child.style.setProperty('--reveal-delay', `${Math.min(idx * step, 420)}ms`);
      idx++;
    });
  });
}

function revealImmediately(root) {
  root.querySelectorAll('[data-reveal]').forEach((el) => {
    el.classList.add('is-revealed');
  });
}

function ensureObserver() {
  if (revealObserver) return revealObserver;
  if (typeof IntersectionObserver !== 'function') return null;

  revealObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-revealed');
          revealObserver?.unobserve(entry.target);
        }
      }
    },
    {
      threshold: 0.12,
      rootMargin: '0px 0px -48px 0px',
    }
  );
  return revealObserver;
}

export function refreshScrollReveals(root = document) {
  assignStaggerDelays(root);

  if (isReducedMotion()) {
    revealImmediately(root);
    return;
  }

  const obs = ensureObserver();
  if (!obs) {
    revealImmediately(root);
    return;
  }

  const vh = window.innerHeight || 900;
  root.querySelectorAll('[data-reveal]:not(.is-revealed)').forEach((el) => {
    const rect = el.getBoundingClientRect();
    // Elements already well inside the initial viewport on load animate cleanly on next frame
    if (rect.width > 0 && rect.height > 0 && rect.top < vh * 0.92 && rect.bottom > 0) {
      requestAnimationFrame(() => el.classList.add('is-revealed'));
    } else {
      obs.observe(el);
    }
  });
}

function bindHorizonParallax() {
  if (parallaxBound || isReducedMotion()) return;
  parallaxBound = true;

  let raf = 0;
  const update = () => {
    raf = 0;
    const stage = document.getElementById('ignis-horizon-stage');
    if (!stage) return;
    const y = Math.min(window.scrollY || 0, 900);
    const shiftY = y * 0.085;
    const scaleX = 1 + Math.min(y / 2200, 0.08);
    const glowOp = Math.max(0.45, 1 - y / 1100);
    stage.style.setProperty('--horizon-shift', `${shiftY.toFixed(1)}px`);
    stage.style.setProperty('--horizon-scale', scaleX.toFixed(4));
    stage.style.setProperty('--horizon-glow', glowOp.toFixed(3));
  };

  window.addEventListener(
    'scroll',
    () => {
      if (!raf) raf = requestAnimationFrame(update);
    },
    { passive: true }
  );
  update();
}

export function initScrollReveal() {
  refreshScrollReveals(document);
  bindHorizonParallax();
}
