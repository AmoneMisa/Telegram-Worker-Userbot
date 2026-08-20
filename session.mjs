// Session lifecycle: minting one, spotting a dead one, keeping a live one fresh.
//
// Shared by `npm start` and `npm run login` so both take exactly the same path
// — the worker can log in on its own, without a second command, whenever it is
// started from a terminal.
//
// The hard limit: Telegram mints a session only against a one-time code it
// sends to the account, and there is no way to read that code without an
// already-valid session. So the code prompt is the one step no amount of
// automation removes; everything around it is automatic.

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

// Telegram's way of saying "this session is no longer valid" — revoked from
// the Devices list, account deactivated, auth key dropped server-side. None of
// these are retryable: they need a fresh login, not a reconnect.
const DEAD_SESSION =
  /AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|AUTH_KEY_PERM_EMPTY|AUTH_KEY_DUPLICATED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/i;

export function isDeadSession(err) {
  const msg = err?.errorMessage || err?.message || String(err ?? '');
  return DEAD_SESSION.test(msg);
}

export function canPrompt() {
  return Boolean(input.isTTY);
}

// Ask for whatever is still missing, then run the interactive login. Returns
// { apiId, apiHash, session }; the caller decides where to persist it.
export async function interactiveLogin({ apiId, apiHash, label = 'login' } = {}) {
  if (!canPrompt()) {
    throw new Error(
      'interactive login needs a terminal (Telegram sends a one-time code). ' +
        'Run `npm run login` over an interactive ssh session, or on your laptop ' +
        'and copy the TG_SESSION line over — the session string is portable.',
    );
  }

  const rl = readline.createInterface({ input, output });

  // If the terminal goes away mid-login (Ctrl-D, a dropped ssh session), the
  // pending question promise simply never settles and node exits silently with
  // code 13. Race every prompt against the close event so it surfaces as an
  // error we can report.
  const CLOSED = Symbol('closed');
  const closed = new Promise((resolve) => rl.once('close', () => resolve(CLOSED)));
  const ask = async (q) => {
    const answer = await Promise.race([rl.question(q), closed]);
    if (answer === CLOSED) throw new Error('input closed before the login finished');
    return answer;
  };

  const askRequired = async (q, current) => {
    if (current) return current;
    let answer = '';
    while (!answer) answer = (await ask(q)).trim();
    return answer;
  };

  try {
    if (!apiId || !apiHash) {
      console.log('\nAPI credentials — https://my.telegram.org -> API development tools\n');
    }
    const apiIdRaw = await askRequired('TG_API_ID: ', apiId);
    const hash = await askRequired('TG_API_HASH: ', apiHash);
    const id = Number(apiIdRaw);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error('TG_API_ID must be a number, got: ' + apiIdRaw);
    }

    const client = new TelegramClient(new StringSession(''), id, hash, {
      connectionRetries: 5,
    });

    await client.start({
      phoneNumber: () => ask('Phone number (with country code, e.g. +998...): '),
      password: () => ask('2FA password (leave blank if none): '),
      phoneCode: () => ask('Login code Telegram just sent you: '),
      onError: (err) => console.error('[' + label + '] ' + (err?.message ?? err)),
    });

    const session = client.session.save();
    await client.disconnect();
    return { apiId: id, apiHash: hash, session };
  } finally {
    rl.close();
  }
}
