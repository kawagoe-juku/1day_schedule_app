/**
 * AIスケジュール外出支援サービス - 紙芝居HTML共通JS
 * ルール.md「Google Maps Platform」節の API_KEY を使用
 */
const GOOGLE_MAPS_API_KEY = 'YOUR_API_KEY_HERE';

document.addEventListener('DOMContentLoaded', () => {
  initToasts();
  initConfirmDialogs();
  initTimelineExpand();
  initWizard();
  initPasswordResetModal();
  initHomeStateToggle();
  initRoutineForm();
  initMemoForm();
  initResultLayout();
});

function showToast(message, type) {
  const container = document.querySelector('.toast-container');
  if (!container) return;

  const toastEl = document.createElement('div');
  toastEl.className = 'toast align-items-center text-bg-' + (type || 'dark') + ' border-0';
  toastEl.setAttribute('role', 'alert');
  toastEl.innerHTML =
    '<div class="d-flex">' +
    '<div class="toast-body">' + message + '</div>' +
    '<button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>' +
    '</div>';
  container.appendChild(toastEl);
  const toast = new bootstrap.Toast(toastEl, { delay: 3000 });
  toast.show();
  toastEl.addEventListener('hidden.bs.toast', () => toastEl.remove());
}

function initToasts() {
  document.querySelectorAll('[data-show-toast]').forEach((btn) => {
    btn.addEventListener('click', () => {
      showToast(btn.getAttribute('data-show-toast'), btn.getAttribute('data-toast-type') || 'dark');
    });
  });
}

function initConfirmDialogs() {
  document.querySelectorAll('[data-confirm-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-confirm-target');
      const modalEl = document.getElementById(targetId);
      if (modalEl) {
        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
        modal.show();
      }
    });
  });

  document.querySelectorAll('[data-confirm-yes]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-confirm-yes');
      const modalEl = btn.closest('.modal');
      if (modalEl) {
        bootstrap.Modal.getInstance(modalEl).hide();
      }
      if (action === 'delete-routine' || action === 'delete-memo') {
        showToast('削除しました', 'success');
      } else if (action === 'withdraw') {
        window.location.href = '2.2.1_ログイン初回オンボーディング画面.html';
      } else if (action === 'password-reset-complete') {
        showToast('パスワードをリセットしました', 'success');
      }
    });
  });
}

function initTimelineExpand() {
  document.querySelectorAll('[data-expand-timeline]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.timeline-item');
      if (item) {
        item.classList.toggle('timeline-item--expanded');
        btn.textContent = item.classList.contains('timeline-item--expanded') ? '詳細を閉じる' : '詳細を展開';
      }
    });
  });
}

function initWizard() {
  const wizard = document.getElementById('onboarding-wizard');
  if (!wizard) return;

  let currentStep = 1;
  const totalSteps = 6;
  const progressBar = document.getElementById('wizard-progress');
  const progressLabel = document.getElementById('wizard-progress-label');

  function updateWizard() {
    wizard.querySelectorAll('.wizard-step').forEach((step) => {
      step.classList.remove('wizard-step--active');
    });
    const active = wizard.querySelector('[data-step="' + currentStep + '"]');
    if (active) active.classList.add('wizard-step--active');

    if (progressBar) {
      progressBar.style.width = (currentStep / totalSteps * 100) + '%';
    }
    if (progressLabel) {
      progressLabel.textContent = currentStep + '/6';
    }

    const backBtn = document.getElementById('wizard-back');
    const nextBtn = document.getElementById('wizard-next');
    if (backBtn) backBtn.disabled = currentStep === 1;
    if (nextBtn) {
      nextBtn.textContent = currentStep === totalSteps ? '完了' : '次へ';
    }
  }

  document.getElementById('wizard-next')?.addEventListener('click', () => {
    if (currentStep < totalSteps) {
      currentStep++;
      updateWizard();
    } else {
      window.location.href = '2.2.2_ホーム入力画面.html';
    }
  });

  document.getElementById('wizard-back')?.addEventListener('click', () => {
    if (currentStep > 1) {
      currentStep--;
      updateWizard();
    }
  });

  updateWizard();
}

