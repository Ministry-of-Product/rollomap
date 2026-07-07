# The RolloMap Philosophy

RolloMap is a **local-first relationship intelligence system**. It helps you
remember and nurture the people in your network — and it does that without
taking your data away from you.

This document explains *why* RolloMap is built the way it is. The short version:
**your relationships are yours, so the data about them should be too.**

## The problem

Our relationships are among the most valuable things we have, yet the memory of
them is scattered and lossy. Who introduced you to whom. What someone was
working on last time you spoke. The promise you made to send a link and forgot.
The person you should introduce to a friend but can't quite recall.

The tools that promise to help — CRMs, "relationship intelligence" platforms,
networking apps — almost always solve this by uploading your contacts, your
inbox, and your calendar to *their* servers, mining it, and monetizing it. You
get a feature; they get your social graph. When you leave, your history stays
with them.

## Our principles

### 1. Local-first, and you own your data

RolloMap runs on **your** machine against **your** database. The graph of your
relationships lives on disk that you control. There is no requirement to send
your data to anyone to get value out of the product. Cloud sync exists so you
can replicate *your own* data across *your own* devices — it is opt-in and
under your control, not a condition of using the tool.

### 2. Private by default

The default posture is privacy, not sharing. RolloMap does not aggregate data
across users, and it does not build a shadow profile of the people in your
network for anyone but you. What you choose to share is an explicit action, not
a default.

### 3. Evidence-backed, not hallucinated

Every claim in RolloMap links back to a source — the note, message, or import
it came from. A relationship tool that makes things up is worse than useless.
You should always be able to ask "how do you know that?" and get an answer.

### 4. Open and inspectable

RolloMap is open source under the Apache 2.0 license. You can read exactly what
it does with your data, run it yourself, fork it, and extend it. Trust in a tool
that holds this kind of data should come from being able to verify it, not from
a privacy policy.

### 5. Interoperable, agent-friendly

RolloMap exposes its data through a plain REST API and a Model Context Protocol
(MCP) server, so your own AI agents and scripts can work with your graph. Your
data isn't locked behind a proprietary UI — it's yours to query and build on.

## What this means in practice

- The default setup is a Postgres database and a few services on `localhost`.
  Nothing leaves your machine unless you configure it to.
- Importing data is manual or file-based in v1 — no silent background
  harvesting of your accounts.
- Personal data never belongs in the source repository. Local personalization
  seeds are gitignored by design.
- Features are judged against these principles. If a feature would only work by
  taking custody of the user's data or eroding their privacy, that's a strong
  signal it doesn't belong in RolloMap — or needs to be redesigned so the user
  stays in control.

## Where we're headed

RolloMap's v1 is deliberately small and local. Over time we want richer ingest
(with your consent, for your eyes), better entity resolution, and smarter recall
— all while keeping the same promise: **the map of your relationships belongs to
you.**

If that vision resonates, we'd love your help. See
[CONTRIBUTING.md](../CONTRIBUTING.md).
