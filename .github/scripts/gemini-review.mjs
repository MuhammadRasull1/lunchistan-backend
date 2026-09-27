// Автопроверка push бесплатным Gemini: читает изменённые файлы и оставляет
// комментарий к коммиту с подозрениями (file:line). Ничего не блокирует — всегда exit 0.
// Находки — гипотезы: перед правкой их проверяют по коду.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const { GEMINI_API_KEY: KEY, GITHUB_TOKEN, GITHUB_REPOSITORY: REPO, SHA, BEFORE } = process.env;
const MODELS = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.1-flash-lite'];
const CODE = /\.(js|mjs|cjs|ts|tsx|jsx|sql)$/i;
const SKIP = /(^|\/)(node_modules|dist|\.wrangler)\/|lock\.json$|\.min\.js$|(^|\/)\.env/i;

const BASE = BEFORE && !/^0+$/.test(BEFORE) ? BEFORE : `${SHA}~1`;
// execFileSync с массивом аргументов — имена файлов не проходят через shell
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
function changedFiles() {
  try { return git('diff', '--name-only', '--diff-filter=AM', BASE, SHA).split('\n'); } catch { return []; }
}

async function main() {
  if (!KEY) { console.log('GEMINI_API_KEY не задан — пропуск'); return; }
  const files = changedFiles().filter((f) => f && CODE.test(f) && !SKIP.test(f) && fs.existsSync(f));
  if (!files.length) { console.log('нет изменённого кода'); return; }
  const diff = git('diff', '-U0', BASE, SHA, '--', ...files).slice(0, 200_000);
  let code = '';
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    if (t.length > 150_000) continue;
    code += `\n===== ${f} =====\n` + t.split('\n').map((l, i) => `${i + 1}| ${l}`).join('\n');
    if (code.length > 700_000) break;
  }
  const prompt = `Ты — строгий ревьюер. Ниже изменения коммита (diff) и полные изменённые файлы с номерами строк.
Найди реальные баги, которые ВНЕСЕНЫ или ЗАТРОНУТЫ этими изменениями: неверная логика, гонки, даты/часовые пояса (прод в Asia/Tashkent), деньги, безопасность, необработанные ошибки.
Только конкретные дефекты с реальным сценарием, не стиль. Если ничего серьёзного — пустой массив.
Ответ — JSON-массив: [{"file":"путь","line":число,"severity":"critical|important|minor","summary":"суть по-русски","scenario":"как ломается"}]
--- DIFF ---
${diff}
--- ФАЙЛЫ ---
${code}`;
  for (const id of MODELS) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent?key=${KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }),
    }).catch(() => null);
    if (!res?.ok) { console.log(`${id}: HTTP ${res?.status ?? 'сеть'}`); continue; }
    const data = await res.json();
    let items;
    try { items = JSON.parse(data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '[]'); } catch { continue; }
    items = (Array.isArray(items) ? items : []).filter((x) => x.severity !== 'minor');
    console.log(`${id}: находок ${items.length}`);
    if (!items.length) return;
    const icon = { critical: '🔴', important: '🟠' };
    const body = `### 🤖 Автопроверка Gemini (${id})\n_Гипотезы — проверить по коду перед правкой._\n\n` +
      items.map((x) => `- ${icon[x.severity] ?? '⚪'} \`${x.file}:${x.line}\` — ${x.summary}\n  ↳ ${x.scenario}`).join('\n');
    const r = await fetch(`https://api.github.com/repos/${REPO}/commits/${SHA}/comments`, {
      method: 'POST', headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
      body: JSON.stringify({ body }),
    });
    console.log(body, `\nкомментарий: HTTP ${r.status}`);
    return;
  }
}
main().catch((e) => console.log('ошибка автопроверки:', e.message));