function initPasswordResetModal() {
  const modal = document.getElementById('password-reset-modal');
  if (!modal) return;

  let pwStep = 1;

  function updatePwStep() {
    modal.querySelectorAll('.modal-step').forEach((s) => s.classList.remove('modal-step--active'));
    const active = modal.querySelector('[data-pw-step="' + pwStep + '"]');
    if (active) active.classList.add('modal-step--active');
  }

  modal.querySelectorAll('[data-pw-next]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (pwStep < 3) {
        pwStep++;
        updatePwStep();
      }
    });
  });

  document.getElementById('pw-reset-complete')?.addEventListener('click', () => {
    bootstrap.Modal.getInstance(modal).hide();
    showToast('パスワードをリセットしました', 'success');
    pwStep = 1;
    updatePwStep();
  });

  modal.addEventListener('hidden.bs.modal', () => {
    pwStep = 1;
    updatePwStep();
  });

  updatePwStep();
}

function initHomeStateToggle() {
  const normalState = document.getElementById('home-normal');
  const confirmState = document.getElementById('home-confirm');
  if (!normalState || !confirmState) return;

  document.querySelectorAll('[data-home-state]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const state = btn.getAttribute('data-home-state');
      const isConfirm = state !== 'normal';
      normalState.classList.toggle('hidden', isConfirm);
      confirmState.classList.toggle('hidden', !isConfirm);

      const questionEl = document.getElementById('confirm-question-text');
      const noticeEl = document.getElementById('confirm-notice');
      const answerArea = document.getElementById('confirm-answer');
      const submitBtn = confirmState.querySelector('.btn--primary');
      if (questionEl && noticeEl) {
        if (state === 'confirm-1') {
          questionEl.textContent = '待ち合わせの場所は渋谷駅の何番出口付近ですか？';
          noticeEl.classList.add('hidden');
          if (answerArea) answerArea.closest('.mb-3').classList.remove('hidden');
          if (submitBtn) submitBtn.classList.remove('hidden');
        } else if (state === 'confirm-2') {
          questionEl.textContent = '帰りの買い物はどのスーパーに行きますか？';
          noticeEl.classList.add('hidden');
          if (answerArea) answerArea.closest('.mb-3').classList.remove('hidden');
          if (submitBtn) submitBtn.classList.remove('hidden');
        } else if (state === 'confirm-limit') {
          questionEl.textContent = '確認回数の上限に達しました。';
          noticeEl.textContent = '情報が確定しないため、渋谷駅ハチ公口付近・帰路は最寄りスーパーと仮定して計画を生成します。';
          noticeEl.classList.remove('hidden');
          if (answerArea) answerArea.closest('.mb-3').classList.add('hidden');
          if (submitBtn) submitBtn.classList.add('hidden');
        }
      }
    });
  });
}

function initRoutineForm() {
  const formArea = document.getElementById('routine-form-area');
  const listArea = document.getElementById('routine-list-area');
  if (!formArea) return;

  document.getElementById('routine-new')?.addEventListener('click', () => {
    formArea.classList.remove('hidden');
    listArea?.classList.add('hidden');
  });

  document.getElementById('routine-cancel')?.addEventListener('click', () => {
    formArea.classList.add('hidden');
    listArea?.classList.remove('hidden');
  });

  document.getElementById('routine-save')?.addEventListener('click', () => {
    formArea.classList.add('hidden');
    listArea?.classList.remove('hidden');
    showToast('保存しました', 'success');
  });

  document.querySelectorAll('[data-routine-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      formArea.classList.remove('hidden');
      listArea?.classList.add('hidden');
    });
  });
}

function initMemoForm() {
  const formArea = document.getElementById('memo-form-area');
  const listArea = document.getElementById('memo-list-area');
  if (!formArea) return;

  document.getElementById('memo-new')?.addEventListener('click', () => {
    formArea.classList.remove('hidden');
    listArea?.classList.add('hidden');
  });

  document.getElementById('memo-cancel')?.addEventListener('click', () => {
    formArea.classList.add('hidden');
    listArea?.classList.remove('hidden');
  });

  document.getElementById('memo-save')?.addEventListener('click', () => {
    formArea.classList.add('hidden');
    listArea?.classList.remove('hidden');
    showToast('保存しました', 'success');
  });

  document.querySelectorAll('[data-memo-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      formArea.classList.remove('hidden');
      listArea?.classList.add('hidden');
    });
  });
}

