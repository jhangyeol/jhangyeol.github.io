// Chiikawa friends hopping across the sky behind the machine, left→right or right→left, at a
// random small size and height. Pure CSS/Web Animations on the background layer, so they never
// wake the WebGL renderer.

const IMAGES = Array.from({ length: 9 }, (_, i) => `img/walkers/${i + 1}.png`);
const MAX_ON_SCREEN = 4;

export function startWalkers(root) {
  const layer = document.createElement("div");
  layer.className = "walkers";
  layer.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none";
  root.appendChild(layer);
  // warm the cache so a walker never pops in half-loaded
  for (const src of IMAGES) new Image().src = src;

  let alive = 0;
  function spawn() {
    if (alive < MAX_ON_SCREEN && !document.hidden) {
      alive++;
      const el = document.createElement("div");
      el.className = "walker";
      const img = document.createElement("img");
      img.src = IMAGES[Math.floor(Math.random() * IMAGES.length)];
      img.alt = "";
      img.style.animationDuration = (0.4 + Math.random() * 0.3).toFixed(2) + "s";
      el.appendChild(img);
      const size = Math.round(Math.min(innerWidth, innerHeight) * (0.07 + Math.random() * 0.06));
      el.style.width = size + "px";
      el.style.top = 12 + Math.random() * 72 + "%";
      layer.appendChild(el);
      const ltr = Math.random() < 0.5;
      const from = ltr ? -size : innerWidth;
      const to = ltr ? innerWidth : -size;
      // face the way they walk
      const flip = ltr ? "" : " scaleX(-1)";
      const anim = el.animate([{ transform: `translateX(${from}px)${flip}` }, { transform: `translateX(${to}px)${flip}` }], {
        duration: (innerWidth / (60 + Math.random() * 60)) * 1000,
        easing: "linear",
      });
      anim.onfinish = () => {
        el.remove();
        alive--;
      };
    }
    setTimeout(spawn, 1800 + Math.random() * 4200);
  }
  setTimeout(spawn, 600);
}
