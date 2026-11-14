/** Canonical definition and documentation for `write_document`. */
export const writeDocumentAction = {
  "id": "write_document",
  "canonical": {
    "operationId": "write_document",
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
    "title": "Write revisioned document",
    "description": "Create or update an active-task document with optimistic revision safety.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "write_document",
      "input": {
        "idempotencyKey": "example",
        "key": "example",
        "title": "example",
        "body": "example",
        "baseRevisionId": "example"
      }
    },
    "scenarioCall": {
      "operationId": "write_document",
      "idempotencyKey": "example",
      "input": {
        "key": "example",
        "title": "example",
        "body": "example",
        "baseRevisionId": "example"
      }
    },
    "success": {
      "ok": true,
      "operationId": "write_document",
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
    "order": 7,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "write_document",
      "version": 1,
      "title": "Write revisioned document",
      "description": "Create or update an active-task document with optimistic revision safety. Before named QA, the author selects all required same-task sources and may supply includeDocuments to embed their exact current revisions in this one document. Selection/completeness remain the author responsibility; byte verification is not QA or adoption.",
      "exposure": "always",
      "requiredClaims": [],
      "allowedModes": [
        "standard",
        "planning",
        "skill_test"
      ],
      "inputSchema": {
        "type": "object",
        "properties": {
          "idempotencyKey": {
            "type": "string",
            "description": "Caller-stable retry key.",
            "minLength": 1,
            "maxLength": 240
          },
          "key": {
            "type": "string",
            "description": "Stable issue-document key.",
            "minLength": 1,
            "maxLength": 120
          },
          "title": {
            "type": "string",
            "description": "Document title.",
            "minLength": 1,
            "maxLength": 300
          },
          "body": {
            "type": "string",
            "description": "Markdown document body.",
            "minLength": 1,
            "maxLength": 200000
          },
          "baseRevisionId": {
            "type": [
              "string",
              "null"
            ],
            "description": "Current revision id, or null when creating.",
            "maxLength": 20000
          },
          "changeSummary": {
            "type": [
              "string",
              "null"
            ],
            "description": "Optional revision summary.",
            "maxLength": 20000
          },
          "includeDocuments": {
            "description": "Author-selected same-company, same-task current documents. Obtain fixed IDs and UTF-8 digest from read_document.readReceipt; do not estimate or hash redacted display text. The composed document is limited to 200000 UTF-8 bytes including metadata. Omit to preserve ordinary writes.",
            "items": {
              "additionalProperties": false,
              "properties": {
                "bodyBytes": {
                  "maximum": 200000,
                  "minimum": 0,
                  "type": "integer"
                },
                "bodySha256": {
                  "pattern": "^[a-f0-9]{64}$",
                  "type": "string"
                },
                "documentId": {
                  "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
                  "type": "string"
                },
                "key": {
                  "pattern": "^[a-z0-9][a-z0-9_-]{0,63}$",
                  "type": "string"
                },
                "revisionId": {
                  "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
                  "type": "string"
                }
              },
              "required": [
                "documentId",
                "key",
                "revisionId",
                "bodyBytes",
                "bodySha256"
              ],
              "type": "object"
            },
            "maxItems": 20,
            "minItems": 1,
            "type": "array"
          }
        },
        "required": [
          "idempotencyKey",
          "key",
          "title",
          "body",
          "baseRevisionId"
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
    "order": 10,
    "successExample": {
      "schema": "paperclip.capability.tool-result.v1",
      "ok": true,
      "operationId": "write_document",
      "operationResultId": "example-result",
      "value": {
        "commandId": "example",
        "disposition": "applied",
        "stateRevision": 1,
        "entityRefs": [
          "example"
        ],
        "scheduledWakeIds": [
          "example"
        ]
      },
      "commandResult": null,
      "authorization": {}
    },
    "descriptor": {
      "operationId": "write_document",
      "version": 1,
      "title": "Write task document",
      "description": "Create or revision-safely update an active-task document.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string",
            "minLength": 1
          },
          "title": {
            "type": "string",
            "minLength": 1
          },
          "body": {
            "type": "string"
          },
          "baseRevisionId": {
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
          "changeSummary": {
            "type": "string"
          }
        },
        "required": [
          "key",
          "title",
          "body",
          "baseRevisionId"
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
        "skill_test"
      ],
      "sideEffectClass": "task_write",
      "idempotency": "required",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "semantic_command",
        "commandKind": "write_document"
      }
    }
  }
} as const;
