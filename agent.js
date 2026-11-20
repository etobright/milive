export function advance(call, reply) {
  if (call.stage === 'end' || !reply.trim()) return call;
  let stage = call.stage;
  let followUp = call.followUp;
  let text;
  const answer = reply.toLowerCase().replace(/[’‘]/g, "'").normalize('NFD').replace(/\p{Diacritic}/gu, '');
  if (/\b(ne me rappelez (plus|pas)|ne (plus|pas) me rappeler|ne (plus|pas) etre rappele[e]?|arretez|pas interesse[e]?|ne souhaite pas etre rappele[e]?)\b/.test(answer)) {
    stage = 'end';
    followUp = false;
    text = 'Je prends note de votre souhait de ne pas être rappelé. Merci et bonne journée.';
  } else if (stage === 'consent') {
    if (/^\s*(oui\b|j'accepte\b|d'accord\b)/.test(answer) && !/\b(non|pas|refuse)\b/.test(answer)) {
      stage = 'need';
      text = 'Merci. Pouvez-vous préciser votre besoin en quelques mots ? Évitez de communiquer des informations personnelles ou confidentielles.';
    } else {
      stage = 'end';
      text = 'Je mets fin à cet appel. Merci et bonne journée.';
    }
    return { ...call, stage, messages: [...call.messages, { role: 'agent', text }] };
  } else if (stage === 'need') {
    stage = 'callback';
    text = 'Merci pour ces précisions. À quel moment un conseiller pourrait-il vous rappeler ?';
  } else {
    stage = 'end';
    text = 'Merci. Votre demande et vos disponibilités seront consignées pour le suivi. Bonne journée.';
  }
  return { ...call, stage, followUp, messages: [...call.messages, { role: 'client', text: reply.trim(), stage: call.stage }, { role: 'agent', text }] };
}

export function summarize(call) {
  return {
    need: call.messages.find(message => message.stage === 'need')?.text || '',
    callback: call.followUp ? call.messages.find(message => message.stage === 'callback')?.text || '' : '',
  };
}
