/**
 * scripts/get-tokens.js
 * Run locally ONCE to get your refresh_token via CLI.
 *
 * Usage:
 *   1. Create a .env.local with GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
 *   2. Run: node scripts/get-tokens.js
 *   3. Copy the URL shown, open in browser, authorize
 *   4. Paste the code from the redirect URL here
 *   5. Copy the refresh_token and save it in Vercel env vars
 *
 * Requires: npm install googleapis dotenv
 */

require('dotenv').config({ path: '.env.local' });
const { google }   = require('googleapis');
const readline     = require('readline');

const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/business.manage',
];

const auth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'   // out-of-band (no redirect server needed)
);

const url = auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

console.log('\n🔐 Abre este URL en tu navegador:\n');
console.log(url);
console.log('\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('📋 Pega el código aquí: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await auth.getToken(code.trim());
    console.log('\n✅ ¡Tokens obtenidos!\n');
    console.log('GOOGLE_REFRESH_TOKEN:', tokens.refresh_token);
    console.log('\nGuarda este valor en Vercel → Settings → Environment Variables\n');

    // Also list GMB locations
    auth.setCredentials(tokens);
    try {
      const hdrs = { Authorization: `Bearer ${tokens.access_token}` };
      const acctRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', { headers: hdrs });
      const accounts = await acctRes.json();
      if (accounts.accounts?.length) {
        const acct = accounts.accounts[0];
        console.log('GMB Account:', acct.name, `(${acct.accountName})`);
        const locRes = await fetch(
          `https://mybusinessbusinessinformation.googleapis.com/v1/${acct.name}/locations?readMask=name,title`,
          { headers: hdrs }
        );
        const locs = await locRes.json();
        if (locs.locations?.length) {
          console.log('\nGMB Locations:');
          locs.locations.forEach(l => console.log(`  GMB_LOCATION_NAME=${l.name}  (${l.title})`));
          console.log('\nCopia el valor correcto como GMB_LOCATION_NAME en Vercel.\n');
        }
      }
    } catch (e) {
      console.log('(No se pudieron listar las ubicaciones GMB automáticamente)');
    }

  } catch (err) {
    console.error('Error:', err.message);
  }
});
