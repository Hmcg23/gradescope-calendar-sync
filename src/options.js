import { getState, updateSettings, resetSyncState } from './storage.js';

const $ = (id) => document.getElementById(id);
const CHECKS = ['skipSubmitted', 'skipPast', 'shiftMidnight', 'dryRun', 'debugDumpHtml'];

let flashTimer;
function flash(text = 'Saved') {
  $('saved').textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => ($('saved').textContent = ''), 1600);
}

async function render() {
  const state = await getState();
  for (const key of CHECKS) $(key).checked = Boolean(state.settings[key]);
  $('calendarName').value = state.settings.calendarName;
  $('reminderMinutes').value =
    state.settings.reminderMinutes === null || state.settings.reminderMinutes === undefined
      ? ''
      : state.settings.reminderMinutes === false
        ? 'none'
        : String(state.settings.reminderMinutes);

  if (state.calendarId) {
    $('calIdBlock').hidden = false;
    $('calId').textContent = state.calendarId;
  }

  const box = $('courses');
  box.textContent = '';
  if (!state.courses.length) {
    box.innerHTML = '<p class="hint">Run a sync to discover your courses.</p>';
    return;
  }
  for (const course of state.courses) {
    const label = document.createElement('label');
    label.className = 'row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = course.enabled !== false;
    input.addEventListener('change', async () => {
      const { courses } = await getState();
      const next = courses.map((c) => (c.id === course.id ? { ...c, enabled: input.checked } : c));
      await chrome.storage.local.set({ courses: next });
      flash();
    });
    const span = document.createElement('span');
    span.textContent = course.shortName || course.name || `Course ${course.id}`;
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = [course.name, course.term].filter(Boolean).join(' · ');
    span.append(hint);
    label.append(input, span);
    box.append(label);
  }
}

for (const key of CHECKS) {
  $(key).addEventListener('change', async () => {
    await updateSettings({ [key]: $(key).checked });
    flash();
  });
}

$('calendarName').addEventListener('change', async () => {
  await updateSettings({ calendarName: $('calendarName').value.trim() || 'Gradescope' });
  flash();
});

$('reminderMinutes').addEventListener('change', async () => {
  const raw = $('reminderMinutes').value;
  await updateSettings({ reminderMinutes: raw === '' ? null : raw === 'none' ? false : Number(raw) });
  flash('Saved — applies on the next sync');
});

$('copyCalId').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('calId').textContent);
  flash('Calendar ID copied');
});

$('reset').addEventListener('click', async () => {
  await resetSyncState();
  flash('Sync state cleared');
});

$('disconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'DISCONNECT' });
  flash('Disconnected');
});

render();
