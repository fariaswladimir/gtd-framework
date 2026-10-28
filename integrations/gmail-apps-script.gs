/**
 * Gmail → GTD Inbox
 * 1. Em https://script.google.com crie um projeto e cole este arquivo.
 * 2. Em "Configurações do projeto → Propriedades do script" crie:
 *      GTD_URL   = https://seu-gtd.exemplo.com   (precisa ser público/HTTPS — veja README → Publicar)
 *      GTD_TOKEN = <token de data/config.json>
 * 3. No Gmail, crie o marcador "GTD" (e use filtros ou marque manualmente).
 * 4. Rode setup() uma vez (autoriza e cria o gatilho de 15 em 15 minutos).
 * E-mails enviados recebem o marcador "GTD/enviado" e saem de "GTD". Duplicatas são ignoradas pelo servidor.
 */
const LABEL = 'GTD';
const DONE_LABEL = 'GTD/enviado';

function setup() {
  GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('pushToGtd').timeBased().everyMinutes(15).create();
  pushToGtd();
}

function pushToGtd() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('GTD_URL').replace(/\/$/, '') + '/api/ingest/gmail';
  const token = props.getProperty('GTD_TOKEN');
  const label = GmailApp.getUserLabelByName(LABEL);
  if (!label) return;
  const done = GmailApp.getUserLabelByName(DONE_LABEL);
  const threads = label.getThreads(0, 50);
  if (!threads.length) return;
  const items = threads.map(t => {
    const m = t.getMessages()[0];
    return { subject: t.getFirstMessageSubject(), from: m.getFrom(), snippet: m.getPlainBody().slice(0, 1500),
      messageId: m.getId(), url: 'https://mail.google.com/mail/u/0/#inbox/' + t.getId() };
  });
  const res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(items),
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('GTD respondeu ' + res.getResponseCode() + ': ' + res.getContentText());
  threads.forEach(t => { t.addLabel(done); t.removeLabel(label); });
}
