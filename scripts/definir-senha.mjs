// Define (ou redefine) a senha de acesso à interface. Rode no computador onde o GTD está instalado:
//   npm run senha
// Encerra todas as sessões abertas. O e-mail do dono fica em data/config.json (owner_email).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../server/auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(process.env.GTD_DATA || path.join(ROOT, 'data'), 'config.json');
if (!existsSync(file)) { console.error(`Não encontrei ${file}. Rode "npm start" uma vez antes.`); process.exit(1); }
const cfg = JSON.parse(readFileSync(file, 'utf8'));

function ask(question, { hidden = false } = {}) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => { if (s.includes(question)) rl.output.write(s); else if (!/^\r?\n$/.test(s)) rl.output.write('*'); else rl.output.write(s); };
    rl.question(question, a => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}

const email = (await ask(`E-mail do dono [${cfg.owner_email || 'nenhum'}]: `)).trim().toLowerCase() || cfg.owner_email;
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('E-mail inválido.'); process.exit(1); }
const p1 = await ask('Nova senha (mín. 10 caracteres): ', { hidden: true });
if (p1.length < 10) { console.error('A senha precisa ter pelo menos 10 caracteres.'); process.exit(1); }
const p2 = await ask('Repita a senha: ', { hidden: true });
if (p1 !== p2) { console.error('As duas senhas não são iguais.'); process.exit(1); }
cfg.owner_email = email;
cfg.password_hash = hashPassword(p1);
cfg.session_version = (cfg.session_version || 1) + 1;
writeFileSync(file, JSON.stringify(cfg, null, 2));
console.log(`Senha definida para ${email}. As sessões abertas foram encerradas; reinicie o servidor se ele estiver rodando.`);
