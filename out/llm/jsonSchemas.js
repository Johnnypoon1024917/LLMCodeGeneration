"use strict";
// src/llm/jsonSchemas.ts
//
// JSON schemas describing the shapes returned by every JSON-mode LLM call.
//
// These schemas are sent to the LLM via `response_format: { type: "json_schema" }`
// on endpoints that support it (vLLM 0.6+, recent LM Studio, OpenAI). The
// endpoint constrains decode-time output so the JSON literally cannot come
// back malformed. On older endpoints we fall back to `json_object` mode plus
// the legacy healer (see jsonRequest.ts).
//
// IMPORTANT: schemas use `additionalProperties: false` to prevent models from
// adding stray fields. If you need to add a field, add it here too.
Object.defineProperty(exports, "__esModule", { value: true });
exports.mctsApproachesSchema = exports.securityDecisionSchema = exports.completenessReviewSchema = exports.livingPrdUpdateSchema = exports.verificationSchema = exports.healErrorSchema = exports.atomicEditsSchema = exports.testSetupSchema = exports.targetFileSchema = exports.tasksPlanSchema = exports.planEnvelopeSchema = exports.aiPlanSchema = exports.requirementPlanSchema = exports.intentSchema = void 0;
// ─── User-facing intent classification ──────────────────────────────────
exports.intentSchema = {
    name: "intent",
    strict: true,
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            intent: {
                type: "string",
                enum: ["build", "explain", "ask", "explore"]
            }
        },
        required: ["intent"]
    }
};
// ─── Requirements (PRD generation) ──────────────────────────────────────
const userStorySchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        epic: { type: "string" },
        story: { type: "string" },
        acceptanceCriteria: { type: "array", items: { type: "string" } },
        edgeCases: { type: "array", items: { type: "string" } }
    },
    required: ["epic", "story", "acceptanceCriteria", "edgeCases"]
};
exports.requirementPlanSchema = {
    name: "requirement_plan",
    strict: true,
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            projectName: { type: "string" },
            domain: { type: "string" },
            targetAudience: { type: "string" },
            userStories: { type: "array", items: userStorySchema },
            successMetrics: { type: "array", items: { type: "string" } },
            outOfScope: { type: "array", items: { type: "string" } }
        },
        required: ["projectName", "domain", "targetAudience", "userStories", "successMetrics", "outOfScope"]
    }
};
// ─── AI Plan (task list) ────────────────────────────────────────────────
const implementationTaskSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        id: { type: "string" },
        description: { type: "string" },
        targetFile: { type: "string" },
        dependsOn: { type: "string" },
        relatesTo: { type: "string" },
        instructions: { type: "string" }
    },
    required: ["id", "description"]
};
exports.aiPlanSchema = {
    name: "ai_plan",
    strict: false, // plans are lenient because models add fields like 'priority' organically
    schema: {
        type: "object",
        properties: {
            explanation: { type: "string" },
            implementationTasks: { type: "array", items: implementationTaskSchema }
        },
        required: ["implementationTasks"]
    }
};
// generatePlan returns an envelope around the plan
exports.planEnvelopeSchema = {
    name: "plan_envelope",
    strict: false,
    schema: {
        type: "object",
        properties: {
            explanation: { type: "string" },
            plan: exports.aiPlanSchema.schema
        },
        required: ["explanation", "plan"]
    }
};
// ─── Master Implementation Plan (generateTasks) ─────────────────────────
//
// Shape returned by `generateTasks` in llmService.ts. This is a different
// shape from `aiPlanSchema` above — it carries the full ProjectTask shape
// the webview renders in the Master Implementation Plan card (App.tsx
// reads taskObj.step, taskObj.file, taskObj.detailedInstructions, etc.)
//
// Why a separate schema rather than reusing implementationTaskSchema:
//   - implementationTaskSchema uses field names `description / targetFile /
//     instructions / dependsOn` for the legacy generatePlan flow.
//   - generateTasks uses the richer ProjectTask shape with `step / file /
//     detailedInstructions / dependencies / verificationRules / testStrategy
//     / relatedRequirement`.
//   - These cannot be merged without breaking either flow.
//
// strict: false because models occasionally add fields like `priority` or
// `estimate` organically; we tolerate them rather than forcing a rejection.
const projectTaskSchema = {
    type: "object",
    properties: {
        step: { type: "string" },
        file: { type: "string" },
        detailedInstructions: { type: "string" },
        relatedRequirement: { type: "string" },
        dependencies: { type: "array", items: { type: "string" } },
        verificationRules: { type: "array", items: { type: "string" } },
        testStrategy: { type: "string" },
        // V2.1.3: optional task-kind discriminator. Default is 'code'
        // (existing CoderAgent dispatch). 'scaffold-template' triggers
        // applyTemplate; 'scaffold-llm' triggers Coder with scaffolding
        // prompt. Optional + enum so the model can omit it for code
        // tasks and pick from a closed set for scaffold tasks.
        kind: { type: "string", enum: ["code", "scaffold-template", "scaffold-llm"] },
        // V2.1.3: only meaningful when kind === 'scaffold-template'.
        // Identifies which shipped template to apply.
        templateId: { type: "string" }
    },
    required: ["step", "file", "detailedInstructions"]
};
exports.tasksPlanSchema = {
    name: "tasks_plan",
    strict: false,
    schema: {
        type: "object",
        properties: {
            folderStructure: {
                type: "array",
                items: { type: "string" }
            },
            implementationTasks: {
                type: "array",
                items: projectTaskSchema
            }
        },
        required: ["folderStructure", "implementationTasks"]
    }
};
// ─── Target file inference ──────────────────────────────────────────────
exports.targetFileSchema = {
    name: "target_file",
    strict: true,
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            filepath: { type: "string" },
            reasoning: { type: "string" }
        },
        required: ["filepath", "reasoning"]
    }
};
// ─── Test setup plan ────────────────────────────────────────────────────
exports.testSetupSchema = {
    name: "test_setup",
    strict: false, // setupCommands shape varies across language ecosystems
    schema: {
        type: "object",
        properties: {
            language: { type: "string" },
            framework: { type: "string" },
            testFilePath: { type: "string" },
            testCode: { type: "string" },
            setupCommands: { type: "array", items: { type: "string" } }
        },
        required: ["language", "testFilePath", "testCode"]
    }
};
// ─── Atomic edits ───────────────────────────────────────────────────────
const atomicEditSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        filepath: { type: "string" },
        action: { type: "string", enum: ["replace", "insert_before", "append"] },
        code: { type: "string" },
        targetLine: { type: "string" }
    },
    required: ["filepath", "action", "code"]
};
exports.atomicEditsSchema = {
    name: "atomic_edits",
    strict: false,
    schema: {
        type: "object",
        properties: {
            edits: {
                type: "array",
                items: atomicEditSchema
            }
        },
        required: ["edits"]
    }
};
// ─── Heal-error result (single-file fix) ────────────────────────────────
exports.healErrorSchema = {
    name: "heal_error",
    strict: true,
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            filepath: { type: "string" },
            code: { type: "string" }
        },
        required: ["filepath", "code"]
    }
};
// ─── Verification result ────────────────────────────────────────────────
exports.verificationSchema = {
    name: "verification",
    strict: true,
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            verified: { type: "boolean" },
            reasoning: { type: "string" }
        },
        required: ["verified", "reasoning"]
    }
};
// ─── Living-PRD update (text replacements) ──────────────────────────────
exports.livingPrdUpdateSchema = {
    name: "living_prd_update",
    strict: true,
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            replacements: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        original: { type: "string" },
                        updated: { type: "string" }
                    },
                    required: ["original", "updated"]
                }
            }
        },
        required: ["replacements"]
    }
};
// ─── Code completeness review ───────────────────────────────────────────
exports.completenessReviewSchema = {
    name: "completeness_review",
    strict: true,
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            isComplete: { type: "boolean" },
            critique: { type: "string" }
        },
        required: ["isComplete", "critique"]
    }
};
// ─── Security monitor decision ──────────────────────────────────────────
exports.securityDecisionSchema = {
    name: "security_decision",
    strict: true,
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            allowed: { type: "boolean" },
            reason: { type: "string" }
        },
        required: ["allowed", "reason"]
    }
};
// ─── MCTS approach generation ───────────────────────────────────────────
exports.mctsApproachesSchema = {
    name: "mcts_approaches",
    strict: true,
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            approaches: { type: "array", items: { type: "string" } }
        },
        required: ["approaches"]
    }
};
//# sourceMappingURL=jsonSchemas.js.map