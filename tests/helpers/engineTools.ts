// The editor's tools the full engine (src/cleo.ts) installs into the runtime, installed for every test
// file, including the ones that import an engine module directly rather than the barrel: a test that
// compiles a script reaches scriptRuntime alone, which compiles no source until a transpiler is installed.
import { setScriptTranspiler } from '../../src/core/scripting/scriptRuntime';
import { sucraseTranspiler } from '../../src/core/scripting/sucraseTranspiler';

setScriptTranspiler(sucraseTranspiler);
