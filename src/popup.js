const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);

function relative(ts) {
  if (!ts) return 'never';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function until(ts) {
  if (!ts) return '';
  const mins = Math.round((ts - Date.now()) / 60000);
  if (mins <= 0) return 'next sync due';
  if (mins < 60) return `next in ${mins} min`;
  return `next in ${Math.round(mins / 60)}h`;
}

function showBanner(text, actionLabel, onAction) {
  $('bannerText').textContent = text;
  const btn = $('bannerAction');
  if (actionLabel) {
    btn.textContent = actionLabel;
    btn.hidden = false;
    btn.onclick = onAction;
  } else {
    btn.hidden = true;
  }
  $('banner').hidden = false;
}

async function render() {
  const s = await send({ type: 'GET_STATUS' });
  $('banner').hidden = true;

  const dot = $('dot');
  dot.className = 'dot';
  $('status').textContent = `Last synced ${relative(s.lastSyncAt)}`;
  $('next').textContent = until(s.nextSyncAt);

  if (!s.authOk) {
    dot.classList.add('warn');
    $('connect').hidden = false;
    $('sync').hidden = true;
    $('status').textContent = 'Not connected to Google Calendar yet.';
  } else {
    $('connect').hidden = true;
    $('sync').hidden = false;
  }

  if (s.lastSyncStatus === 'ok') dot.classList.add('ok');
  if (s.lastSyncStatus === 'error') {
    dot.classList.add('err');
    showBanner(s.lastError || 'Sync failed.', null);
  }
  if (s.lastSyncStatus === 'login-required') {
    dot.classList.add('err');
    showBanner('Your Gradescope session expired.', 'Open Gradescope', () =>
      chrome.tabs.create({ url: 'https://www.gradescope.com/account' }),
    );
  }

  const sum = s.lastSummary;
  if (sum) {
    $('counts').hidden = false;
    $('cAssignments').textContent = sum.assignments ?? '—';
    $('cCourses').textContent = sum.courses ?? '—';
    $('cChanged').textContent = (sum.created ?? 0) + (sum.updated ?? 0) + (sum.deleted ?? 0);
    if (sum.dryRun) showBanner('Dry run is on — nothing is being written to your calendar.', 'Settings', openOptions);
    else if (sum.failedCourses) showBanner(`${sum.failedCourses} course page(s) could not be read. Their events were left untouched.`, null);
  }
}

function openOptions() {
  chrome.runtime.openOptionsPage();
}

$('sync').addEventListener('click', async () => {
  const btn = $('sync');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  const res = await send({ type: 'SYNC_NOW' });
  btn.disabled = false;
  btn.textContent = 'Sync now';
  await render();
  if (res && !res.ok && res.error && res.error !== 'not-logged-in') showBanner(res.error, null);
});

$('connect').addEventListener('click', async () => {
  const res = await send({ type: 'CONNECT_GOOGLE' });
  if (!res.ok) showBanner(res.error || 'Google sign-in was cancelled.', null);
  await render();
});

$('options').addEventListener('click', openOptions);

render();
