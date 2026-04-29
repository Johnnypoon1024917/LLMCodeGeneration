// src/agents/tools/index.ts
//
// Barrel file. Importing this triggers each tool module's
// `registerTool()` call at module load. Order doesn't matter — the
// registry is a Map, so tools may be loaded in any sequence.
//
// To add a new tool: create the .ts file, call registerTool() at the
// bottom, and add an import line here. That's the entire integration
// path.

import './read_file';
import './list_directory';
import './search_codebase';
import './write_file';
import './edit_file';
import './bash_exec';
import './run_tests';
import './install_package';
import './git_commit';
import './web_fetch';

// Re-export the registry public API for convenience. Most callers
// will import from 'src/agents/toolRegistry' directly; this barrel
// is mainly for the side effect of registering all tools.
export {
    dispatchTool,
    getAllToolDefinitions,
    getToolDefinitions,
    type ToolExecutionContext,
    type ToolExecutor
} from '../toolRegistry';