const RESULT_LAYOUT_SNAP = {
  'map-full': 22,
  balanced: 42,
  'timeline-full': 88
};

const RESULT_LAYOUT_SNAP_LANDSCAPE = {
  'map-full': 28,
  balanced: 38,
  'timeline-full': 75
};

const RESULT_LAYOUT_SNAP_WEB = {
  'map-full': 32,
  balanced: 42,
  'timeline-full': 58
};

const RESULT_LAYOUT_WIDE_MQ = window.matchMedia('(min-width: 768px)');

function isResultLayoutWide() {
  return RESULT_LAYOUT_WIDE_MQ.matches;
}

function getResultLayoutSnap() {
  if (isResultLayoutWide()) {
    return RESULT_LAYOUT_SNAP_WEB;
  }
  const landscape = window.matchMedia('(orientation: landscape) and (max-height: 500px)').matches;
  return landscape ? RESULT_LAYOUT_SNAP_LANDSCAPE : RESULT_LAYOUT_SNAP;
}

function getCurrentLayoutPercent(layout) {
  if (isResultLayoutWide()) {
    return parseFloat(layout.style.getPropertyValue('--sheet-width')) || getResultLayoutSnap().balanced;
  }
  return parseFloat(layout.style.getPropertyValue('--sheet-height')) || getResultLayoutSnap().balanced;
}

function triggerResultMapResize() {
  const map = window.resultMapInstance;
  if (!map || !window.google) return;
  const center = map.getCenter();
  google.maps.event.trigger(map, 'resize');
  if (center) map.setCenter(center);
}

function initResultLayout() {
  const layout = document.getElementById('result-layout');
  const handle = document.getElementById('result-sheet-handle');
  if (!layout || !handle) return;

  let dragging = false;
  let startY = 0;
  let startHeight = getResultLayoutSnap().balanced;

  function applyLayoutSize(percent, layoutName) {
    if (isResultLayoutWide()) {
      layout.classList.add('result-layout--wide');
      layout.style.removeProperty('--sheet-height');
      layout.style.setProperty('--sheet-width', percent + '%');
    } else {
      layout.classList.remove('result-layout--wide');
      layout.style.removeProperty('--sheet-width');
      layout.style.setProperty('--sheet-height', percent + '%');
    }

    if (layoutName) {
      layout.dataset.layout = layoutName;
      layout.querySelectorAll('[data-layout-snap]').forEach((btn) => {
        const active = btn.getAttribute('data-layout-snap') === layoutName;
        btn.classList.toggle('result-layout__snap-btn--active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    }
    triggerResultMapResize();
  }

  function snapToNearest(percent) {
    const snap = getResultLayoutSnap();
    let nearest = 'balanced';
    let minDiff = Infinity;
    Object.entries(snap).forEach(([name, value]) => {
      const diff = Math.abs(value - percent);
      if (diff < minDiff) {
        minDiff = diff;
        nearest = name;
      }
    });
    applyLayoutSize(snap[nearest], nearest);
  }

  function reapplyCurrentLayout() {
    const current = layout.dataset.layout || 'balanced';
    applyLayoutSize(getResultLayoutSnap()[current], current);
  }

  function onPointerDown(e) {
    if (isResultLayoutWide()) return;
    dragging = true;
    startY = e.clientY;
    startHeight = getCurrentLayoutPercent(layout);
    layout.classList.add('result-layout--dragging');
    handle.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!dragging || isResultLayoutWide()) return;
    const layoutRect = layout.getBoundingClientRect();
    const deltaPercent = ((startY - e.clientY) / layoutRect.height) * 100;
    const nextHeight = Math.max(18, Math.min(92, startHeight + deltaPercent));
    applyLayoutSize(nextHeight);
  }

  function onPointerUp(e) {
    if (!dragging) return;
    dragging = false;
    layout.classList.remove('result-layout--dragging');
    if (handle.hasPointerCapture(e.pointerId)) {
      handle.releasePointerCapture(e.pointerId);
    }
    snapToNearest(getCurrentLayoutPercent(layout));
  }

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', onPointerUp);
  handle.addEventListener('pointercancel', onPointerUp);

  handle.addEventListener('keydown', (e) => {
    const order = ['map-full', 'balanced', 'timeline-full'];
    const snap = getResultLayoutSnap();
    const current = layout.dataset.layout || 'balanced';
    const idx = order.indexOf(current);
    const prevKey = isResultLayoutWide() ? 'ArrowLeft' : 'ArrowUp';
    const nextKey = isResultLayoutWide() ? 'ArrowRight' : 'ArrowDown';
    if (e.key === nextKey && idx < order.length - 1) {
      const next = order[idx + 1];
      applyLayoutSize(snap[next], next);
    } else if (e.key === prevKey && idx > 0) {
      const next = order[idx - 1];
      applyLayoutSize(snap[next], next);
    }
  });

  layout.querySelectorAll('[data-layout-snap]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-layout-snap');
      applyLayoutSize(getResultLayoutSnap()[name], name);
    });
  });

  const onViewportChange = () => {
    window.requestAnimationFrame(() => {
      reapplyCurrentLayout();
      triggerResultMapResize();
    });
  };

  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', () => {
    window.setTimeout(onViewportChange, 150);
  });

  if (typeof RESULT_LAYOUT_WIDE_MQ.addEventListener === 'function') {
    RESULT_LAYOUT_WIDE_MQ.addEventListener('change', onViewportChange);
  } else if (typeof RESULT_LAYOUT_WIDE_MQ.addListener === 'function') {
    RESULT_LAYOUT_WIDE_MQ.addListener(onViewportChange);
  }

  applyLayoutSize(getResultLayoutSnap().balanced, 'balanced');
}

