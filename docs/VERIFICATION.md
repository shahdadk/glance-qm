# Live verification receipt

Run `node scripts/verify-live.mjs` against an already running configured backend. This creates synthetic QA provider data.

```json
{
  "verifiedAt": "2026-09-27T21:31:13.321Z",
  "mode": "live synthetic QA",
  "meetingId": "cc843140-643d-427d-8556-67d0b7939bb4",
  "elapsedMs": 61296,
  "passed": 14,
  "total": 14,
  "checks": [
    {
      "name": "live provider configuration",
      "pass": true,
      "elapsedMs": 18,
      "providers": {
        "qm": "configured",
        "gbrain": "configured",
        "memorable": "configured"
      }
    },
    {
      "name": "missing authentication rejected",
      "pass": true,
      "elapsedMs": 27
    },
    {
      "name": "meeting created",
      "pass": true,
      "elapsedMs": 37,
      "meetingId": "cc843140-643d-427d-8556-67d0b7939bb4"
    },
    {
      "name": "single operator boundary disclosed",
      "pass": true,
      "elapsedMs": 37
    },
    {
      "name": "participant impersonation rejected",
      "pass": true,
      "elapsedMs": 39
    },
    {
      "name": "ambient judgment completed",
      "pass": true,
      "elapsedMs": 6088,
      "recalled": true,
      "memoryEvidenceCount": 0,
      "cuePresent": false,
      "warningCodes": [
        "single_operator"
      ]
    },
    {
      "name": "GBrain recall returned",
      "pass": true,
      "elapsedMs": 6088,
      "evidenceCount": 0
    },
    {
      "name": "correction increments epoch with cue cleared",
      "pass": true,
      "elapsedMs": 6099
    },
    {
      "name": "grounded cue visible",
      "pass": true,
      "elapsedMs": 11121,
      "evidenceCount": 2
    },
    {
      "name": "calendar preview prepared without sending",
      "pass": true,
      "elapsedMs": 23165,
      "status": "proposed"
    },
    {
      "name": "calendar confirmation without authentication rejected",
      "pass": true,
      "elapsedMs": 23166
    },
    {
      "name": "end summary persisted",
      "pass": true,
      "elapsedMs": 61296,
      "state": "completed",
      "summaryPresent": true
    },
    {
      "name": "document completed",
      "pass": true,
      "elapsedMs": 61296,
      "taskStatuses": [
        "completed"
      ]
    },
    {
      "name": "calendar not sent",
      "pass": true,
      "elapsedMs": 61296,
      "status": "cancelled"
    }
  ],
  "receipts": [
    {
      "provider": "GBrain",
      "id": "56ff81c1-67ba-445c-8968-cd5a878b1114"
    },
    {
      "provider": "QM document",
      "id": "c6006556-12d3-440d-bf7b-b317048c5309"
    }
  ],
  "limits": [
    "Local app authenticates one operator; no two-principal app verification.",
    "No Meta hardware verification.",
    "No calendar invite sent or authenticated confirmation attempted.",
    "Recall may return no memory; no private source content included."
  ]
}
```
