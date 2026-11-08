/** Canonical definition and documentation for `list_document_revisions`. */
export const listDocumentRevisionsAction = {
  "id": "list_document_revisions",
  "canonical": {
    "operationId": "list_document_revisions",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "always_agent_tool",
    "optionalGroup": null,
    "requiredClaims": [],
    "taskModes": [
      "standard",
      "ask",
      "planning",
      "skill_test"
    ],
    "sideEffectClass": "read",
    "idempotency": "none",
    "disabledByDefault": false,
    "realBindingStatus": "live_codex",
    "realServiceBinding": "unbound",
    "prpEvidence": "read projection surfaced via a tool-result item event; no control-plane state diff",
    "prpBindingStatus": "audit_pending",
    "legacyAliases": []
  },
  "documentation": {
    "title": "List document revisions",
    "description": "Read revision bodies in pages for one active-task document. Default 5; use limit=1 for large bodies. Follow pagination.nextBeforeRevisionNumber until hasMore=false.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "list_document_revisions",
      "input": {
        "key": "example"
      }
    },
    "success": {
      "ok": true,
      "operationId": "list_document_revisions",
      "result": {}
    }
  },
  "live": {
    "order": 4,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "list_document_revisions",
      "version": 1,
      "title": "List document revisions",
      "description": "Read revision bodies in pages for one active-task document. Default 5; use limit=1 for large bodies. Follow pagination.nextBeforeRevisionNumber until hasMore=false.",
      "exposure": "always",
      "requiredClaims": [],
      "allowedModes": [
        "standard",
        "ask",
        "planning",
        "skill_test"
      ],
      "inputSchema": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string",
            "description": "Stable issue-document key.",
            "minLength": 1,
            "maxLength": 120
          },
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 200,
            "default": 5
          },
          "beforeRevisionNumber": {"type":"integer","minimum":1,"description":"Read revisions older than this exclusive revision number. Use pagination.nextBeforeRevisionNumber from the previous page."}
        },
        "required": [
          "key"
        ],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "additionalProperties": true
      }
    }
  },
  "scenario": {
    "order": 4,
    "successExample": {
      "schema": "paperclip.capability.tool-result.v1",
      "ok": true,
      "operationId": "list_document_revisions",
      "operationResultId": "example-result",
      "value": {},
      "commandResult": null,
      "authorization": {}
    },
    "descriptor": {
      "operationId": "list_document_revisions",
      "version": 1,
      "title": "List document revisions",
      "description": "Read revision bodies in pages. Default 5; use limit=1 for large bodies. Follow pagination.nextBeforeRevisionNumber until hasMore=false.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string",
            "minLength": 1
          },
          "limit": {"type":"integer","minimum":1,"maximum":200,"default":5},
          "beforeRevisionNumber": {"type":"integer","minimum":1,"description":"Read revisions older than this exclusive revision number. Use pagination.nextBeforeRevisionNumber from the previous page."}
        },
        "required": [
          "key"
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
        "ask",
        "planning",
        "skill_test"
      ],
      "sideEffectClass": "read",
      "idempotency": "none",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "snapshot_read",
        "projection": "active_task_document_revisions"
      }
    }
  }
} as const;