function loadGoogleMaps(callback) {
  if (window.google && window.google.maps) {
    callback();
    return;
  }
  window.initMap = callback;
  const script = document.createElement('script');
  script.async = true;
  script.defer = true;
  script.src = 'https://maps.googleapis.com/maps/api/js?key=' + GOOGLE_MAPS_API_KEY + '&callback=initMap';
  document.body.appendChild(script);
}

function initResultMap() {
  const mapEl = document.getElementById('map');
  if (!mapEl) return;

  loadGoogleMaps(function initMap() {
    const center = { lat: 35.681406, lng: 139.767132 };
    const map = new google.maps.Map(mapEl, {
      zoom: 14,
      center: center
    });
    window.resultMapInstance = map;

    const markers = [
      { position: { lat: 35.6762, lng: 139.6503 }, title: '自宅' },
      { position: { lat: 35.6580, lng: 139.7016 }, title: '乗換駅（新宿）' },
      { position: { lat: 35.6585, lng: 139.7034 }, title: '渋谷駅 ハチ公口' },
      { position: { lat: 35.6590, lng: 139.7005 }, title: 'スーパー（立寄り先）' }
    ];

    markers.forEach((m) => {
      new google.maps.Marker({ position: m.position, map: map, title: m.title });
    });

    new google.maps.Polyline({
      path: [
        { lat: 35.6762, lng: 139.6503 },
        { lat: 35.6580, lng: 139.7016 }
      ],
      geodesic: true,
      strokeColor: '#4285F4',
      strokeOpacity: 1.0,
      strokeWeight: 4,
      map: map
    });

    new google.maps.Polyline({
      path: [
        { lat: 35.6580, lng: 139.7016 },
        { lat: 35.6585, lng: 139.7034 }
      ],
      geodesic: true,
      strokeColor: '#34A853',
      strokeOpacity: 1.0,
      strokeWeight: 4,
      map: map
    });

    new google.maps.Polyline({
      path: [
        { lat: 35.6585, lng: 139.7034 },
        { lat: 35.6590, lng: 139.7005 },
        { lat: 35.6762, lng: 139.6503 }
      ],
      geodesic: true,
      strokeColor: '#4285F4',
      strokeOpacity: 1.0,
      strokeWeight: 4,
      map: map
    });

    triggerResultMapResize();
  });
}

if (document.getElementById('map')) {
  initResultMap();
}
