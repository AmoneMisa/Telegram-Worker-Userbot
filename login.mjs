// Mint a Telegram MTProto session and store it in .env.
//
// You do not normally need this command: `npm start` runs the same flow by
// itself when it finds no usable session and it has a terminal to ask on. Use
// it when you want to log in ahead of time, on a different machine (the
// session string is portable), or to replace a session that is still valid:
//
//   npm run login             # log in if there is no session yet
//   npm run login -- --force  # log in again and replace the stored session
//
// It creates .env from sample.env if it is missing, asks for anything still
// blank (API id/hash from https://my.telegram.org -> API development tools),
// then prompts for phone number, login code and 2FA password. The result is
// written back into .env. That file grants full access to the account: keep it
// chmod 600 and never commit it.

import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadEnv, envFilePath, writeEnvVar } from './env.mjs';
import { interactiveLogin, canPrompt } from './session.mjs';

const force = process.argv.includes('--force');

const envFile = envFilePath();
if (!existsSync(envFile)) {
  const sample = fileURLToPath(new URL('sample.env', import.meta.url));
  if (existsSync(sample)) copyFileSync(sample, envFile);
  else writeFileSync(envFile, '');
  console.log('[login] created ' + envFile);
}
loadEnv();

if (!canPrompt()) {
  console.error(
    '[login] needs an interactive terminal (Telegram sends a one-time code).\n' +
      'Run it on your laptop and copy the resulting TG_SESSION line to the server,\n' +
      'or run it over an interactive ssh session.',
  );
  process.exit(1);
}

if (process.env.TG_SESSION && !force) {
  const rl = readline.createInterface({ input, output });
  const again = (await rl.question('[login] ' + envFile + ' already has a TG_SESSION. Replace it? [y/N] '))
    .trim()
    .toLowerCase();
  rl.close();
  if (again !== 'y' && again !== 'yes') {
    console.log('[login] nothing to do.');
    process.exit(0);
  }
}

const { apiId, apiHash, session } = await interactiveLogin({
  apiId: process.env.TG_API_ID,
  apiHash: process.env.TG_API_HASH,
  label: 'login',
});

writeEnvVar('TG_API_ID', String(apiId), envFile);
writeEnvVar('TG_API_HASH', apiHash, envFile);
writeEnvVar('TG_SESSION', session, envFile);

console.log('\nLogin OK. TG_SESSION written to ' + envFile + ' (chmod 600).');
console.log('Start the worker with: docker compose up -d');
console.log('Keep that file secret — anyone with the session has full account access.\n');
process.exit(0);
