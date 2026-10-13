(() => {
  "use strict";
  for (const [buttonId, bodyId] of [['chainToggle', 'chainBody'], ['oiHeatToggle', 'oiHeatBody'], ['zCycleToggle', 'zCycleBody']]) {
    const button = document.getElementById(buttonId), body = document.getElementById(bodyId);
    button.addEventListener('click', () => {
      const collapsed = body.classList.toggle('hidden');
      button.textContent = collapsed ? 'Expand' : 'Collapse';
      button.setAttribute('aria-expanded', String(!collapsed));
    });
  }
})();
