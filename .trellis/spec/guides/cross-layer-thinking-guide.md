# Cross-Layer Thinking Guide

> **Purpose**: Think through data flow across layers before implementing.

---

## The Problem

**Most bugs happen at layer boundaries**, not within layers.

Common cross-layer bugs:
- API returns format A, frontend expects format B
- Database stores X, service transforms to Y, but loses data
- Multiple layers implement the same logic differently

---

## Before Implementing Cross-Layer Features

### Step 1: Map the Data Flow

Draw out how data moves:

```
Source → Transform → Store → Retrieve → Transform → Display
```

For each arrow, ask:
- What format is the data in?
- What could go wrong?
- Who is responsible for validation?

### Step 2: Identify Boundaries

| Boundary | Common Issues |
|----------|---------------|
| API ↔ Service | Type mismatches, missing fields |
| Service ↔ Database | Format conversions, null handling |
| Backend ↔ Frontend | Serialization, date formats |
| Component ↔ Component | Props shape changes |

### Step 3: Define Contracts

For each boundary:
- What is the exact input format?
- What is the exact output format?
- What errors can occur?

---

## Common Cross-Layer Mistakes

### Mistake 1: Implicit Format Assumptions

**Bad**: Assuming date format without checking

**Good**: Explicit format conversion at boundaries

### Mistake 2: Scattered Validation

**Bad**: Validating the same thing in multiple layers

**Good**: Validate once at the entry point

### Mistake 3: Leaky Abstractions

**Bad**: Component knows about database schema

**Good**: Each layer only knows its neighbors

### Mistake 4: Dual-Source Form State

**Bad**: A form has both:
- visual controls (checkbox / radio / derived UI state)
- raw JSON / text config

but the submit path silently replays the JSON -> form mapping right before save.

This overwrites the user's latest UI-only selections with stale serialized state.

**Good**:
- define which layer is the source of truth at submit time
- if JSON and form both exist, only run JSON -> form backfill on an explicit user action
- never do implicit backfill inside `collect*()` / submit helpers unless every state dimension is serialized

### Mistake 5: WebSocket Payload-Type Drift

**Bad**:
- backend proxy receives a gateway text frame as `Buffer`
- proxy forwards the raw value without normalizing
- browser receives `Blob` / `ArrayBuffer`
- frontend still does `JSON.parse(event.data)` and silently drops the frame

This often looks like:
- socket `open` succeeded
- but app-level handshake times out because `hello-ok` was never parsed

**Good**:
- document payload type at each hop: upstream ws library -> proxy -> browser ws API
- normalize text frames to UTF-8 strings before forwarding across runtime boundaries
- browser frame parser must explicitly handle `string`, `Blob`, `ArrayBuffer`, and typed array views

### Mistake 6: Assuming Close Codes Can Be Round-Tripped

**Bad**:
- receive browser/upstream close code like `1005` / `1006` / `1015`
- pass it directly into another `ws.close(code, reason)`
- proxy crashes because the runtime refuses invalid outgoing close codes

**Good**:
- treat received close codes and emitted close codes as different contracts
- normalize to a legal outgoing code at the proxy boundary
- document which codes are preserved and which fall back to `1000` / `1011`

---

## Checklist for Cross-Layer Features

Before implementation:
- [ ] Mapped the complete data flow
- [ ] Identified all layer boundaries
- [ ] Defined format at each boundary
- [ ] Decided where validation happens
- [ ] If the UI has both structured form fields and raw JSON, defined the single source of truth for submit
- [ ] If the feature uses WebSocket across different runtimes/libraries, verified payload types at every hop
- [ ] If the feature forwards WebSocket close events, verified outgoing close codes are legal for the destination runtime

After implementation:
- [ ] Tested with edge cases (null, empty, invalid)
- [ ] Verified error handling at each boundary
- [ ] Checked data survives round-trip
- [ ] Checked that save-time normalization does not overwrite newer UI state with older serialized state
- [ ] Verified handshake frames are observable at the final consumer, not just at the transport source
- [ ] Verified boundary adapters do not silently coerce text/binary frames into a different runtime type

---

## When to Create Flow Documentation

Create detailed flow docs when:
- Feature spans 3+ layers
- Multiple teams are involved
- Data format is complex
- Feature has caused bugs before
