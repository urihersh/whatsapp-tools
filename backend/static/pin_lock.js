// PIN lock overlay — included on every protected page.
// Checks /api/auth/status on load; shows overlay if pin is enabled and session is not authenticated.

(async function () {
  let status;
  try {
    const r = await fetch('/api/auth/status');
    status = await r.json();
  } catch (_) { return; }

  if (!status.pin_enabled) return;
  if (sessionStorage.getItem('pt_auth') === '1') return;

  // Build overlay
  const overlay = document.createElement('div');
  overlay.id = 'pin-overlay';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:9999',
    'background:rgba(15,23,42,0.97)',
    'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center',
    'font-family:Inter,system-ui,sans-serif',
  ].join(';');

  overlay.innerHTML = `
    <div style="text-align:center;max-width:320px;width:100%;padding:0 24px">
      <div style="width:56px;height:56px;border-radius:16px;background:#2563eb;display:flex;align-items:center;justify-content:center;margin:0 auto 20px">
        <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="white" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
        </svg>
      </div>
      <p style="color:#f8fafc;font-size:20px;font-weight:700;margin:0 0 6px">Parent Tool</p>
      <p style="color:#94a3b8;font-size:14px;margin:0 0 28px">Enter your PIN to continue</p>
      <div id="pin-dots" style="display:flex;justify-content:center;gap:12px;margin-bottom:24px">
        <span class="dot" style="width:14px;height:14px;border-radius:50%;background:#334155;transition:background .15s"></span>
        <span class="dot" style="width:14px;height:14px;border-radius:50%;background:#334155;transition:background .15s"></span>
        <span class="dot" style="width:14px;height:14px;border-radius:50%;background:#334155;transition:background .15s"></span>
        <span class="dot" style="width:14px;height:14px;border-radius:50%;background:#334155;transition:background .15s"></span>
        <span class="dot" style="width:14px;height:14px;border-radius:50%;background:#334155;transition:background .15s"></span>
        <span class="dot" style="width:14px;height:14px;border-radius:50%;background:#334155;transition:background .15s"></span>
      </div>
      <p id="pin-error" style="color:#f87171;font-size:13px;min-height:18px;margin:0 0 16px;opacity:0;transition:opacity .2s"></p>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
        ${[1,2,3,4,5,6,7,8,9,'',0,'⌫'].map(k => `
          <button data-key="${k}" style="
            padding:16px 0;border-radius:14px;border:none;cursor:${k===''?'default':'pointer'};
            background:${k===''?'transparent':'#1e293b'};color:#f8fafc;font-size:20px;font-weight:600;
            transition:background .1s;${k===''?'pointer-events:none':''}
          " ${k===''?'disabled':''} onmouseover="if(this.dataset.key!=='')this.style.background='#334155'" onmouseout="if(this.dataset.key!=='')this.style.background='#1e293b'">${k}</button>
        `).join('')}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  let pin = '';
  const dots = overlay.querySelectorAll('.dot');
  const errorEl = overlay.querySelector('#pin-error');

  function updateDots() {
    dots.forEach((d, i) => {
      d.style.background = i < pin.length ? '#2563eb' : '#334155';
    });
  }

  function shake() {
    overlay.querySelector('div').animate(
      [{ transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' },
       { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' },
       { transform: 'translateX(0)' }],
      { duration: 350, easing: 'ease-out' }
    );
  }

  async function submitPin() {
    try {
      const r = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const d = await r.json();
      if (d.ok) {
        sessionStorage.setItem('pt_auth', '1');
        overlay.remove();
      } else {
        errorEl.textContent = 'Incorrect PIN';
        errorEl.style.opacity = '1';
        shake();
        pin = '';
        updateDots();
        setTimeout(() => { errorEl.style.opacity = '0'; }, 2000);
      }
    } catch (_) {}
  }

  overlay.addEventListener('click', async (e) => {
    const key = e.target.closest('button')?.dataset?.key;
    if (key === undefined) return;
    if (key === '⌫') {
      pin = pin.slice(0, -1);
    } else if (pin.length < 6) {
      pin += key;
    }
    updateDots();
    if (pin.length === 6) await submitPin();
  });

  // Keyboard support
  document.addEventListener('keydown', async (e) => {
    if (!document.getElementById('pin-overlay')) return;
    if (e.key >= '0' && e.key <= '9' && pin.length < 6) {
      pin += e.key;
    } else if (e.key === 'Backspace') {
      pin = pin.slice(0, -1);
    } else if (e.key === 'Enter' && pin.length > 0) {
      await submitPin();
      return;
    }
    updateDots();
    if (pin.length === 6) await submitPin();
  });
})();
