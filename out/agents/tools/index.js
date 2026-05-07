"use strict";
// src/agents/tools/index.ts
//
// Barrel file. Importing this triggers each tool module's
// `registerTool()` call at module load. Order doesn't matter — the
// registry is a Map, so tools may be loaded in any sequence.
//
// To add a new tool: create the .ts file, call registerTool() at the
// bottom, and add an import line here. That's the entire integration
// path.
Object.defineProperty(exports, "__esModule", { value: true });
exports.getToolDefinitions = exports.getAllToolDefinitions = exports.dispatchTool = void 0;
require("./read_file");
require("./list_directory");
require("./search_codebase");
require("./write_file");
require("./edit_file");
require("./bash_exec");
require("./run_tests");
require("./install_package");
require("./git_commit");
require("./web_fetch");
// Re-export the registry public API for convenience. Most callers
// will import from 'src/agents/toolRegistry' directly; this barrel
// is mainly for the side effect of registering all tools.
var toolRegistry_1 = require("../toolRegistry");
Object.defineProperty(exports, "dispatchTool", { enumerable: true, get: function () { return toolRegistry_1.dispatchTool; } });
Object.defineProperty(exports, "getAllToolDefinitions", { enumerable: true, get: function () { return toolRegistry_1.getAllToolDefinitions; } });
Object.defineProperty(exports, "getToolDefinitions", { enumerable: true, get: function () { return toolRegistry_1.getToolDefinitions; } });
//# sourceMappingURL=index.js.map