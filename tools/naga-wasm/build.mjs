// Build the vendored naga WASM artifact.
//
// Two steps: cargo compiles the crate to wasm32-unknown-unknown, then wasm-bindgen generates the JS
// glue. The bindgen CLI must match the wasm-bindgen crate version in Cargo.lock exactly; a mismatch is
// a hard error rather than a subtly broken binding, which is what we want.
//
// Output is committed under src/graphics/rhi/webgpu/naga/, so a normal `npm run build` needs no Rust.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const OUT = path.join(REPO, 'src', 'graphics', 'rhi', 'webgpu', 'naga');
const WASM = path.join(HERE, 'target', 'wasm32-unknown-unknown', 'release', 'cleo_naga_wasm.wasm');

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

// The bindgen CLI is not an npm dependency (it is a Rust binary), so allow an explicit path as well
// as PATH lookup. WASM_BINDGEN is what CI will set; a developer with it on PATH needs nothing.
const BINDGEN = process.env.WASM_BINDGEN || 'wasm-bindgen';

const lock = readFileSync(path.join(HERE, 'Cargo.lock'), 'utf-8');
const bindgenVersion = (lock.match(/name = "wasm-bindgen"\r?\nversion = "([^"]+)"/) || [])[1];
if (!bindgenVersion) throw new Error('could not read the wasm-bindgen version from Cargo.lock');

console.log('building cleo-naga-wasm (wasm-bindgen ' + bindgenVersion + ')');
run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'], HERE);

if (!existsSync(WASM)) throw new Error('cargo produced no wasm at ' + WASM);
mkdirSync(OUT, { recursive: true });

// Fail loudly on a CLI/crate mismatch rather than emitting glue that will not load.
const cliVersion = execFileSync(BINDGEN, ['--version'], { encoding: 'utf-8', shell: process.platform === 'win32' }).trim();
if (!cliVersion.includes(bindgenVersion))
    throw new Error(`wasm-bindgen CLI is "${cliVersion}" but Cargo.lock pins ${bindgenVersion}; install the matching CLI or set WASM_BINDGEN`);

run(BINDGEN, ['--target', 'web', '--out-dir', OUT, '--out-name', 'nagaGlsl', '--no-typescript', WASM], HERE);
console.log('vendored to ' + path.relative(REPO, OUT));
