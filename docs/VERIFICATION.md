# Live verification receipt

Run `node scripts/verify-live.mjs` against an already running configured backend. This creates synthetic QA provider data.

```json
{
  "verifiedAt": "2026-09-27T21:59:13.278Z",
  "mode": "live synthetic QA",
  "meetingId": "cf4a0907-d565-4f68-b13a-d4086807ea40",
  "elapsedMs": 44261,
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
      "elapsedMs": 26
    },
    {
      "name": "meeting created",
      "pass": true,
      "elapsedMs": 40,
      "meetingId": "cf4a0907-d565-4f68-b13a-d4086807ea40"
    },
    {
      "name": "single operator boundary disclosed",
      "pass": true,
      "elapsedMs": 40
    },
    {
      "name": "participant impersonation rejected",
      "pass": true,
      "elapsedMs": 42
    },
    {
      "name": "ambient judgment completed",
      "pass": true,
      "elapsedMs": 4082,
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
      "elapsedMs": 4082,
      "evidenceCount": 0
    },
    {
      "name": "correction increments epoch with cue cleared",
      "pass": true,
      "elapsedMs": 4093
    },
    {
      "name": "grounded cue visible",
      "pass": true,
      "elapsedMs": 12134,
      "evidenceCount": 2
    },
    {
      "name": "calendar preview prepared without sending",
      "pass": true,
      "elapsedMs": 23178,
      "status": "proposed"
    },
    {
      "name": "calendar confirmation without authentication rejected",
      "pass": true,
      "elapsedMs": 23181
    },
    {
      "name": "end summary persisted",
      "pass": true,
      "elapsedMs": 44261,
      "state": "completed",
      "summaryPresent": true
    },
    {
      "name": "document completed",
      "pass": true,
      "elapsedMs": 44261,
      "taskStatuses": [
        "completed"
      ]
    },
    {
      "name": "calendar not sent",
      "pass": true,
      "elapsedMs": 44261,
      "status": "cancelled"
    }
  ],
  "receipts": [
    {
      "provider": "GBrain",
      "id": "088876ce-053e-4f8a-96c4-dce0beb42673"
    },
    {
      "provider": "QM document",
      "id": "368692d1-e967-4bb2-910b-d780013929c3"
    }
  ],
  "limits": [
    "Local app authenticates one operator; no two-principal app verification.",
    "Physical Meta Speech transport produced 21 nonempty final results and backend HTTP 200 receipts; sustained background capture and full Display rehearsal remain unverified.",
    "No calendar invite sent or authenticated confirmation attempted.",
    "Recall may return no memory; no private source content included."
  ]
}
```
