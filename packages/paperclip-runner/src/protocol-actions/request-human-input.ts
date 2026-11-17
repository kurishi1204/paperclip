import { questionPayloadSchema, questionsPayloadRequirement } from "./question-payload-schema.js";

// Withdrawal is a lifecycle of the existing request, not a second tool or a
// generic API escape hatch. The live server rechecks its creator and version.
export const requestHumanInputWithdrawalFields = {
  operation: { enum: ["create", "withdraw"], description: "Omit or use create for a new request. Use withdraw only for your own pending named business-document confirmation on this task; it never answers or reassigns it." },
  interactionId: { type: "string", minLength: 1, maxLength: 240 },
  reason: { type: "string", minLength: 1, maxLength: 4000 },
} as const;

export const requestHumanInputOperationRequirements = [
  { properties: { operation: { enum: ["withdraw"] } }, required: ["operation", "interactionId", "reason", "payload"] },
  { properties: { operation: { enum: ["create"] } }, required: ["interactionKind", "title", "prompt", "continuationPolicy"] },
] as const;

/** Canonical definition and documentation for `request_human_input`. */
export const requestHumanInputAction = {
  "id": "request_human_input",
  "canonical": {
    "operationId": "request_human_input",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "always_agent_tool",
    "optionalGroup": null,
    "requiredClaims": [],
    "taskModes": [
      "standard",
      "planning",
      "ask",
      "skill_test"
    ],
    "sideEffectClass": "task_write",
    "idempotency": "required",
    "disabledByDefault": false,
    "realBindingStatus": "live_codex",
    "realServiceBinding": "unbound",
    "prpEvidence": "semantic-operation item event plus active-task state diff, work-assessment, and issue-status-decision events",
    "prpBindingStatus": "audit_pending",
    "legacyAliases": []
  },
  "documentation": {
    "title": "Request structured human input",
    "description": "Create a durable human question or approval card on the current Paperclip task bound to this run; Paperclip renders it and authenticates the response. Keep prompt within 1000 UTF-16 code units (JavaScript string length). For long QA material, save the complete text as a task document and ask a short decision question bound to its exact documentId/key/revisionId in payload.target; do not silently truncate the material or create a duplicate card. Use questions with continuationPolicy='wake_assignee' when an answer is needed, including otherwise tool-free chat turns. Supply a stable idempotencyKey and reuse it on retries. For one question at a time, ask only the next unanswered question and wait for its real answer. Never fabricate answers or treat ambiguous clarification as approval. For an ordinary confirmation or checkbox card, record a clear user chat answer with call_api POST /api/issues/{id}/interactions/{interactionId}/resolve-from-comment, using the source commentId and decision (accept/reject), plus explicit selectedOptionIds for checkbox acceptance. Existing resolver permissions still apply; governed tool, secret, and connection approvals are excluded. Question forms retain their dedicated answer workflow. Preserve existing review gates. Call this tool before claiming a question was asked; if creation fails, report the failure. Do not fabricate answer links or Markdown buttons, post duplicate cards, or use call_api to create the card. For independent QA of a saved business document on this standard-mode task (never the reserved plan document), set addresseeAgentId to another existing employee and use a confirmation with payload.target.type=issue_document and the exact documentId/key/revisionId. This never changes resolver permissions or permits agent resolution of human_only decisions.  In the live server, operation='withdraw' withdraws only your own pending named standard-mode business-document confirmation on this task. Supply interactionId, reason, payload.target with the unchanged issueId/documentId/key/revisionId, and idempotencyKey; omit create-only fields. It never answers a human-only decision, changes an addressee, clears quarantine, or creates a replacement review. Inspect cancelled status with result.outcome='withdrawn' before any separately authorized re-nomination. Do not resend an unknown effect; read its original interaction and receipt. Use one complete payload.questionSet for text and choice questions. Paperclip generates compatibility questions; see the payload schema for formats.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "request_human_input",
      "input": {
        "idempotencyKey": "example",
        "interactionKind": "confirmation",
        "title": "example",
        "prompt": "example",
        "continuationPolicy": "none"
      }
    },
    "scenarioCall": {
      "operationId": "request_human_input",
      "idempotencyKey": "example",
      "input": {
        "interactionKind": "confirmation",
        "title": "example",
        "prompt": "example",
        "continuationPolicy": "none"
      }
    },
    "success": {
      "ok": true,
      "operationId": "request_human_input",
      "result": {
        "commandId": "example",
        "disposition": "applied",
        "stateRevision": 1,
        "entityRefs": [
          "example"
        ],
        "scheduledWakeIds": [
          "example"
        ]
      }
    }
  },
  "live": {
    "order": 8,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "request_human_input",
      "version": 1,
      "title": "Request structured human input",
      "description": "Create a durable human question or approval card on the current Paperclip task bound to this run; Paperclip renders it and authenticates the response. Keep prompt within 1000 UTF-16 code units (JavaScript string length). For long QA material, save the complete text as a task document and ask a short decision question bound to its exact documentId/key/revisionId in payload.target; do not silently truncate the material or create a duplicate card. Use questions with continuationPolicy='wake_assignee' when an answer is needed, including otherwise tool-free chat turns. Supply a stable idempotencyKey and reuse it on retries. For one question at a time, ask only the next unanswered question and wait for its real answer. Never fabricate answers or treat ambiguous clarification as approval. For an ordinary confirmation or checkbox card, record a clear user chat answer with call_api POST /api/issues/{id}/interactions/{interactionId}/resolve-from-comment, using the source commentId and decision (accept/reject), plus explicit selectedOptionIds for checkbox acceptance. Existing resolver permissions still apply; governed tool, secret, and connection approvals are excluded. Question forms retain their dedicated answer workflow. Preserve existing review gates. Call this tool before claiming a question was asked; if creation fails, report the failure. Do not fabricate answer links or Markdown buttons, post duplicate cards, or use call_api to create the card. For independent QA of a saved business document on this standard-mode task (never the reserved plan document), set addresseeAgentId to another existing employee and use a confirmation with payload.target.type=issue_document and the exact documentId/key/revisionId. This never changes resolver permissions or permits agent resolution of human_only decisions.  In the live server, operation='withdraw' withdraws only your own pending named standard-mode business-document confirmation on this task. Supply interactionId, reason, payload.target with the unchanged issueId/documentId/key/revisionId, and idempotencyKey; omit create-only fields. It never answers a human-only decision, changes an addressee, clears quarantine, or creates a replacement review. Inspect cancelled status with result.outcome='withdrawn' before any separately authorized re-nomination. Do not resend an unknown effect; read its original interaction and receipt. Use one complete payload.questionSet for text and choice questions. Paperclip generates compatibility questions; see the payload schema for formats.",
      "exposure": "always",
      "requiredClaims": [],
      "allowedModes": [
        "standard",
        "planning",
        "ask",
        "skill_test"
      ],
      "inputSchema": {
        "allOf": [questionsPayloadRequirement],
        "anyOf": requestHumanInputOperationRequirements,
        "type": "object",
        "properties": {
          ...requestHumanInputWithdrawalFields,
          "idempotencyKey": {
            "type": "string",
            "description": "Caller-stable retry key.",
            "minLength": 1,
            "maxLength": 240
          },
          "interactionKind": {
            "enum": [
              "confirmation",
              "checkbox",
              "questions",
              "suggest_tasks",
              "item_verdicts"
            ]
          },
          "title": {
            "type": "string",
            "description": "Interaction card title.",
            "minLength": 1,
            "maxLength": 300
          },
          "prompt": {
            "type": "string",
            "description": "Short question or decision prompt, at most 1000 UTF-16 code units. Put long QA material in a saved task document and bind its exact revision in payload.target.",
            "minLength": 1,
            "maxLength": 1000
          },
          "payload": questionPayloadSchema,
          "addresseeAgentId": {
            "type": ["string", "null"],
            "description": "Optional existing independent employee for a fixed standard-mode business document confirmation only; never key plan. Omit for human questions and approvals.",
            "maxLength": 240
          },
          "targetRevisionId": {
            "type": [
              "string",
              "null"
            ],
            "description": "Optional bound document revision.",
            "maxLength": 20000
          },
          "continuationPolicy": {
            "enum": [
              "none",
              "wake_assignee",
              "wake_assignee_on_accept"
            ]
          }
        },
        "required": [
          "idempotencyKey"
        ],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "commandId": {
            "type": "string",
            "description": "Stable command identifier.",
            "minLength": 1,
            "maxLength": 200
          },
          "disposition": {
            "enum": [
              "applied",
              "duplicate"
            ]
          },
          "stateRevision": {
            "type": "integer",
            "minimum": 0
          },
          "entityRefs": {
            "type": "array",
            "description": "Entities affected by the operation.",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "maxItems": 200,
            "uniqueItems": true
          },
          "scheduledWakeIds": {
            "type": "array",
            "description": "Wake identifiers scheduled by the operation.",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "maxItems": 200,
            "uniqueItems": true
          }
        },
        "required": [
          "commandId",
          "disposition",
          "stateRevision",
          "entityRefs",
          "scheduledWakeIds"
        ],
        "additionalProperties": false
      }
    }
  },
  "scenario": {
    "order": 11,
    "successExample": {
      "schema": "paperclip.capability.tool-result.v1",
      "ok": true,
      "operationId": "request_human_input",
      "operationResultId": "example-result",
      "value": {
        "commandId": "example",
        "disposition": "applied",
        "stateRevision": 1,
        "entityRefs": ["example"],
        "scheduledWakeIds": ["example"]
      },
      "commandResult": null,
      "authorization": {}
    },
    "descriptor": {
      "operationId": "request_human_input",
      "version": 1,
      "title": "Request human input",
      "description": "Create a typed confirmation, checkbox, question, task suggestion, or item-verdict request. Keep prompt within 1000 UTF-16 code units; bind long QA material to a saved task document revision instead of truncating it.",
      "inputSchema": {
        "allOf": [questionsPayloadRequirement],
        "type": "object",
        "properties": {
          "interactionKind": {
            "type": "string",
            "enum": [
              "confirmation",
              "checkbox",
              "questions",
              "suggest_tasks",
              "item_verdicts"
            ]
          },
          "title": {
            "type": "string",
            "minLength": 1
          },
          "prompt": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1000
          },
          "payload": questionPayloadSchema,
          "addresseeAgentId": {
            "type": ["string", "null"],
            "description": "Optional existing independent employee for a fixed standard-mode business document confirmation only; never key plan. Omit for human questions and approvals.",
            "maxLength": 240
          },
          "targetRevisionId": {
            "oneOf": [
              {
                "type": "string",
                "minLength": 1
              },
              {
                "type": "null"
              }
            ]
          },
          "continuationPolicy": {
            "type": "string",
            "enum": [
              "none",
              "wake_assignee",
              "wake_assignee_on_accept"
            ]
          }
        },
        "required": [
          "interactionKind",
          "title",
          "prompt",
          "continuationPolicy"
        ],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "schema": {
            "type": "string",
            "enum": [
              "paperclip.capability.tool-result.v1"
            ]
          },
          "ok": {
            "type": "boolean"
          },
          "operationId": {
            "type": "string",
            "minLength": 1
          },
          "operationResultId": {
            "type": "string",
            "minLength": 1
          },
          "value": {},
          "commandResult": {},
          "authorization": {}
        },
        "required": [
          "schema",
          "ok",
          "operationId",
          "operationResultId",
          "value",
          "commandResult",
          "authorization"
        ],
        "additionalProperties": false
      },
      "disposition": "always_agent_tool",
      "optionalGroup": null,
      "requiredClaims": [],
      "taskModes": [
        "standard",
        "planning",
        "ask",
        "skill_test"
      ],
      "sideEffectClass": "task_write",
      "idempotency": "required",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "semantic_command",
        "commandKind": "request_human_input"
      }
    }
  }
} as const;
