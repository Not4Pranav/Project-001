import { parentPort } from 'node:worker_threads';

function isValidCodeFast(value) {
  const length = value.length;
  if (length < 16 || length > 64) return false;

  for (let index = 0; index < length; index += 1) {
    const code = value.charCodeAt(index);
    const isDigit = code >= 48 && code <= 57;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isDash = code === 45;
    const isUnderscore = code === 95;

    if (!(isDigit || isUpper || isLower || isDash || isUnderscore)) {
      return false;
    }
  }

  return true;
}

function stripWhitespace(value) {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const code = value.charCodeAt(index);
    const isWhitespace = code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
    if (!isWhitespace) output += char;
  }
  return output;
}

function sliceCodeTail(tail) {
  let end = tail.length;
  const question = tail.indexOf('?');
  const hash = tail.indexOf('#');
  if (question !== -1 && question < end) end = question;
  if (hash !== -1 && hash < end) end = hash;
  while (end > 0 && tail.charCodeAt(end - 1) === 47) end -= 1;
  return tail.slice(0, end);
}

function normalizeGiftEntry(rawInput) {
  const raw = String(rawInput ?? '').trim();
  if (!raw) {
    return { kind: 'empty' };
  }

  const compact = stripWhitespace(raw);
  if (isValidCodeFast(compact)) {
    return {
      kind: 'valid',
      normalized: `https://discord.gift/${compact}`,
    };
  }

  let probeLower = compact.toLowerCase();
  let probeOriginal = compact;

  if (probeLower.startsWith('https://')) {
    probeLower = probeLower.slice(8);
    probeOriginal = probeOriginal.slice(8);
  } else if (probeLower.startsWith('http://')) {
    probeLower = probeLower.slice(7);
    probeOriginal = probeOriginal.slice(7);
  }

  if (probeLower.startsWith('www.')) {
    probeLower = probeLower.slice(4);
    probeOriginal = probeOriginal.slice(4);
  }

  let tail = null;
  if (probeLower.startsWith('discord.gift/')) {
    tail = probeOriginal.slice('discord.gift/'.length);
  } else if (probeLower.startsWith('discord.com/gifts/')) {
    tail = probeOriginal.slice('discord.com/gifts/'.length);
  } else if (probeLower.startsWith('discordapp.com/gifts/')) {
    tail = probeOriginal.slice('discordapp.com/gifts/'.length);
  } else {
    return { kind: 'invalid', reason: 'Unsupported host', raw };
  }

  const code = sliceCodeTail(tail);
  if (!isValidCodeFast(code)) {
    return { kind: 'invalid', reason: 'Unsupported path or code shape', raw };
  }

  return {
    kind: 'valid',
    normalized: `https://discord.gift/${code}`,
  };
}

parentPort.on('message', (message) => {
  const rows = Array.isArray(message?.rows) ? message.rows : [];
  const valid = [];
  const invalid = [];

  for (const row of rows) {
    const result = normalizeGiftEntry(row);
    if (result.kind === 'valid') {
      valid.push(result.normalized);
    } else if (result.kind === 'invalid') {
      invalid.push(`${row}  ← ${result.reason}`);
    }
  }

  parentPort.postMessage({
    valid,
    invalid,
    processed: rows.length,
  });
});
