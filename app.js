const $ = id => document.getElementById(id);
const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  history: '<path d="M3 12a9 9 0 1 1 2.5 6.2M3 5v7h7m2-5v5l3 2"/>',
  phone: '<path d="M7 3H4a1 1 0 0 0-1 1c0 9 8 17 17 17a1 1 0 0 0 1-1v-3l-5-2-2 2a13 13 0 0 1-7-7l2-2z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  report: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  mic: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3"/>',
  volume: '<path d="M3 9v6h4l5 4V5L7 9zM16 9a4 4 0 0 1 0 6m2-8a7 7 0 0 1 0 10"/>',
};
function icon(name) {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`;
}
document.querySelectorAll('[data-icon]').forEach(node => node.innerHTML = icon(node.dataset.icon));
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const labels = {
  dispatching: 'Envoi en cours',
  'dispatch-unknown': 'Envoi à vérifier',
  queued: 'En attente',
  active: 'En cours',
  reported: 'Compte rendu disponible',
  completed: 'Terminé',
  busy: 'Occupé',
  failed: 'Échec',
  'no-answer': 'Sans réponse',
  canceled: 'Annulé',
  'opt-out': 'Ne pas rappeler',
};
const ongoing = new Set(['dispatching', 'queued', 'active']);
let calls = [];
let selected;
const dateLabel = date => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(date));
function rows(items) {
  if (!items.length) return '<p class="empty">Aucun appel à afficher.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>Contact</th><th>État</th><th>Suivi</th><th></th></tr></thead><tbody>${items.map(call =>
    `<tr><td><strong>${escapeHtml(call.name)}</strong><small>${escapeHtml(call.phone)} · ${dateLabel(call.created)}</small></td>
    <td>${escapeHtml(labels[call.state] || call.state)}</td><td>${call.pending ? '<span class="badge gold">À traiter</span>' : '—'}</td>
    <td><button class="text-button" data-report="${escapeHtml(call.id)}">Consulter ${icon('arrow')}</button></td></tr>`
  ).join('')}</tbody></table></div>`;
}
function showError(text) {
  $('notice').textContent = text;
  $('notice').hidden = !text;
}
async function refresh() {
  try {
    const result = await fetch('/api/calls');
    if (!result.ok) throw new Error();
    const data = await result.json();
    calls = data.calls;
    const waiting = calls.filter(call => ongoing.has(call.state));
    const finished = calls.filter(call => !ongoing.has(call.state));
    $('connection').textContent = $('agent-status').textContent = data.telephonyConfigured ? 'Téléphonie configurée' : 'Téléphonie à configurer';
    $('queue-count').textContent = `${waiting.length} en cours`;
    $('count').textContent = finished.length;
    $('pending').textContent = calls.filter(call => call.pending).length;
    $('reports').textContent = finished.filter(call => call.report).length;
    $('queue').innerHTML = rows(waiting);
    $('recent').innerHTML = rows(finished.slice(0, 4));
    $('all-reports').innerHTML = rows(finished);
    showError('');
  } catch {
    showError('Impossible de charger les appels. Réessayez dans un instant.');
  }
}
function openReport(id) {
  const call = calls.find(item => item.id === id);
  if (!call) return;
  selected = call;
  $('report-name').textContent = call.name;
  const details = [
    ['Référence du dossier', call.externalId],
    ['Téléphone', call.phone],
    ['État', labels[call.state] || call.state],
    ['Besoin exprimé', call.report?.need || 'Non renseigné'],
    ['Créneau', call.state === 'opt-out' ? 'Ne pas rappeler' : call.report?.callback || 'Non renseigné'],
  ];
  $('report-content').innerHTML = '<dl>' + details.map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`).join('') + '</dl>';
  $('mark-done').hidden = !call.pending;
  $('report-dialog').showModal();
}
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  const { view, report } = button.dataset;
  if (view) {
    $('home').hidden = view !== 'home';
    $('history').hidden = view !== 'history';
    $('breadcrumb').textContent = view === 'home' ? 'Vue d’ensemble' : 'Historique';
    document.querySelectorAll('.nav-button').forEach(nav => {
      nav.classList.toggle('selected', nav.dataset.view === view);
      if (nav.dataset.view === view) nav.setAttribute('aria-current', 'page');
      else nav.removeAttribute('aria-current');
    });
  }
  if (report) openReport(report);
});
$('refresh').onclick = refresh;
$('mark-done').onclick = async () => {
  const button = $('mark-done');
  button.disabled = true;
  try {
    const result = await fetch(`/api/calls/${selected.id}/close`, { method: 'POST', headers: { 'X-SSP-Action': 'close' } });
    if (!result.ok) throw new Error();
    $('report-dialog').close();
    await refresh();
  } catch {
    $('report-dialog').close();
    showError('Impossible de clôturer le suivi. Actualisez la liste et réessayez.');
  } finally {
    button.disabled = false;
  }
};
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 10000);
