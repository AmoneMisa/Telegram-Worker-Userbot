// One-time interactive login to mint a Telegram MTProto session string.
//
// Run this LOCALLY (not in Docker) once:
//
//   cd telegram-worker
//   npm install
//   TG_API_ID=32449959 TG_API_HASH=99dafc161f779c0c275811ecc33d18c0 npm run login
//
// It prompts for your phone number, the SMS/Telegram login code, and your
// 2FA password if you have one, then prints a session string. Paste that into
// flatfinder.env as TG_SESSION=... — it grants full account access, so treat it
// as a secret and never commit it.

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

if (!apiId || !apiHash) {
  console.error('Set TG_API_ID and TG_API_HASH before running (see the header of this file).');
  process.exit(1);
}

const rl = readline.createInterface({ input, output });
const ask = (q) => rl.question(q);

const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
  connectionRetries: 5,
});

await client.start({
  phoneNumber: () => ask('Phone number (with country code, e.g. +998...): '),
  password: () => ask('2FA password (leave blank if none): '),
  phoneCode: () => ask('Login code Telegram just sent you: '),
  onError: (err) => console.error(err),
});

console.log('\n\nLogin OK. Your session string (add to flatfinder.env as TG_SESSION):\n');
console.log(client.session.save());
console.log('\nKeep this secret. Anyone with it has full access to the account.\n');

await client.disconnect();
rl.close();
process.exit(0);
